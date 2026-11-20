// app/lib/customer-image-link.ts — お客様が送った画像を「何の画像か・どの物件か・こちらが送った物とどう関わるか・何を聞いているか」に結び付け、
//   ブレインの材料の1ブロックにする（純関数・DB も LLM も使わない）。読み込みは brain-core（CUSTOMER_IMAGE_LINK=on の時だけ）。
//
// 2026-11-15 作業員H（竹内さん 11/15「お客さんが送ってきたのが物件や見積書と分かれば…さらに質上がる」「結び付けの部分も具体的に細かくして、
//   会話の流れをちゃんと理解して AIX や返信ができるように」「相手が送ったのとこっちが送っているのの関連性も」）
//
// 【材料の元】受け取った時の書き起こし（line-webhook → id-document-guard.imageTextForSave / image-label の見出し）だけを読む。画像は外に出さない。
//   書類（本人確認書類・収入証明書・契約書）は種類だけ（中身は保存されていない）＝ここでも種類だけ。見積書は名前を伏せてから数字だけ取る。
//   書き起こしの全文はブレインに渡さない（取った値と短い一言だけ）。
// 【決めるのはブレイン】ここは候補の網と事実の並びだけ（P0 9eb6aa9c）。行き先は竹内さんの決まり（KB の id）を「材料」として添える。決まりの無い型は「決まっていない」と書く。
// 2026-11-20 から既定 on（CUSTOMER_IMAGE_LINK=off で止める）。

import { savedImageKind, imageKindGroup, stripImageLabel, maskEstimateAddressee, IMAGE_KIND_LABEL, type ImageKind } from "./image-label";
import { factsFromPropertyText, type CustomerSentFacts } from "./customer-sent-property";
import { extractScreenshotProperty, matchOwnProperty, normalizeRoom, type SentProperty } from "./own-property-match";
import { savedPersonalDocumentLabel } from "./personal-document-guard";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export function customerImageLinkOn(env: Env = envOf()): boolean {
  // 2026-11-20 作業員K2（統括役の決め）: 既定 on（試験 k1119-imgroute-a・ROUTE_1115 と一緒に on・9問×2回で確かな悪化0・本質 3/16→5/16）。止める CUSTOMER_IMAGE_LINK=off
  return (env.CUSTOMER_IMAGE_LINK ?? "").trim().toLowerCase() !== "off";
}

// ── 種類 ─────────────────────────────────────────────────────────
export type LinkKind = "property_screen" | "property_material" | "property_ad" | "property_photo" | "estimate_own" | "estimate_other" | "document" | "non_property" | "unknown";
export const LINK_KIND_LABEL: Readonly<Record<LinkKind, string>> = {
  property_screen: "物件の画面（ポータル）", property_material: "物件の資料", property_ad: "物件の画面（SNS・広告）", property_photo: "物件の写真",
  estimate_own: "見積書（弊社）", estimate_other: "見積書（他社）", document: "書類（種類だけ・中身は保存していない）", non_property: "物件以外", unknown: "種類不明",
};
/** 画像のどの部分か（③）: 外観・室内・間取り図・募集の画面・費用 */
export type ImagePart = "exterior" | "interior" | "floor_plan" | "listing" | "cost" | null;
const PART_LABEL: Record<Exclude<ImagePart, null>, string> = { exterior: "外観", interior: "室内", floor_plan: "間取り図", listing: "募集の画面・資料", cost: "費用" };

