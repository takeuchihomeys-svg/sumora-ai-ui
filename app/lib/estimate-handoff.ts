// app/lib/estimate-handoff.ts
// LINE の会話 → 見積書作成（/estimate?conv=…）への引き継ぎを決める純関数（DB 依存なし・画面からも import できる）。
//
// 2026-10-01 竹内「見積書きかれたら LINE のところに見積書のがでて押したら見積書のツールのところに連携されるようにする
//   （見積書の画面にも監視する部分配置）。送った物件がセットされた状態で見積書つくれるようにして AD も分かるようにすれば
//   割引金額と最終確認だけスタッフがおこなえばスムーズ。物件送るときも見積書併せて送る場合もあるので
//   （初期費用を抑えるのが希望で、いきなり見積書を送って、費用を抑えていることを説明する際）その場合は場面を活かす」
//
// ── 作る前に測った（scripts/audit-estimate-handoff.ts・120日・YUMA を除く）──
//   見積書（AIX 見積書送る・本文あり）229通/92会話＝送った日に中央値2通（Q3 4）。見積書ツールの AI 読み取りは1日 中央値11回（9/15〜）。
//   依頼（見積・初期費用の発言）→送付: 同じ日に送った分で中央値143分（Q1 40・Q3 308）＝待たせている時間の大半は「作る」手間。
//   見積書の物件: こちらが送った 34%・お客様の持ち込み 24%・分からない 42%（記録の無い頃の送付）。
//   手で入れている物: 入居日は 99% 入れていない（日割の注記で済ませる）・割引は 97% 入れる（中央値 44,000＝家賃の 0.54ヶ月・
//   3アカウントとも 0.53〜0.56）→ 自動で入れるのは「物件・資料・お客様名・アカウント」、スタッフは「割引と最終確認」。
//   物件オススメに御見積書を同封: 123/639（19%・欄ができた 8/10 以降は 28%）。同封した通は今回の連投に費用の依頼が 4%
//   （＝聞かれる前に送る「先回り」）・初期費用を抑えたいお客様 73%（同封なし 66%）。
//
// ⚠ サーバー専用ライブラリ（supabase 等）を import しない。材料の読み込みは estimate-handoff-server.ts
import { matchKnownProperty, MATCH_MIN_SCORE } from "./property-name-match";

// ═════════════════════════════════════════════════════════════════════════════
// 初期費用を抑えたい
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 初期費用を抑えたい（条件の列・お客様の発言）。customer-wants の「敷礼0/初期費用を抑えたい」と同じ語に、
 * 否定（「増えてもよい」「気にしない」「特になし」）を外す形を足した。
 */
const LOW_COST_RE = /初期費用[^。！!\n]{0,14}(?:抑え|おさえ|安く|安い|安め|少な|0円|ゼロ|かからない|掛からない|最低限|極力)|敷金?礼金?[^。！!\n]{0,4}(?:なし|無し|0|ゼロ|不要)|敷礼[^。！!\n]{0,4}(?:なし|無し|0|ゼロ)|ゼロゼロ|フリーレント/;
const LOW_COST_NEG_RE = /初期費用[^。！!\n]{0,14}(?:増えても|高くても|気にしない|こだわらない|特に(?:なし|無し)|問題ない|大丈夫)/;
export function wantsLowInitialCostText(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return false;
  if (LOW_COST_NEG_RE.test(t)) return false;
  return LOW_COST_RE.test(t);
}

// ═════════════════════════════════════════════════════════════════════════════
// 入口（LINE の画面のどこに「見積書を作る」を出すか）
// ═════════════════════════════════════════════════════════════════════════════

export type EstimateEntryMode = "estimate" | "with_property";
export type EstimateEntry = { show: boolean; mode: EstimateEntryMode | null; label: string; reason: string };

/**
 * 「見積書を作る」を出すか。ブレインが決めた AIX（feedback_brain_owns_aix）に従い、ここで AIX の種類は変えない（提案だけ）。
 *   - ブレインが AIX【見積書送る】→ mode=estimate（見積書を作る＝AIX の前の段）
 *   - ブレインが AIX【物件オススメ】で、お客様が初期費用を抑えたい → mode=with_property（オススメに御見積書を同封する場面）
 *     実送信: 同封した通の 73% が抑えたいお客様・今回の連投に費用の依頼は 4%（先回り）。押すかはスタッフ（強制しない）
 *   - それ以外は出さない（物件が無い費用の質問は見積書にしない＝feedback_estimate_needs_property）
 * 物件ピックアップ（複数）には出さない: 30分以内に見積書が続いたのは 3%（445通中15）＝場面として立っていない。
 */
export function resolveEstimateEntry(o: { brainAction: string | null | undefined; lowInitialCost: boolean }): EstimateEntry {
  const a = String(o.brainAction ?? "");
  if (a === "estimate_sheet") return { show: true, mode: "estimate", label: "🧾 見積書を作る", reason: "ブレイン: AIX【見積書送る】" };
  if (a === "property_recommendation" && o.lowInitialCost) {
    return { show: true, mode: "with_property", label: "🧾 御見積書も作って同封する", reason: "初期費用を抑えたいお客様への物件オススメ（実送信の同封の 73%）" };
  }
  return { show: false, mode: null, label: "", reason: "" };
}

/** LINE → 見積書作成の URL（会話 ID と場面だけ。中身はツールがサーバーから読む＝URL に個人情報を載せない） */
export function buildEstimateHref(conversationId: string, mode: EstimateEntryMode | null = "estimate"): string {
  const p = new URLSearchParams({ conv: conversationId });
  if (mode && mode !== "estimate") p.set("scene", mode);
  return `/estimate?${p.toString()}`;
}
export function parseEstimateHandoff(search: string): { conversationId: string; mode: EstimateEntryMode } | null {
  const p = new URLSearchParams(search);
  const conv = (p.get("conv") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(conv)) return null;
  return { conversationId: conv, mode: p.get("scene") === "with_property" ? "with_property" : "estimate" };
}