// ── 見積書（④）──────────────────────────────────────────────────
/** 弊社（蓮産業・スモラ・イエヤス・ギガ賃貸）の見積書か。書き起こしの読み違い（連度業・蓮 産業）も拾う */
const OWN_COMPANY_RE = /[蓮連]\s*[産度]\s*業|スモラ|イエヤス|ギガ賃貸/;
const ESTIMATE_DOC_RE = /見積|御請求|請求金額|初期費用|合計|総額/;
export type EstimateItems = Partial<Record<"deposit" | "key_money" | "brokerage" | "guarantee" | "key_change" | "insurance" | "prorated" | "advance_rent" | "rent" | "admin" | "total", number>>;
const ITEM_RES: Array<[keyof EstimateItems, RegExp]> = [
  ["total", /(?:御?請求金額|御購求金額|合計(?:金額)?|総額|初期費用(?:合計|総額)?)\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)/],
  ["deposit", /(?:敷\s*金|保証金)\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*|[-ー－なし無し]+)/],
  ["key_money", /(?:[礼札]\s*金)\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*|[-ー－なし無し]+)/],
  ["brokerage", /仲介手数料\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)/],
  ["guarantee", /(?:保証会社(?:代|料)?|保証(?:委託)?料)\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)/],
  ["key_change", /鍵\s*交換(?:代|費用?)?\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)/],
  ["insurance", /(?:火災|損害|家財)保険(?:料|代)?\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)/],
  ["prorated", /日割(?:り)?(?:家賃|賃料)?\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)/],
  ["advance_rent", /(?:前家賃|翌月分?(?:家賃|賃料)|[0-9]{1,2}\s*月分\s*(?:家賃|賃料))\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)/],
  ["rent", /(?<![前割月分])(?:家賃|賃料)\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)/],
  ["admin", /(?:共益費|管理費)\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)/],
];
/**
 * 2026-11-21 作業員G（画像の把握の表 C5-b）: 他社の見積書の書き起こしが表の形（「敷金 | 0円」「家賃保証(2年)| 17,080円」「初期費用詳細合計額: 135,780円」）で、
 *   見出しと値の間の「|」と、言い方の違う見出し（仲介会社関連費用・家賃保証・〜合計額）で内訳が取れていなかった（60日の【見積書】10枚のうち 1枚）。
 *   既定 off（ESTIMATE_TABLE_PARSE=on）。取れなかった時だけ足す形で読む（今取れている行は変わらない）。
 */
export function estimateTableParseOn(env: Env = envOf()): boolean {
  return (env.ESTIMATE_TABLE_PARSE ?? "").trim().toLowerCase() === "on";
}
const TABLE_EXTRA: Partial<Record<keyof EstimateItems, string>> = {
  total: "(?:初期費用)?(?:詳細)?合計額",
  brokerage: "仲介(?:会社関連)?(?:手数料|費用)",
  guarantee: "家賃保証(?:\\([^)]{0,8}\\))?",
};
function tableItemRe(k: keyof EstimateItems, re: RegExp): RegExp {
  // 元の見出し（キャプチャの前まで）＋言い方の違う見出し、区切りに「|」も許す
  const head = re.source.replace(/\\s\*\[:：\]\?\\s\*\[¥￥\]\?\\s\*\(.*$/, "");
  const alt = TABLE_EXTRA[k];
  return new RegExp(`(?:${head}${alt ? `|${alt}` : ""})\\s*[:：|｜]\\s*[¥￥]?\\s*([0-9][0-9,]*|[-ー－なし無し]+)`);
}
export const ESTIMATE_ITEM_LABEL: Record<keyof EstimateItems, string> = { deposit: "敷金", key_money: "礼金", brokerage: "仲介手数料", guarantee: "保証会社", key_change: "鍵交換", insurance: "火災保険", prorated: "日割家賃", advance_rent: "前家賃", rent: "家賃", admin: "管理費", total: "総額" };
/** 宛名・人の名前を伏せる（「〇〇 様」・「様」だけの行の前の行の頭の語）。数字だけ取る前に必ず通す */
export const maskEstimateNames = maskEstimateAddressee;
export type EstimateFacts = { company: "own" | "other"; companyName: string | null; propertyName: string | null; room: string | null; items: EstimateItems };
/** 見積書の書き起こし（見出しを外した物）→ 会社と内訳。見積書と言えない（見積の語が無い・金額が2つ未満）物は null */
export function estimateFactsFromTranscript(raw: string): EstimateFacts | null {
  const t = maskEstimateNames(String(raw ?? "").normalize("NFKC"));
  if (!ESTIMATE_DOC_RE.test(t)) return null;
  const items: EstimateItems = {};
  const tableOn = estimateTableParseOn();
  for (const [k, re] of ITEM_RES) {
    const m = t.match(re) ?? (tableOn ? t.match(tableItemRe(k, re)) : null);
    if (!m) continue;
    const v = /^[-ー－なし無し]+$/.test(m[1]) ? 0 : Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(v) && v >= 0 && v <= 3_000_000) items[k] = v;
  }
  // 総額は3万円以上だけ（号室の一覧の資料の「合計 2」等を見積の総額にしない）・家賃と管理費の他に費用の項目が2つ以上ある物だけ見積書と読む
  if (items.total != null && items.total < 30_000) delete items.total;
  if ((Object.keys(items) as Array<keyof EstimateItems>).filter((k) => k !== "rent" && k !== "admin").length < 2) return null;
  const own = OWN_COMPANY_RE.test(t);
  // 他社の名前は会社の語の付く物だけ（人の名前は取らない）
  const co = own ? null : (t.match(/([\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]{2,16}(?:株式会社|不動産|ハウス|エステート|リビング|住宅))|((?:株式会社)[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]{2,16})/u) ?? [])[0] ?? null;
  const pn = t.match(/物件名\s*[:：]?\s*([^\n/]{2,30}?)(?:\s+([0-9]{2,4})\s*号室?)?\s*(?:\n|$|\/)/);
  return { company: own ? "own" : "other", companyName: own ? "弊社" : co, propertyName: pn ? pn[1].trim() : null, room: pn?.[2] ? normalizeRoom(pn[2]) : null, items };
}