/** 見積書作成 → LINE（作った見積書の画像を AIX にセットして開く）。画像は Blob に置いた URL */
export type EstimateReturnAix = "estimate_sheet" | "property_recommendation";
export function buildEstimateReturnHref(conversationId: string, imageUrl: string, aix: EstimateReturnAix): string {
  const p = new URLSearchParams({ conv: conversationId, est_img: imageUrl, est_aix: aix });
  return `/?${p.toString()}`;
}
/** est_img は自分の Blob（vercel-storage）だけ受ける（よその URL を取りに行かない） */
export function parseEstimateReturn(search: string): { conversationId: string; imageUrl: string; aix: EstimateReturnAix } | null {
  const p = new URLSearchParams(search);
  const conv = (p.get("conv") ?? "").trim();
  const img = (p.get("est_img") ?? "").trim();
  const aix = p.get("est_aix") === "property_recommendation" ? "property_recommendation" : "estimate_sheet";
  if (!/^[0-9a-f-]{36}$/i.test(conv)) return null;
  if (!/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//i.test(img)) return null;
  return { conversationId: conv, imageUrl: img, aix };
}

// ═════════════════════════════════════════════════════════════════════════════
// どのお部屋の見積書か（決定論・出所を見せる）
// ═════════════════════════════════════════════════════════════════════════════

export type HandoffMaterial = { url: string; kind: "pickup_page" | "sent_image" | "customer_image"; label: string };

/** こちらが送った物件（sent_properties の customer 行＋売上サポの行を名前で寄せた物） */
export type HandoffSentProperty = {
  name: string;
  room: string | null;
  sentAt: string;
  /** aix:property_send / aix:property_recommendation / vision / staff_image … */
  source: string | null;
  imageUrl: string | null;
  pickupId: number | null;
};
export type HandoffPickup = {
  id: number;
  name: string;
  room: string | null;
  sentAt: string | null;
  createdAt: string;
  status: string | null;
  adYen: number | null;
  rent: number | null;
  managementFee: number | null;
  adStamp: string | null;
  adMonths: number | null;
  dealStatus: string | null;
  pageImageUrl: string | null;
  pdfText: string | null;
  expired: boolean;
};
/** sent_properties の AD（売上番長グループへの共有の行も含む＝拡張が送った時に説明文から読んだ AD） */
export type HandoffAdRow = { name: string; room: string | null; adMonths: number | null; adYen: number | null; rent: number | null; at: string | null };
/** customer-state の主のお部屋 */
export type HandoffFocus = { name: string; building: string; room: string | null; sentByUs: boolean; status: string; statusLabel: string; customerInterest: boolean } | null;

/** 会話の1通（古い順で渡す）。quotedId は LINE の引用先（messages.line_message_id） */
export type HandoffMessage = {
  sender: string;
  text: string | null;
  at: string;
  imageUrl?: string | null;
  imageType?: string | null;
  lineMessageId?: string | null;
  quotedId?: string | null;
};

export type HandoffPropRef = { name: string; room: string | null };
/**
 * お部屋の出来事（新しい物ほど強い）。
 *   customer_quoted  お客様がこちらの送付を引用して聞いた（引用先の 🌟／【】／送った画像の物件）
 *   customer_named   お客様がこちらの送った建物名を書いた
 *   customer_brought お客様が物件の画像・URL を送った（名前は共有文・画像の文字の「物件名：」から。読めなければ名前なし）
 *   our_rec          こちらの 🌟（物件オススメ・物件確認した）の1通
 *   our_send         こちらの送付の回（sent_properties・10分以内を1回）
 */
export type HandoffEventKind = "customer_quoted" | "customer_named" | "customer_brought" | "our_rec" | "our_send";
export type HandoffEvent = { at: string; kind: HandoffEventKind; props: HandoffPropRef[]; images: HandoffMaterial[]; links?: string[]; unverified?: boolean };
/** 引用が見積書・物件の問いか（費用・見積・物件・空き・詳細・「ここ」「こちら」・？） */
const QUOTE_ASK_RE = /見積|初期費用|費用|いくら|物件|お部屋|部屋|空き|空いて|詳細|内装|ここ|こちら|これ|[？?]/;

export type EstimateTargetSource = "customer_quoted" | "customer_named" | "customer_brought" | "our_rec" | "our_send" | "focus" | "candidate";
export const TARGET_SOURCE_LABEL: Record<EstimateTargetSource, string> = {
  customer_quoted: "お客様が引用して聞いたお部屋",
  customer_named: "お客様が名前を書いたお部屋",
  customer_brought: "お客様が送ってくれたお部屋（画像・URL）",
  our_rec: "直近にこちらがオススメしたお部屋（🌟）",
  our_send: "直近にこちらが送ったお部屋（1件）",
  focus: "会話の主のお部屋（customer-state）",
  candidate: "候補（スタッフが選ぶ）",
};

export type EstimateTarget = {
  name: string;
  room: string | null;
  source: EstimateTargetSource;
  sourceLabel: string;
  at: string | null;
  materials: HandoffMaterial[];
  /** お客様が送ったリンク（ポータルの URL・名前が読めない共有文の時に開いて確かめる） */
  link?: string | null;
  /** 資料の文字（売上サポの PDF の文字層）＝AI 読み取りの補足情報に渡す */
  materialText: string | null;
  rent: number | null;
  managementFee: number | null;
  adMonths: number | null;
  adYen: number | null;
  adLabel: string | null;
  adSource: "pickup" | "sent" | null;
  pickupId: number | null;
  dealStatus: string | null;
  ended: boolean;
};

export type EstimateTargetChoice = {
  target: EstimateTarget | null;
  /** 同じ出来事の残り（お客様が複数送った・回の他のお部屋）＝続けて作る／選び直す */
  candidates: EstimateTarget[];
  /** この会話の直近のお部屋（新しい順・選び直し用・最大8） */
  others: EstimateTarget[];
  warnings: string[];
  /** 開いた時に AI 読み取りまで自動で進めてよいか（物件が1つに決まり・資料があり・止める警告が無い時だけ） */
  autoExtract: boolean;
};

const PROPERTY_IMAGE_TYPES = new Set(["floor_plan", "property_photo", "estimate"]);
/** こちらの 🌟 の見出し（「🌟グランパシフィック花園Luxe 1006号室 新着で…」「🌟T's Court福島 401 9月末…」） */
const STAR_HEAD_RE = /🌟\s*([^\n🌟【】！!（(、。]{2,40}?)\s+([0-9０-９]{2,4}[A-Za-zＡ-Ｚ]?)(?:\s*号室)?(?=[\s！!、。]|$)/gu;
/** 見積書・物件確認の【物件名 号室】 */
const BRACKET_RE = /【([^【】\n]{2,40}?)\s*([0-9０-９]{2,4}[A-Za-zＡ-Ｚ]?)?\s*(?:号室)?】/gu;
/** お客様の画像の文字（取り込みの読み取り）の「物件名：〇〇」／「号室名：0201」 */
// 取り込みの読み取りは1行に続けて書く（「物件名：CITY SPIRE桜川Ⅲ 号室名：307（3階部分） 所在地：…」）→ 次の見出しの前まで
const IMG_NAME_RE = /物件名\s*[:：]\s*(.+?)(?=\s*(?:号室名|所在地|交通|間取り|賃料|家賃|[（(]|\n|$))/u;
const IMG_ROOM_RE = /号室名\s*[:：]\s*([0-9０-９]{2,4})/u;
const NON_NAME_RE = /^(?:お客様|物件名|お部屋|初期費用|御見積|見積|必ず|AIX|画像|①|②|③)/;

const toHalf = (s: string) => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
export function staffPropsFromText(text: string | null | undefined): HandoffPropRef[] {
  const t = String(text ?? "");
  const out: HandoffPropRef[] = [];
  for (const m of t.matchAll(STAR_HEAD_RE)) out.push({ name: m[1].trim(), room: toHalf(m[2]).replace(/^0+/, "") || null });
  for (const m of t.matchAll(BRACKET_RE)) {
    const name = m[1].trim();
    // 条件フォームの見出し（「④【希望築年数】⇒」）は物件ではない: 直後が ⇒ → ：、または名前が希望・条件の語
    const after = t.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 2);
    if (NON_NAME_RE.test(name) || /[⇒→:：]/.test(name) || /^\s*[⇒→:：]/.test(after) || /希望|条件|限度額|エリア|間取り|入居時期/.test(name)) continue;
    out.push({ name, room: m[2] ? toHalf(m[2]).replace(/^0+/, "") || null : null });
  }
  const seen = new Set<string>();
  return out.filter((p) => { const k = `${p.name}|${p.room ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
// 2026-10-01 当て直しの外れ（16件）を目で読んだ: ポータルのアプリの画面は「物件情報 ドルチェヴィータ新北野 3階」「アプリーレ南堀江 7階 7.6万円」
//   「賃貸マンション 特典あり ハイム北野 3.8万円」「名称：湯里４丁目戸建」の形（物件名： が無い）→ 読む形を足す
const IMG_ALT_NAME_RES: RegExp[] = [
  /名称\s*[:：]\s*([^\s　]{2,30})/u,
  /物件情報\s*\**\s*(?:\[[^\]]*\]\s*)?([^\s　【】\[\]*：:]{3,30}?)\s*[0-9０-９]{1,2}\s*階/u,
  /賃貸(?:マンション|アパート|一戸建て?)\s*(?:特典あり\s*)?([^\s　]{3,30}?)\s+[0-9０-９.]+\s*万円/u,
  /(?:^|\n|\]\s)([^\s　【】\[\]*：:。、！？0-9０-９]{3,30}?)\s*[0-9０-９]{1,2}\s*階(?:\s|$)/u,
  // 資料の1行目が建物名で、次の行に駅・路線（「[画像] フェリスシエロ堺\n\n南海電気鉄道 南海線「堺」駅徒歩17分」・2ae0d94e）
  /^\s*\[画像\]\s*([^\s　【】\[\]*：:。、！？]{3,30})\s*\n[\s\S]{0,40}?(?:駅|線|徒歩)/u,
];
/** 名前らしくない語（画面の見出し・説明） */
const NOT_BUILDING_RE = /^(?:物件情報|所在階|階建|間取り|お気に入り|最近みた|SUUMO|スーモ|アプリ|App|画像|写真|地上|地下|建物|マンション|アパート|賃貸)/;
/** お客様の画像の読み取りの文字から物件名（「物件名：CITY SPIRE桜川Ⅲ 号室名：307」・ポータルのアプリの「物件情報 〇〇 3階」） */
export function customerImageProp(text: string | null | undefined): HandoffPropRef | null {
  const t = String(text ?? "");
  const r = t.match(IMG_ROOM_RE);
  const room = r ? toHalf(r[1]).replace(/^0+/, "") || null : null;
  const m = t.match(IMG_NAME_RE);
  if (m) {
    const raw = m[1].replace(/\s*号室名.*$/, "").trim();
    const rm = raw.match(/\s*([0-9０-９]{2,4})\s*号室?\s*$/);
    const name = rm ? raw.slice(0, rm.index).trim() : raw;
    if (name.length >= 2) return { name, room: room ?? (rm ? toHalf(rm[1]).replace(/^0+/, "") || null : null) };
  }
  for (const re of IMG_ALT_NAME_RES) {
    const a = t.match(re);
    const name = a?.[1]?.replace(/[*＊]+/g, "").trim() ?? "";
    if (name.length >= 3 && !NOT_BUILDING_RE.test(name) && /[ァ-ヶ一-龯A-Za-zＡ-Ｚａ-ｚ]/.test(name)) return { name, room };
  }
  return null;
}

/** 物件の資料・ポータルの画面らしい画像の読み取り（種類が other・無しの時に使う。2つ以上の手がかりで物件とみなす） */
const LISTING_HINT_RES = [/物件情報|物件名/, /賃料|[0-9.]+\s*万円/, /管理費|共益費/, /間取り|[1-4]\s*[LSDK]{1,3}\b|ワンルーム/, /敷\s*金?|礼\s*金?/, /徒歩\s*[0-9]+\s*分/, /SUUMO|スーモ|HOME'?S|アットホーム|空室状況|内見予約|お問(?:い)?合(?:わ)?せ/];
export function looksLikeListingImageText(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!/^\s*\[画像\]/.test(t)) return false;
  return LISTING_HINT_RES.filter((re) => re.test(t)).length >= 2;
}

/**
 * お客様の文の「〇〇の物件／の初期費用／の詳細」の〇〇（こちらの送付に無い建物名＝未確認の名前）。
 * 「こちらの」「前の」等の指す言葉は名前にしない。
 */
const FREE_NAME_RE = /([ァ-ヶーA-Za-z一-龯0-9・\-ⅡⅢⅣ]{3,24}?)(?:の(?:物件|お部屋|部屋|初期費用|見積|御見積|詳細|内装|空き)|って(?:物件|お部屋))/u;
const POINTER_RE = /^(?:こちら|そちら|あちら|この|その|あの|ここ|そこ|前|以前|最初|先程|さっき|今回|上|下|他|別|同じ|新しく来た|新着|全て|全部|両方|[0-9]+件|物件|お部屋|部屋)/u;
export function freeTextPropertyName(text: string | null | undefined): string | null {
  const t = String(text ?? "").normalize("NFKC");
  if (/^\s*\[画像\]/.test(t)) return null;
  const m = t.match(FREE_NAME_RE);
  if (!m) return null;
  // 「以前送ったハイム北野の詳細」→ 送った・頂いた 等の後ろだけを名前にする
  const name = m[1].replace(/^.*(?:送った|送っていた|頂いた|いただいた|もらった|見た|聞いた)/u, "").trim();
  if (name.length < 3 || POINTER_RE.test(name) || /^[0-9]+$/.test(name)) return null;
  if (!/[ァ-ヶA-Za-z]/.test(name) && !/[一-龯]{2,}(?:[0-9]|丁目|番館|号館|号棟)/.test(name)) return null;
  return name;
}

/** 建物名の芯（末尾の番館・号館・号棟・番号を外す）＝「富士林プラザ15番館」を「富士林プラザ」と書かれても寄せる */
function nameCore(s: string): string {
  return nameKey(s).replace(/(?:[0-9]+(?:番館|号館|号棟|棟)|[0-9]+|[ⅰ-ⅻⅠ-Ⅻ]+|iii|ii|i)$/u, "");
}

const PORTAL_URL_RE = /https?:\/\/(?!(?:[\w.-]*\.)?(?:line\.me|lin\.ee|tiktok\.com|apps\.apple\.com|play\.google\.com))\S+/;
const nameKey = (s: string) => s.normalize("NFKC").replace(/[\s　・･\-ー－()（）【】🌟]/g, "").toLowerCase();

/**
 * 会話（古い順）・送付の記録から、お部屋の出来事を並べる（純関数）。
 * sharedNamesOf は customer-property-names.customerSharedPropertyNames を渡す（共有文の物件名）。
 */
export function buildHandoffEvents(o: {
  messages: ReadonlyArray<HandoffMessage>;
  sent: ReadonlyArray<HandoffSentProperty>;
  sharedNamesOf: (m: HandoffMessage) => string[];
  batchGapMs?: number;
}): HandoffEvent[] {
  const gap = o.batchGapMs ?? 10 * 60_000;
  const events: HandoffEvent[] = [];
  const byLineId = new Map<string, HandoffMessage>();
  for (const m of o.messages) if (m.lineMessageId) byLineId.set(m.lineMessageId, m);
  const sentByImage = new Map<string, HandoffSentProperty>();
  for (const s of o.sent) if (s.imageUrl) sentByImage.set(s.imageUrl, s);
  // こちらが送った建物名（お客様が名前を書いたかの照合に使う）
  const ourNames = new Map<string, HandoffPropRef>();
  const addOur = (p: HandoffPropRef) => { const k = nameKey(p.name); if (k.length >= 3 && !ourNames.has(k)) ourNames.set(k, p); };
  for (const s of o.sent) addOur({ name: s.name, room: s.room });

  for (const m of o.messages) {
    if (m.sender === "customer") {
      // 引用
      if (m.quotedId) {
        const q = byLineId.get(m.quotedId);
        if (q && q.sender !== "customer") {
          const props = staffPropsFromText(q.text);
          const viaImage = q.imageUrl ? sentByImage.get(q.imageUrl) : undefined;
          if (viaImage) props.push({ name: viaImage.name, room: viaImage.room });
          // 2026-10-01 監査（110b3053）: 内覧の日時の返事の引用（「日曜日の17時でお願いします」）を見積書の対象にしていた → 問い・依頼の形の引用だけ
          if (props.length && QUOTE_ASK_RE.test(m.text ?? "")) { events.push({ at: m.at, kind: "customer_quoted", props, images: [] }); continue; }
        }
      }
      // 持ち込み（物件の画像・URL）
      // 2026-10-01 監査: 画像の URL が残っていない（古い）・種類が other／無し（SUUMO の画面の写し）でも、種類か読み取りの文字で物件の画像とみなす。資料に使うのは URL がある時だけ
      const isPropImage = PROPERTY_IMAGE_TYPES.has(m.imageType ?? "") || ((m.imageType == null || m.imageType === "other") && looksLikeListingImageText(m.text));
      const hasUrl = PORTAL_URL_RE.test(m.text ?? "");
      if (isPropImage || hasUrl) {
        const props: HandoffPropRef[] = [];
        const ip = isPropImage ? customerImageProp(m.text) : null;
        if (ip) props.push(ip);
        // 共有文の「URL の前の行」はお客様の文のこともある（「こちらの物件の初期費用をお伺いしたいです🙏🏻」）→ 文の形は名前にしない
        else for (const n of o.sharedNamesOf(m)) if (!/です|ます|ください|下さい|たい|[？?]/.test(n)) props.push({ name: n, room: null });
        const images: HandoffMaterial[] = isPropImage && m.imageUrl ? [{ url: m.imageUrl, kind: "customer_image", label: m.imageType === "estimate" ? "お客様が送った見積書の画像" : "お客様が送った物件の画像" }] : [];
        const links = hasUrl ? [(m.text ?? "").match(PORTAL_URL_RE)![0]] : [];
        // 続けて送った画像・URL（2分以内）は1つの出来事にまとめる
        const last = events[events.length - 1];
        if (last && last.kind === "customer_brought" && new Date(m.at).getTime() - new Date(last.at).getTime() <= 2 * 60_000) {
          last.props.push(...props); last.images.push(...images); last.links = [...(last.links ?? []), ...links]; last.at = m.at;
        } else {
          events.push({ at: m.at, kind: "customer_brought", props, images, links });
        }
        continue;
      }
      // 名前を書いた（こちらの送付・🌟・見積書の【】の建物名。「富士林プラザ15番館」を「富士林プラザ」と書いても芯で寄せる）
      const tk = nameKey(m.text ?? "");
      const named = [...ourNames.entries()].filter(([k, p]) => tk.includes(k) || (nameCore(p.name).length >= 4 && tk.includes(nameCore(p.name)))).map(([, p]) => p);
      if (named.length) { events.push({ at: m.at, kind: "customer_named", props: named, images: [] }); continue; }
      // こちらの記録に無い名前（「プレジオ十三の物件の情報ありますか？」「以前送ったハイム北野の詳細」）＝未確認の名前として出す
      const free = freeTextPropertyName(m.text);
      if (free) events.push({ at: m.at, kind: "customer_named", props: [{ name: free, room: null }], images: [], unverified: true });
      continue;
    }
    // こちらの 🌟（物件オススメ・物件確認した）。【】は見積書・確認の見出しなので数えない（見積書そのものは対象を決める材料にしない）
    // 見積書・物件確認の【】の建物名も「こちらの建物名」に入れる（出来事にはしない・お客様が後で名前を書いた時に寄せる）
    for (const p of staffPropsFromText(m.text)) addOur(p);
    const stars = staffPropsFromText((m.text ?? "").split("\n").filter((l) => l.includes("🌟")).join("\n"));
    if (stars.length) {
      for (const p of stars) addOur(p);
      events.push({ at: m.at, kind: "our_rec", props: stars, images: [] });
    }
  }
  // 送付の回
  const sorted = [...o.sent].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  let cur: HandoffEvent | null = null;
  let curStart = 0;
  for (const s of sorted) {
    const t = new Date(s.sentAt).getTime();
    if (!cur || t - curStart > gap) { cur = { at: s.sentAt, kind: "our_send", props: [], images: [] }; curStart = t; events.push(cur); }
    if (!cur.props.some((p) => nameKey(p.name) === nameKey(s.name) && roomEq(p.room, s.room))) cur.props.push({ name: s.name, room: s.room });
    cur.at = s.sentAt;
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

function roomEq(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) => toHalf((s ?? "").normalize("NFKC")).replace(/号室?$/, "").replace(/^0+/, "").trim();
  return !n(a) || !n(b) || n(a) === n(b);
}

/** 名前（＋号室）で売上サポの行・AD の行を寄せて、資料・AD・家賃を付ける */
function enrich(base: { name: string; room: string | null; source: EstimateTargetSource; at: string | null; materials?: HandoffMaterial[] },
  pickups: ReadonlyArray<HandoffPickup>, adRows: ReadonlyArray<HandoffAdRow>, sent: ReadonlyArray<HandoffSentProperty>): EstimateTarget {
  const named = base.name.length >= 2;
  const pickNames = [...new Set(pickups.map((p) => p.name))];
  const hit = named ? matchKnownProperty(base.name, pickNames, MATCH_MIN_SCORE) : null;
  const picks = hit ? pickups.filter((p) => p.name === hit.name && roomEq(p.room, base.room))
    .sort((a, b) => String(b.sentAt ?? b.createdAt).localeCompare(String(a.sentAt ?? a.createdAt))) : [];
  // 送った行を優先（同じ建物を何回もピックアップしている時は送った回の資料）
  const pick = picks.find((p) => p.status === "sent") ?? picks[0] ?? null;
  const materials: HandoffMaterial[] = [...(base.materials ?? [])];
  if (pick?.pageImageUrl) materials.push({ url: pick.pageImageUrl, kind: "pickup_page", label: "売上サポの資料" });
  const sentHit = named ? matchKnownProperty(base.name, [...new Set(sent.map((s) => s.name))], MATCH_MIN_SCORE) : null;
  const sentImg = sentHit ? sent.filter((s) => s.name === sentHit.name && roomEq(s.room, base.room) && s.imageUrl).sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0] : null;
  if (sentImg?.imageUrl && !pick?.pageImageUrl && !materials.some((m) => m.url === sentImg.imageUrl)) materials.push({ url: sentImg.imageUrl, kind: "sent_image", label: "お客様に送った資料の画像" });

  let adMonths: number | null = null, adYen: number | null = null, adLabel: string | null = null, adSource: EstimateTarget["adSource"] = null;
  let rent: number | null = pick?.rent ?? null;
  if (pick && (pick.adYen != null || pick.adMonths != null)) {
    adYen = pick.adYen ?? (pick.adMonths != null && pick.rent ? Math.round(pick.adMonths * pick.rent) : null);
    adMonths = pick.adMonths ?? (pick.adYen && pick.rent ? Math.round((pick.adYen / pick.rent) * 100) / 100 : null);
    adLabel = pick.adStamp; adSource = "pickup";
  } else if (named) {
    const adHit = matchKnownProperty(base.name, [...new Set(adRows.filter((r) => r.adMonths != null || r.adYen != null).map((r) => r.name))], MATCH_MIN_SCORE);
    const row = adHit ? adRows.filter((r) => r.name === adHit.name && roomEq(r.room, base.room) && (r.adMonths != null || r.adYen != null))
      .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))[0] : null;
    if (row) {
      adMonths = row.adMonths; rent = rent ?? row.rent;
      const r = row.rent ?? rent;
      adYen = row.adYen ?? (row.adMonths != null && r ? Math.round(row.adMonths * r) : null);
      adSource = "sent";
    }
  }
  return {
    name: base.name, room: base.room ?? pick?.room ?? null, source: base.source, sourceLabel: TARGET_SOURCE_LABEL[base.source], at: base.at,
    materials, materialText: pick?.pdfText ?? null, rent, managementFee: pick?.managementFee ?? null,
    adMonths, adYen, adLabel, adSource, pickupId: pick?.id ?? null, dealStatus: pick?.dealStatus ?? null, ended: !!pick?.expired,
  };
}

/** 見積書の依頼（focused-estimate-request の依頼の形に「見積」「初期費用」の語を足した広めの物・出来事を選ぶ時の目印だけに使う） */
export const ESTIMATE_ASK_HINT_RE = /見積|初期費用|費用.{0,6}(?:いくら|どのくらい|どれくらい|知りたい|しりたい|教えて)|総額|概算|いくら|詳細/;
/** お客様の見積・初期費用の依頼の時刻（画像の読み取りの文字は除く） */
export function customerAskTimes(messages: ReadonlyArray<HandoffMessage>): string[] {
  return messages.filter((m) => m.sender === "customer" && !/^s*[画像]/.test(m.text ?? "") && ESTIMATE_ASK_HINT_RE.test(m.text ?? "")).map((m) => m.at);
}

/**
 * 見積書を作るお部屋を決める（決定論）。
 *   ① 直近 windowDays 日の出来事のうち、お客様の出来事（引用・名前・持ち込み）が**こちらの最後の送付より新しければ**それ
 *      （引用 ＞ 名前 ＞ 持ち込み の順に、同じ強さなら新しい方）
 *   ② 無ければ一番新しいこちらの出来事（🌟 の1通／送付の回）。回が複数件なら決めない（候補を並べる）
 *   ③ 出来事が無ければ customer-state の主のお部屋
 *   無ければ「物件がありません」（見積書は物件がある時だけ＝feedback_estimate_needs_property）
 * 主のお部屋と選んだお部屋が違う時は警告だけ出す（選んだ方を使う・customer-state の主のお部屋は監査で半分外れた＝pickSingleFocusName の注記）。
 */
export function selectEstimateTarget(input: {
  events: ReadonlyArray<HandoffEvent>;
  focus: HandoffFocus;
  sent: ReadonlyArray<HandoffSentProperty>;
  pickups: ReadonlyArray<HandoffPickup>;
  adRows: ReadonlyArray<HandoffAdRow>;
  now?: number;
  windowDays?: number;
  /** お客様の見積・初期費用の依頼の時刻（customerAskTimes）。渡された時だけ「依頼の無い 🌟／送付」を候補に下げる */
  askTimes?: ReadonlyArray<string>;
}): EstimateTargetChoice {
  const { focus, sent, pickups, adRows } = input;
  const now = input.now ?? Date.now();
  const windowMs = (input.windowDays ?? 14) * 86400_000;
  const evs = input.events.filter((e) => now - new Date(e.at).getTime() <= windowMs && new Date(e.at).getTime() <= now);
  const warnings: string[] = [];
  const lastOurAt = [...evs].reverse().find((e) => e.kind === "our_rec" || e.kind === "our_send")?.at ?? "";
  const custAfter = evs.filter((e) => (e.kind === "customer_quoted" || e.kind === "customer_named" || e.kind === "customer_brought") && e.at >= lastOurAt);
  const rank: Record<HandoffEventKind, number> = { customer_quoted: 3, customer_named: 2, customer_brought: 1, our_rec: 0, our_send: 0 };
  let picked: HandoffEvent | null = null;
  let demoted = false;
  if (custAfter.length) {
    // 2026-10-01 監査（110b3053・9280fa49）: 種類の強さを先にすると、前日の引用が当日の持ち込みに勝っていた
    //   → 新しい順。10分以内に並んだ物だけ 引用＞名前＞持ち込み（同じ連投の中の強さ）
    const newest = custAfter.reduce((a, b) => (a.at >= b.at ? a : b));
    const near = custAfter.filter((e) => new Date(newest.at).getTime() - new Date(e.at).getTime() <= 10 * 60_000);
    picked = [...near].sort((a, b) => rank[b.kind] - rank[a.kind] || b.at.localeCompare(a.at))[0];
  } else {
    picked = [...evs].reverse().find((e) => e.kind === "our_rec" || e.kind === "our_send") ?? null;
    // 2026-10-01 監査（328c42ab・2e278817）: お客様の依頼が無いままの見積書（スタッフの先回り）は 🌟 と別のお部屋のことが多い
    //   → 迷う時は決めない（入口・出口の型: 外すより候補に並べる）。依頼の時刻を渡された時だけ効かせる
    if (picked && input.askTimes && !input.askTimes.some((t) => t >= picked!.at)) demoted = true;
  }

  let target: EstimateTarget | null = null;
  let candidates: EstimateTarget[] = [];
  if (picked) {
    const src: EstimateTargetSource = picked.kind;
    if (picked.kind === "our_send" && picked.props.length > 1) {
      candidates = picked.props.slice(0, 10).map((p) => enrich({ name: p.name, room: p.room, source: "candidate", at: picked!.at }, pickups, adRows, sent));
      warnings.push(`直近の回で${picked.props.length}件お送りしています。どのお部屋の見積書か選んでください`);
    } else if (picked.kind === "customer_brought" && picked.props.length === 0) {
      target = enrich({ name: "", room: null, source: src, at: picked.at, materials: picked.images.slice(0, 3) }, pickups, adRows, sent);
      target.link = picked.links?.[0] ?? null;
      warnings.push("お客様が送ったお部屋の名前は画像から読みます（AI 読み取りの後に物件名を確かめてください）");
    } else {
      const all = picked.props.map((p, i) => enrich({
        name: p.name, room: p.room, source: i === 0 ? src : "candidate", at: picked!.at,
        // 持ち込みの画像は名前の順と同じ並び（1枚に1件）。数が合わない時は全部を1件目に付ける
        materials: picked!.kind === "customer_brought" ? (picked!.images.length === picked!.props.length ? [picked!.images[i]] : i === 0 ? picked!.images.slice(0, 3) : []) : [],
      }, pickups, adRows, sent));
      target = all[0] ?? null;
      if (target && picked.kind === "customer_brought") target.link = picked.links?.[0] ?? null;
      candidates = all.slice(1);
      if (all.length > 1) warnings.push(`${TARGET_SOURCE_LABEL[src]}が${all.length}件あります（1件ずつ作れます）`);
      if (picked.unverified && target) warnings.push(`「${target.name}」はこちらの送付の記録に無い名前です（お客様の書いた名前のまま・資料を貼ってください）`);
      if (demoted && target) {
        candidates = [{ ...target, source: "candidate", sourceLabel: TARGET_SOURCE_LABEL.candidate }, ...candidates];
        target = null;
        warnings.push("お客様からの見積書の依頼がまだありません（先回りの見積書）。どのお部屋か選んでください");
      }
    }
    if (target?.source === "customer_brought" && picked.images.some((im) => /見積書/.test(im.label))) warnings.push("お客様が他社の見積書を送っています（比べる金額に注意）");
  } else if (focus) {
    target = enrich({ name: focus.building || focus.name, room: focus.room, source: "focus", at: null }, pickups, adRows, sent);
    if (focus.status === "ended") target.ended = true;
  }
  if (!target && candidates.length === 0) warnings.push("見積書を作るお部屋がありません（見積書は物件が届いた・送った・見積依頼がある時だけ）");

  if (target) {
    if (focus && target.name && target.source !== "focus" && !matchKnownProperty(target.name, [focus.building, focus.name], MATCH_MIN_SCORE)) {
      warnings.push(`主のお部屋（${focus.name}）とは別のお部屋です`);
    }
    if (target.ended) warnings.push("このお部屋は募集終了の記録があります");
    if (target.dealStatus) warnings.push(`資料の現況が「${target.dealStatus}」です`);
    if (target.adMonths == null && target.adYen == null && target.source !== "customer_brought") warnings.push("AD が分かりません（資料・管理会社で確かめてください）");
    if (target.materials.length === 0 && !target.materialText) warnings.push("資料の画像がありません（貼り付けてから AI で読み取ってください）");
  }
  const blocking = !target || target.ended || !!target.dealStatus;
  const autoExtract = !blocking && !!target && (target.materials.length > 0 || !!target.materialText);
  // 選び直し用: 出来事の新しい順に、選んだ物・候補と違うお部屋
  const taken = [target, ...candidates].filter((x): x is EstimateTarget => !!x && x.name.length >= 2).map((x) => x.name);
  const others: EstimateTarget[] = [];
  for (const e of [...evs].reverse()) {
    for (const p of e.props) {
      if (others.length >= 8) break;
      if (p.name.length < 2 || matchKnownProperty(p.name, [...taken, ...others.map((x) => x.name)], MATCH_MIN_SCORE)) continue;
      others.push(enrich({ name: p.name, room: p.room, source: "candidate", at: e.at }, pickups, adRows, sent));
    }
  }
  return { target, candidates, others, warnings, autoExtract };
}

// ═════════════════════════════════════════════════════════════════════════════
// 割引の目安（スタッフが決める・押した時だけ入る）
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 実送信の割引/家賃（180日・1物件の見積書 170通・家賃は節約額から逆算）: 中央値 0.54ヶ月（Q1 0.39・Q3 0.78）。
 * giga 0.53・ieyasu 0.54・sumora 0.56 ＝アカウントでほぼ同じなので1つの値。
 */
export const DISCOUNT_RATIO_MEDIAN = 0.54;
export const DISCOUNT_RATIO_Q1 = 0.39;
export const DISCOUNT_RATIO_Q3 = 0.78;

export type DiscountSuggestion = {
  yen: number;
  lowYen: number;
  highYen: number;
  basis: string;
  /** AD − 目安（AD が分かる時） */
  profitYen: number | null;
  warning: string | null;
  /** 家賃から目安を出した時の参考: このお客様の前の見積書の割引の中央値（別のお部屋） */
  pastMedianYen?: number | null;
};
const round1000 = (n: number) => Math.round(n / 1000) * 1000;

/**
 * 割引の目安。家賃が分かれば家賃×0.54ヶ月（実送信の中央値・Q1 0.39〜Q3 0.78）、分からなければこのお客様に前に送った見積書の割引の中央値。
 * 前の割引は別のお部屋（家賃が違う）の値なので、家賃が分かる時は目安にせず「参考」として並べるだけ
 * （YUMA で前の割引 124,050円を家賃 65,000円のお部屋の目安にして AD を超えた＝2026-10-01 の試し）。
 * AD が分かれば「AD − 割引＝利益」を添え、割引が AD を超えたら警告。割引はこちらが自由に決める値なので、入れるのはスタッフ（押した時だけ欄に入る）。
 */
export function suggestEstimateDiscount(o: { rent: number | null | undefined; adYen?: number | null; pastDiscounts?: ReadonlyArray<number> }): DiscountSuggestion | null {
  const rent = o.rent && o.rent > 0 ? o.rent : null;
  const past = (o.pastDiscounts ?? []).filter((v) => v > 0);
  const pastSorted = [...past].sort((a, b) => a - b);
  const pastMedianYen = pastSorted.length ? pastSorted[Math.floor(pastSorted.length / 2)] : null;
  let yen: number, low: number, high: number, basis: string;
  if (rent) {
    yen = round1000(rent * DISCOUNT_RATIO_MEDIAN);
    low = round1000(rent * DISCOUNT_RATIO_Q1); high = round1000(rent * DISCOUNT_RATIO_Q3);
    basis = `家賃×${DISCOUNT_RATIO_MEDIAN}ヶ月（実送信の中央値）`;
  } else if (pastMedianYen != null) {
    yen = pastMedianYen; low = pastSorted[0]; high = pastSorted[pastSorted.length - 1];
    basis = `このお客様に前に送った見積書の割引（${past.length}件）`;
  } else {
    return null;
  }
  const ad = o.adYen && o.adYen > 0 ? o.adYen : null;
  const profitYen = ad != null ? ad - yen : null;
  const warning = ad != null && yen > ad ? `目安の割引が AD（${ad.toLocaleString()}円）を超えています` : null;
  return { yen, lowYen: low, highYen: high, basis, profitYen, warning, pastMedianYen: rent ? pastMedianYen : null };
}

/** 割引を入れた後の利益の一言（画面用） */
export function profitLine(adYen: number | null | undefined, discountYen: number | null | undefined): string | null {
  if (!adYen || adYen <= 0) return null;
  const d = discountYen ?? 0;
  const p = adYen - d;
  return `AD ${adYen.toLocaleString()}円 − 割引 ${d.toLocaleString()}円 ＝ 利益 ${p.toLocaleString()}円${p < 0 ? "（マイナス）" : ""}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// 資料の文字から家賃・管理費（売上サポの summary_text「55,000円 7,000円」）
// ═════════════════════════════════════════════════════════════════════════════
export function rentFromSummary(summary: string | null | undefined): { rent: number | null; managementFee: number | null } {
  const t = String(summary ?? "").normalize("NFKC");
  const m = t.match(/^\s*([\d,]{4,9})円(?:\s+([\d,]{1,7})円)?/m);
  if (!m) return { rent: null, managementFee: null };
  const rent = parseInt(m[1].replace(/,/g, ""), 10);
  const fee = m[2] ? parseInt(m[2].replace(/,/g, ""), 10) : null;
  return { rent: rent >= 10_000 && rent <= 1_000_000 ? rent : null, managementFee: fee != null && fee < 100_000 ? fee : null };
}

// ═════════════════════════════════════════════════════════════════════════════
// /api/estimate-handoff の返す形（画面とサーバーで共用・サーバーの読み込みは estimate-handoff-server.ts）
// ═════════════════════════════════════════════════════════════════════════════
export type EstimateHandoffAccount = "sumora" | "ieyasu" | "giga";
export type EstimateHandoff = {
  conversationId: string;
  customerName: string;
  account: EstimateHandoffAccount;
  choice: EstimateTargetChoice;
  discount: DiscountSuggestion | null;
  pastDiscounts: number[];
  watch: {
    headline: string | null;
    stageLabel: string | null;
    summary: string | null;
    lowInitialCost: boolean;
    moveIn: string | null;
    latestCustomer: Array<{ at: string; text: string }>;
    sent: Array<{ at: string; label: string }>;
    brain: { action: string | null; note: string | null; replyDirection: string | null; decisionSource: string | null } | null;
    entry: EstimateEntry;
    conflicts: string[];
  };
};