// ── お客様の一言の向き（何を聞いているか）────────────────────────────
export type Ask = "vacancy" | "cost" | "viewing" | "like" | "compare" | "question";
export const ASK_LABEL: Record<Ask, string> = { vacancy: "空き", cost: "費用", viewing: "内覧", like: "好み・気に入った", compare: "比べ", question: "その他の質問" };
export function asksOf(words: string): Ask[] {
  const t = String(words ?? "").normalize("NFKC");
  const out: Ask[] = [];
  if (/空いて|空き|空室|募集(?:中|して)|まだ(?:あり|あるか|ある)|残って|取り扱い|お取扱|あります(?:か|でしょうか)|ありますか|申し?込め/.test(t)) out.push("vacancy");
  if (/初期費用|費用|いくら|見積|お見積|安く|割引|頑張|値段|金額/.test(t)) out.push("cost");
  if (/内覧|内見|見学|見に行|見たい/.test(t)) out.push("viewing");
  if (/比べ|どっち|どちら|違い|他社|より安|こっちの方|相見積/.test(t)) out.push("compare");
  if (/(?:いい|良い|好き|気にな|気に入|住みたい|素敵|最高|めっちゃ)/.test(t)) out.push("like");
  if (!out.length && /[?？]|ですか|ますか|でしょうか/.test(t)) out.push("question");
  return out;
}

// ── 結び付け ─────────────────────────────────────────────────────
export type SentForLink = { name: string; room: string | null; sentAt: string | null; rent?: number | null; bundleNo?: number | null; bundlePos?: number | null; checkedAt?: string | null; /** 退去予定の部屋（送った資料の現況・まだ内覧できない） */ vacating?: boolean };
export type Relation = "reaction_to_ours" | "ours_on_other_site" | "similar_other" | "new_brought" | "unknown";
export const RELATION_LABEL: Record<Relation, string> = {
  reaction_to_ours: "こちらが送った物件への反応", ours_on_other_site: "こちらが送った物件の他社・ポータルの画面", similar_other: "似た別の物件（好みの手本の候補）",
  new_brought: "関係の無い新しい持ち込みの物件", unknown: "関連が分からない",
};
export type Certainty = "high" | "mid" | "low";
export type ImageLink = {
  at: string; kind: LinkKind; label: string; part: ImagePart;
  property: (Pick<CustomerSentFacts, "rentYen" | "adminYen" | "madori" | "areaSqm" | "station" | "walk" | "ageYears"> & { name: string | null; room: string | null; certainty: Certainty }) | null;
  /** ①② こちらが送った物件との照合 */
  ours: { name: string; room: string | null; sentAt: string | null; bundleNo: number | null; bundlePos: number | null; by: "same_room" | "same_building" | "rent_layout"; certainty: Certainty } | null;
  relation: Relation;
  /** 募集状況が手元にあるか（送った物件＝送った時に確認済み・確認の結果を送った物件） */
  vacancyOnHand: "sent_confirmed" | "checked" | null;
  estimate: EstimateFacts | null;
  asks: Ask[]; words: string | null;
  /** 連投の束の中の順（1始まり）と枚数 */
  burst: { index: number; size: number };
  /** 決まりに沿った行き先の材料（無ければ「決まっていない」） */
  route: { text: string; kb: string | null };
  /** 物件が確かに引けない（人に回す段 ref_unresolved の候補） */
  needsStaff: boolean;
  /** 好みの手本の画像から取った特徴（関連が似た別の物件の時だけ） */
  taste?: TasteFeature[];
};

const PROPERTY_KINDS: ReadonlySet<ImageKind> = new Set<ImageKind>(["property_material", "property_screen", "property_ad", "property_photo"]);
function partOf(kind: LinkKind, body: string): ImagePart {
  if (kind === "estimate_own" || kind === "estimate_other") return "cost";
  if (kind === "property_screen" || kind === "property_ad") return "listing";
  if (kind === "property_material") return /間取り?図|間取り/.test(body) && !/賃料|家賃/.test(body) ? "floor_plan" : "listing";
  if (kind === "property_photo") return /外観|建物の外|エントランス|外壁/.test(body) ? "exterior" : /室内|リビング|キッチン|洋室|浴室|洗面|トイレ|収納/.test(body) ? "interior" : null;
  return null;
}

export type LinkInput = {
  text: string; imageType?: string | null; at: string;
  /** 画像の後のお客様の一言（20分以内・同じ連投の文） */
  customerWords?: string | null;
  sent: ReadonlyArray<SentForLink>;
  burst?: { index: number; size: number };
};

/** 1枚の画像 → 結び付け */
export function linkCustomerImage(i: LinkInput): ImageLink {
  const raw = String(i.text ?? "");
  const words = (i.customerWords ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || null;
  const asks = asksOf(words ?? "");
  const burst = i.burst ?? { index: 1, size: 1 };
  const base = { at: i.at, part: null as ImagePart, property: null, ours: null, relation: "unknown" as Relation, vacancyOnHand: null, estimate: null, asks, words, burst, needsStaff: false, taste: [] as TasteFeature[] };
  // 書類（種類だけ）
  if (savedPersonalDocumentLabel(raw) || /^\s*\[画像\]\s*本人確認書類\s*$/.test(raw) || /^(?:id_document|income_document)$/.test(String(i.imageType ?? ""))) {
    return { ...base, kind: "document", label: LINK_KIND_LABEL.document, route: { text: "書類は申込の手続きの番（ここでは中身を読まない）", kb: null } };
  }
  const k = savedImageKind(raw);
  const body = stripImageLabel(raw.replace(/^\s*\[画像\]\s*/, ""));
  if (k === "estimate") {
    const est = estimateFactsFromTranscript(body);
    if (est) {
      const kind: LinkKind = est.company === "own" ? "estimate_own" : "estimate_other";
      const vacating = kind === "estimate_own" && !!est.propertyName && i.sent.some((s) => !!s.vacating && sameName(s.name, est.propertyName ?? ""));
      const route = kind === "estimate_other"
        ? { text: "他社の見積書＝相見積もり。物件確認した ではなく、比べて最大限割引した御見積書（他社より抑えた見積）の約束と申込への背中押し", kb: "87ff68e1・1c4dddf7" }
        : ownEstimateRoute(asks, !!words, vacating);
      return { ...base, kind, label: LINK_KIND_LABEL[kind], part: "cost", estimate: est, route };
    }
    // 見積と言えない（号室の一覧の資料を Vision が見積と分けた等）は物件の資料として読む
  }
  if (!k || (!PROPERTY_KINDS.has(k) && k !== "estimate")) {
    const g = k ? imageKindGroup(k) : "unknown";
    const kind: LinkKind = g === "non_property" ? "non_property" : "unknown";
    return { ...base, kind, label: k ? IMAGE_KIND_LABEL[k] : LINK_KIND_LABEL.unknown, route: { text: kind === "non_property" ? "物件以外の画像（物件の確認・見積の理由にしない）" : "何の画像か分からない（推測で物件と言わない）", kb: null } };
  }
  const kind: LinkKind = k === "estimate" ? "property_material" : (k as LinkKind);
  const facts = factsFromPropertyText(body);
  const sp = extractScreenshotProperty(raw);
  const name = sp?.name ?? facts.name ?? null;
  const room = sp?.room ?? null;
  const hasValues = facts.rentYen != null || !!facts.madori || facts.areaSqm != null;
  const certainty: Certainty = name && room ? "high" : name || (hasValues && facts.station) ? "mid" : "low";
  const property = (name || hasValues) ? { name, room, rentYen: facts.rentYen, adminYen: facts.adminYen, madori: facts.madori, areaSqm: facts.areaSqm, station: facts.station, walk: facts.walk, ageYears: facts.ageYears, certainty } : null;
  // ①② こちらが送った物件との照合（お客様が送るより前にこちらが送った物だけ）
  const before = i.sent.filter((s) => !s.sentAt || s.sentAt < i.at);
  let ours: ImageLink["ours"] = null;
  if (name) {
    const m = matchOwnProperty({ name, room }, before.map((s): SentProperty => ({ name: s.name, room: s.room, sentAt: s.sentAt })));
    if (m.kind !== "none" && m.sent) {
      const hit = before.find((s) => s.name === m.sent!.name && (s.room ?? null) === (m.sent!.room ?? null)) ?? before.find((s) => s.name === m.sent!.name);
      ours = { name: m.sent.name, room: m.sent.room, sentAt: m.sent.sentAt, bundleNo: hit?.bundleNo ?? null, bundlePos: hit?.bundlePos ?? null, by: m.kind, certainty: m.kind === "same_room" ? "high" : "mid" };
    }
  }
  // 名前が取れない時に家賃だけで送った物件と照らすのはやめた（14日の監査で別の物件に当たった・84b560f4 11/02）
  // ④ 関連の型
  let relation: Relation;
  // 2026-11-15 竹内さんの決定（KB 1d2400c6・H-14 ①）: こちらが送った物件と同じマンションの他社・ポータルの画面は決め打ちしない＝関連は「他社の画面」、行き先は後の一言で決める
  if (ours && ours.certainty !== "low") relation = kind === "property_screen" || kind === "property_ad" ? (imageRoute1115On() || asks.includes("compare") || asks.includes("cost") ? "ours_on_other_site" : "reaction_to_ours") : "reaction_to_ours";
  else if (!property) relation = "unknown";
  // 似た別の物件（好みの手本）は「こういう・こんな・みたいな」と手本として見せる言い方の時だけ（気に入った＋空きを聞くは持ち込み）
  else if (/こういう|こんな|みたいな|ような(?:お?部屋|物件|感じ)|イメージ/.test(words ?? "") && !asks.includes("vacancy") && !asks.includes("viewing")) relation = "similar_other";
  else relation = "new_brought";
  const vacancyOnHand: ImageLink["vacancyOnHand"] = ours && ours.certainty === "high" ? (i.sent.find((s) => s.name === ours!.name && s.checkedAt)?.checkedAt ? "checked" : "sent_confirmed") : null;
  const needsStaff = relation !== "reaction_to_ours" && relation !== "ours_on_other_site" && (!property || certainty === "low");
  const taste = relation === "similar_other" ? tasteFeaturesFromTranscript(body) : [];
  return { ...base, kind, label: LINK_KIND_LABEL[kind], part: partOf(kind, body), property, ours, relation, vacancyOnHand, needsStaff, taste, route: routeFor(relation, asks, vacancyOnHand, !!words) };
}

/** 型ごとのブレインの判断への行き先（竹内さんの決まり・KB の id）。決まりの無い型は「決まっていない」 */
export function routeFor(rel: Relation, asks: ReadonlyArray<Ask>, vacancyOnHand: ImageLink["vacancyOnHand"], hasWords = asks.length > 0): { text: string; kb: string | null } {
  if (rel === "reaction_to_ours" || rel === "ours_on_other_site") {
    if (rel === "ours_on_other_site") return otherSiteRoute(asks, hasWords);
    // 45日の実送信（scripts/audit-customer-images.ts --link）: 送った物件の資料の送り返しは、竹内さん・スタッフとも約束を挟まず AIX を直接
    //   （内覧→内覧調整 2・費用→見積書送る 3・質問→物件確認した／見積書送る）
    if (asks.includes("viewing")) return { text: "こちらが送った物件で内覧の話＝ AIX【内覧調整】（送った物件は確認済み・約束を挟まない）", kb: "932e73a9・memory feedback_viewing_request_aix" };
    if (asks.includes("vacancy")) return { text: "こちらが送った物件＝送った時に募集中を確認済み。「募集状況を確認します」と書かない（空きを改めて聞かれた時の扱いは会話から決める）", kb: "932e73a9" };
    if (asks.includes("cost")) return { text: "こちらが送った物件の費用の話＝その物件の最大限割引した御見積書を AIX【見積書送る】で直接（物件名を挙げて・約束を挟まない）", kb: "932e73a9・359c8c60" };
    return { text: "こちらが送った物件への反応＝その物件の答え（返信）。見てくれた事への感謝から", kb: "deaa7f9b・c3cd087e" };
  }
  if (rel === "new_brought") {
    if (vacancyOnHand) return { text: "持ち込みの物件で確認の結果が手元にある＝ AIX【物件確認した】", kb: "acda2b5c" };
    if (!asks.length && hasWords) return { text: "持ち込みの物件（一言から何を聞いているかは会話で読む）。基本は募集状況の確認と最大限割引した御見積書を送る旨の約束の返信（後で AIX【物件確認した】）", kb: "acda2b5c" };
    if (!asks.length) return { text: "画像だけで一言が無い持ち込み＝募集状況の確認と最大限割引した御見積書を送る旨の約束の返信（後で AIX【物件確認した】）。初回は挨拶＋約束", kb: "acda2b5c・844ff716" };
    if (asks.includes("cost") && !asks.includes("vacancy")) return { text: "持ち込みの物件の費用だけを聞いている＝最大限割引した御見積書の約束（後で AIX【見積書送る】）", kb: "844ff716" };
    return { text: "持ち込みの物件で空き・内覧を聞いている＝募集状況の確認と御見積書の約束（2段:check）", kb: "acda2b5c" };
  }
  if (rel === "similar_other") return imageRoute1115On()
    ? { text: "好みの手本の画像（こういうのが良い）＝画像の特徴を好み（できれば）として条件に足し、その条件でピックアップする約束の返信（2段:pickup）→ 後で物件の AIX。必須にはしない", kb: "1d2400c6" }
    : { text: "似た別の物件（こういうのが良い）＝好みの手本として条件を読み、近い物件を探す。行き先の竹内さんの決まりは設計知見に無い（決まっていない）", kb: null };
  return { text: "どの物件か確かでない＝物件名・号室を推測で書かない（スタッフが確かめる）", kb: null };
}

/** 今の連投の画像の結び付け（束の順を付ける） */
export function linkTurnImages(turn: ReadonlyArray<{ text: string | null; image_type?: string | null; created_at: string }>, sent: ReadonlyArray<SentForLink>): ImageLink[] {
  const imgs = turn.filter((m) => /^\s*\[画像\]/.test(m.text ?? ""));
  const words = turn.filter((m) => !/^\s*\[画像\]/.test(m.text ?? "")).map((m) => ({ text: m.text ?? "", at: Date.parse(m.created_at) }));
  return imgs.map((m, idx) => {
    const t = Date.parse(m.created_at);
    const near = words.filter((w) => Math.abs(w.at - t) <= 20 * 60_000).map((w) => w.text).join(" ");
    return linkCustomerImage({ text: m.text ?? "", imageType: m.image_type ?? null, at: m.created_at, customerWords: near, sent, burst: { index: idx + 1, size: imgs.length } });
  });
}

/** ⑤ こちらが送った画像（物件）の側: お客様の次の一言の中に出た物件名から、どれに反応したか */
export function reactedSentProperties(customerText: string, sent: ReadonlyArray<SentForLink>): SentForLink[] {
  const t = String(customerText ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (!t) return [];
  return sent.filter((s) => {
    const n = s.name.normalize("NFKC").replace(/\s+/g, "");
    const head = n.slice(0, Math.min(5, n.length));
    return n.length >= 3 && (t.includes(n) || (head.length >= 3 && t.includes(head)));
  });
}

const yen = (v: number | null | undefined) => (v == null ? null : v >= 10000 ? `${(v / 10000).toFixed(v % 1000 === 0 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")}万円` : `${v.toLocaleString()}円`);
/** ブレインの材料の1ブロック（無ければ空）。書き起こしの全文・人の名前は入れない */
export function buildImageLinkBlock(links: ReadonlyArray<ImageLink>): string {
  if (!links.length) return "";
  const lines = links.map((l) => {
    const head = `・${l.burst.size > 1 ? `${l.burst.index}/${l.burst.size}枚目` : "画像"}【${l.label}】${l.part ? `（${PART_LABEL[l.part]}）` : ""}`;
    const prop = l.property ? ` 物件: ${[l.property.name ?? "名前なし", l.property.room ? `${l.property.room}号室` : null, yen(l.property.rentYen), l.property.madori, l.property.areaSqm != null ? `${l.property.areaSqm}㎡` : null, l.property.station ? `${l.property.station}${l.property.walk != null ? `徒歩${l.property.walk}分` : ""}` : null].filter(Boolean).join(" ")}（確かさ ${l.property.certainty}）` : "";
    const ours = l.ours ? ` こちらが送った物件と照合: ${l.ours.name}${l.ours.room ? ` ${l.ours.room}` : ""}（${l.ours.bundleNo ? `${l.ours.bundleNo}回目の送信の${l.ours.bundlePos ?? "?"}件目・` : ""}${l.ours.by === "same_room" ? "同じ部屋" : l.ours.by === "same_building" ? "同じ建物・号室は不明" : "家賃だけ一致"}・確かさ ${l.ours.certainty}）` : "";
    const est = l.estimate ? ` 見積: ${l.estimate.companyName ?? "他社"}${l.estimate.propertyName ? `・${l.estimate.propertyName}` : ""} ${(Object.keys(l.estimate.items) as Array<keyof EstimateItems>).map((k) => `${ESTIMATE_ITEM_LABEL[k]}${yen(l.estimate!.items[k]) ?? ""}`).join("・")}` : "";
    const rel = l.kind.startsWith("property") ? ` 関連: ${RELATION_LABEL[l.relation]}${l.vacancyOnHand ? `・募集状況は手元にある（${l.vacancyOnHand === "checked" ? "確認の結果を送った" : "送った時に確認済み"}）` : ""}` : "";
    const ask = ` お客様が聞いている事: ${l.asks.length ? l.asks.map((a) => ASK_LABEL[a]).join("・") : l.words ? "（言葉の網に当たらない・一言から読む）" : "一言なし"}${l.words ? `「${l.words}」` : ""}`;
    const taste = l.taste?.length ? ` 画像の好み: ${l.taste.map((t) => t.label).join("・")}` : "";
    const route = `${taste} 決まりの材料: ${l.route.text}${l.route.kb ? `（KB ${l.route.kb}）` : ""}${l.needsStaff ? "。物件が確かに引けない＝スタッフに確かめてもらう" : ""}`;
    return `${head}${prop}${ours}${est}${rel}${ask}${route}`;
  });
  return `【お客様が送った画像の結び付け（受け取った時の読み取りから・決めるのはあなた）】\n${lines.join("\n")}\n※画像の前のこちらの通（約束・送った物件）と、画像の後のお客様の一言を1つの番として読む。決まりの材料は候補（会話の流れと違えば会話を優先）`;
}

// ─── 2026-11-15 竹内さんの決定（KB 1d2400c6・確認事項 H-14・既定 off: CUSTOMER_IMAGE_ROUTE_1115=on）────────────────
//   ① こちらが送った物件と同じマンションの他社の画面: 決め打ちしない。後に来るお客様の文（比べ・安さの確かめ・空き・内覧・何も無し）で行き先を分ける。後の一言がまだ無ければ待つ
//   ② 好みの手本の画像: 好みを条件に足して約束の返信 → 物件の AIX（特徴は image-taste-wants で AIX ツールの要望の欄へ）
//   ③ こちらの見積書の送り返し: 文も一緒に来る。質問があれば答える返信・無ければ内覧の誘い。その物件が退去予定なら申込に誘導（AIX【申込へ】）
export function imageRoute1115On(env: Env = envOf()): boolean {
  // 2026-11-20 作業員K2: 既定 on（k1119-imgroute-a で悪化0）。好みの手本を要望の欄に書くのは CUSTOMER_IMAGE_TASTE_WANTS=on の時だけ（既定 off のまま）。止める CUSTOMER_IMAGE_ROUTE_1115=off
  return (env.CUSTOMER_IMAGE_ROUTE_1115 ?? "").trim().toLowerCase() !== "off";
}
function sameName(a: string, b: string): boolean {
  const n = (x: string) => x.normalize("NFKC").replace(/\s+/g, "");
  const x = n(a), y = n(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}
export function otherSiteRoute(asks: ReadonlyArray<Ask>, hasWords: boolean): { text: string; kb: string | null } {
  if (!imageRoute1115On()) return { text: "こちらが送った物件を他社・ポータルの画面で見て送ってきた。値段の比べなら最大限割引の御見積書で応える。他社の画面の扱いの竹内さんの決まりは設計知見に無い（決まっていない）", kb: "932e73a9（送った物件は確認済み）" };
  const head = "こちらが送った物件と同じマンションの他社・ポータルの画面＝決め打ちしない・後の一言で決める（竹内さん 11/15）。";
  if (asks.includes("compare") || asks.includes("cost")) return { text: `${head}今の一言は比べ・安さの確かめ＝弊社で最大限割引した御見積書（同じ物件・物件名を挙げて）で応え、他社より抑えられる事を伝える`, kb: "1d2400c6・1c4dddf7" };
  if (asks.includes("viewing")) return { text: `${head}今の一言は内覧＝ AIX【内覧調整】（送った物件は確認済み）`, kb: "1d2400c6・932e73a9" };
  if (asks.includes("vacancy")) return { text: `${head}今の一言は空き＝送った時に募集中を確認済み（「募集状況を確認します」と書かない）`, kb: "1d2400c6・932e73a9" };
  if (hasWords) return { text: `${head}今の一言から何を聞いているかを会話で読んで決める`, kb: "1d2400c6" };
  return { text: `${head}後の一言がまだ無い＝待つ（連投の束の続きを待ってから決める・今は書かない）`, kb: "1d2400c6" };
}
export function ownEstimateRoute(asks: ReadonlyArray<Ask>, hasWords: boolean, vacating: boolean): { text: string; kb: string | null } {
  if (!imageRoute1115On()) return { text: "弊社の見積書の送り返し。何を聞いているか（総額・内訳・日割）に答える。どう扱うかの竹内さんの決まりは設計知見に無い（決まっていない）", kb: null };
  if (vacating) return { text: "弊社の見積書の送り返し・その物件は退去予定（まだ内覧できない）＝申込に誘導する（AIX【申込へ】・質問があればその答えも）", kb: "1d2400c6" };
  const q = asks.filter((a) => a !== "like");
  if (q.length) return { text: "弊社の見積書の送り返し＋質問＝聞かれた事（総額・内訳・日割 等）に答える返信", kb: "1d2400c6" };
  return { text: hasWords ? "弊社の見積書の送り返し（質問なし）＝内覧に誘う（誘い方は送った物件への反応と同じ）" : "弊社の見積書の送り返し・文がまだ無い＝基本は文も一緒に来るので連投の続きを待つ。来なければ内覧に誘う", kb: "1d2400c6" };
}

// ─── 好みの手本の画像の特徴（決定論・書き起こしから）────────────────────────
export type TasteFeature = { key: string; label: string; field: "preferences" | "other_requests" };
const TASTE_RULES: Array<{ key: string; label: string; field: TasteFeature["field"]; re: RegExp; has?: RegExp }> = [
  { key: "white", label: "白基調の内装", field: "other_requests", re: /白基調|ホワイト(?:基調|系|の内装)|白い(?:内装|お?部屋|床|壁)|白を基調/, has: /白基調|ホワイト|白い/ },
  { key: "wide_living", label: "広いリビング（10帖以上）", field: "other_requests", re: /(?:LDK|リビング)\s*[:：]?\s*(?:1[0-9]|[2-9][0-9])(?:\.\d)?\s*(?:帖|畳|J)|広々としたリビング|広いリビング/, has: /リビング.{0,6}(?:広|帖|畳)|広いリビング/ },
  { key: "new_build", label: "築浅", field: "other_requests", re: /新築|築浅|築\s*[1-5]\s*年/, has: /築浅|新築/ },
  { key: "pet", label: "ペット可", field: "preferences", re: /ペット(?:可|相談|OK|飼育可)/, has: /ペット/ },
  { key: "near_station", label: "駅近（徒歩5分以内）", field: "other_requests", re: /徒歩\s*[1-5]\s*分|駅近|駅チカ/, has: /駅近|駅チカ|徒歩\s*[1-5]\s*分/ },
  { key: "bath_toilet", label: "バストイレ別", field: "preferences", re: /バス・?トイレ別|バストイレ別|BT別/, has: /バス.?トイレ別|BT別/ },
  { key: "wash", label: "独立洗面台", field: "preferences", re: /独立洗面|洗面所独立|シャンプードレッサー/, has: /独立洗面|シャンプードレッサー/ },
  { key: "stove", label: "2口以上のコンロ", field: "preferences", re: /(?:2|3|二|三)口(?:以上の)?(?:ガス|IH)?コンロ/, has: /[23二三]口/ },
  { key: "counter", label: "カウンターか対面のキッチン", field: "preferences", re: /カウンターキッチン|対面(?:式)?キッチン|アイランドキッチン/, has: /カウンター|対面/ },
  { key: "autolock", label: "オートロック", field: "preferences", re: /オートロック/, has: /オートロック/ },
  { key: "delivery", label: "宅配ボックス", field: "preferences", re: /宅配(?:ボックス|BOX)/i, has: /宅配/ },
  { key: "dryer", label: "浴室乾燥機", field: "preferences", re: /浴室(?:換気)?乾燥/, has: /浴室.{0,3}乾燥/ },
  { key: "wic", label: "ウォークインクローゼット", field: "preferences", re: /ウォークイン|WIC/i, has: /ウォークイン|WIC/i },
  { key: "corner", label: "角部屋", field: "other_requests", re: /角部屋/, has: /角部屋/ },
  { key: "south", label: "南向き", field: "other_requests", re: /南向き|南面/, has: /南向き|南面/ },
];
/** 好みの手本の画像の書き起こし（見出しを外した物）→ 物件の特徴（並びは決まった順） */
export function tasteFeaturesFromTranscript(body: string): TasteFeature[] {
  const t = String(body ?? "").normalize("NFKC");
  return TASTE_RULES.filter((r) => r.re.test(t)).map(({ key, label, field }) => ({ key, label, field }));
}
/** 今の要望の欄に同じ好みが既にあるか（言い方が違っても同じ物は重ねない） */
export function tasteAlreadyIn(f: TasteFeature, existing: string | null | undefined): boolean {
  const r = TASTE_RULES.find((x) => x.key === f.key);
  const t = String(existing ?? "").normalize("NFKC");
  return !!r && !!t && (r.has ?? r.re).test(t);
}
