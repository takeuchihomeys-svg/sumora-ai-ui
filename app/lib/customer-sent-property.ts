// app/lib/customer-sent-property.ts
// お客様が自分で送ってきた物件（画像・ポータルの URL）を、そのお客様の物件検索ブレイン（🌟 の順位付け・DeepSeek）に
// 「好みの材料」として渡すための純関数（DB 依存なし・LLM なし）。サーバーの読み込みは customer-sent-property-server.ts。
//
// 2026-10-14 竹内さん「お客さんから送られてきた物件の画像や物件 URL はスコアリングの基準をつくるのにかなり有効なデータなので、
//   判断できたらお客さん毎の AIX ツールに転送すればよりよくなる」「まず画像が送られた時点で物件画像なら物件画像と判断させた方がよい
//   （本人確認書類と明確に分けるため）」
//
// 【受け取った時点の仕分け】は既にある（line-webhook → id-document-guard.imageTextForSave / image-label）:
//   本人確認書類・収入証明書・申込書は「[画像] 本人確認書類」等の種類だけ（書き起こしを保存しない）、物件の画像は
//   「[画像] 【物件の資料】\n…」の見出し、物件以外は「【物件以外：…】」、決まらない物は「【種類不明】」。
//   ここはその記録を**読むだけ**で、もう一度 LLM に画像を見せることはしない（画像そのものは一切外に出さない）。
//
// 【物件の流れへの線（P1・fail-closed）】customerImagePropertyGate:
//   ・見出しが物件（物件の資料・物件の画面・SNS の物件・物件の写真）の画像だけ通す。見積書・物件以外・種類不明・見出しの無い昔の行の
//     うち指紋で物件と言えない物は通さない（迷う物は通さない側＝個人情報側に倒す）
//   ・見出しが物件でも、書き起こしに個人情報の指紋（id-document-guard の身分証の指紋・personal-document-guard の書類・
//     生年月日・保険者番号・口座番号・マイナンバー 等）が1つでも当たれば通さない（Vision の分類を信用しきらない）
//   ・image_type が id_document / income_document の行・種類だけの書類の行は、本文を読む前に落とす
//   渡すのは書き起こしから決定論で取った**物件の値だけ**（物件名・家賃・管理費・間取り・㎡・駅と徒歩・築年）。書き起こしの全文は渡さない。
//
// 【向きはブレインが決める】お客様が「こういうのが良い」と送ったのか「これは無し」なのかはここで決めない（P0 9eb6aa9c: 判断はブレイン・
//   規則は候補の網と安全の線だけ）。物件の前後20分のお客様の一言（伏せ字を掛けて 80字まで）を添えて渡し、🌟 の DeepSeek が読む。
//
// 戻す: CUSTOMER_SENT_PROPERTY=off（🌟 に渡さない＝旧）
import { isIdDocument, ID_DOCUMENT_TEXT } from "./id-document-guard";
import { personalDocumentName, savedPersonalDocumentLabel } from "./personal-document-guard";
import { savedImageKind, imageKindGroup, classifyCustomerImage, stripImageLabel, personalHintIn, IMAGE_KIND_LABEL, type ImageKind } from "./image-label";
import { extractScreenshotProperty } from "./own-property-match";
import { isNotPropertyName } from "./not-property-words";
import { parseAccessLine } from "./listing-text";
import { portalSiteOf, type PortalPage } from "./portal-page-read";

export function customerSentPropertyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CUSTOMER_SENT_PROPERTY ?? "").trim().toLowerCase() !== "off";
}

export type CustomerSentFacts = {
  name: string | null;
  floor: number | null;
  rentYen: number | null;
  adminYen: number | null;
  madori: string | null;
  areaSqm: number | null;
  station: string | null;
  walk: number | null;
  /** 築年数（新築は 0） */
  ageYears: number | null;
};

export type CustomerSentProperty = CustomerSentFacts & {
  at: string | null;
  source: "image" | "url";
  /** 画像の見出しの種類（URL は null） */
  kind: ImageKind | null;
  url: string | null;
  /** SUUMO の掲載が終わっていた（ページが 404） */
  expired: boolean;
  /** 前後20分のお客様の一言（伏せ字済み・80字まで・無ければ null） */
  words: string | null;
};

export type GateResult = { ok: true; kind: ImageKind; body: string } | { ok: false; reason: "not_image" | "unread" | "personal" | "not_property" };

/** 書き起こしに当たったら物件の流れに出さない個人情報の語（身分証・書類の指紋の外側の網・物件の資料には出ない語だけ） */
const EXTRA_PERSONAL_RE = /生年月日|保険者番号|被保険者|記号\s*番号|口座番号|マイナンバー|個人番号|本籍|勤務先|年収|旅券番号|在留|免許証番号|印鑑登録|続柄|(?:お客様|契約者|申込者|入居者)(?:の)?(?:氏名|名前)/;

/**
 * お客様の画像（messages.text・image_type）が物件の流れ（好みの材料）に入ってよいか。
 * 迷う物・個人情報の指紋が1つでも当たる物は通さない（fail-closed）。
 */
export function customerImagePropertyGate(text: string | null | undefined, imageType: string | null | undefined): GateResult {
  const t = String(text ?? "").trim();
  if (!/^\[画像\]/.test(t)) return { ok: false, reason: "not_image" };
  const type = String(imageType ?? "").trim().toLowerCase();
  if (type === "id_document" || type === "income_document") return { ok: false, reason: "personal" };
  if (t === ID_DOCUMENT_TEXT || savedPersonalDocumentLabel(t)) return { ok: false, reason: "personal" };
  if (t === "[画像]") return { ok: false, reason: "unread" };
  const rawBody = t.replace(/^\[画像\]\s*/, "");
  const body = stripImageLabel(rawBody);
  if (!body.trim()) return { ok: false, reason: "unread" };
  // 個人情報の指紋は見出しより先に見る（見出しが物件でも落とす）
  if (isIdDocument(null, body) || personalDocumentName(null, body) || EXTRA_PERSONAL_RE.test(body.normalize("NFKC")) || personalHintIn(body)) return { ok: false, reason: "personal" };
  // 見出しがあればそれ（受け取った時点の仕分け）、無い昔の行は同じ関数で決め直す
  const kind = savedImageKind(t) ?? classifyCustomerImage(type, body);
  if (imageKindGroup(kind) !== "property") return { ok: false, reason: "not_property" };
  return { ok: true, kind, body };
}

const num = (s: string) => Number(s.normalize("NFKC").replace(/[,，\s]/g, ""));

/** 書き起こし・共有文から物件の値を取る（決定論。取れない値は null） */
export function factsFromPropertyText(text: string): CustomerSentFacts {
  const t = String(text ?? "").normalize("NFKC");
  const out: CustomerSentFacts = { name: null, floor: null, rentYen: null, adminYen: null, madori: null, areaSqm: null, station: null, walk: null, ageYears: null };
  const sp = extractScreenshotProperty(`[画像] ${t}`);
  // 「賃貸マンション 10階」のような種別の語・人の名前らしい語は物件名にしない
  if (sp?.name && !/^(?:賃貸|分譲)?\s*(?:マンション|アパート|一戸建て?|戸建て?|テラスハウス|ハイツ|コーポ|物件)$/.test(sp.name) && !isNotPropertyName(sp.name)) out.name = sp.name;
  // 家賃: 見出しの付いた値 → 無ければ最初の「N万円」
  const rl = t.match(/(?:賃料|家賃)[^\d\n]{0,8}([\d.,]+)\s*(万円|万|円)/);
  const r1 = rl ?? t.match(/(?<![\d.])([\d]{1,2}(?:\.\d{1,2})?)\s*(万円)/);
  if (r1) {
    const v = /万/.test(r1[2]) ? Math.round(num(r1[1]) * 10000) : num(r1[1]);
    if (Number.isFinite(v) && v >= 15_000 && v <= 600_000) out.rentYen = v;
  }
  const am = t.match(/(?:管理費|共益費)[^\d\n]{0,10}(?:([\d.,]+)\s*(万円|円)|(なし|無し|-))/);
  if (am) {
    if (am[3]) out.adminYen = 0;
    else { const v = am[2] === "万円" ? Math.round(num(am[1]) * 10000) : num(am[1]); if (Number.isFinite(v) && v >= 0 && v <= 100_000) out.adminYen = v; }
  }
  const md = t.match(/(?<![0-9A-Za-z])([1-5])\s*(SLDK|LDK|SDK|DK|SK|K|R)(?![A-Za-z])/) ?? (/ワンルーム/.test(t) ? ["", "1", "R"] : null);
  if (md) out.madori = `${md[1]}${md[2]}`;
  const ar = t.match(/([\d]{1,3}(?:\.\d{1,2})?)\s*(?:㎡|m²|m2|平米)/);
  if (ar) { const v = num(ar[1]); if (v >= 8 && v <= 250) out.areaSqm = v; }
  const fl = t.match(/(?<![\d])(\d{1,2})\s*階(?:部分)?(?!建)/);
  if (fl) { const v = num(fl[1]); if (v >= 1 && v <= 60) out.floor = v; }
  // 駅と徒歩: 「徒歩N分」のある行を交通の1行として読む（バスは除く・一番短い物）
  let best: { station: string; walk: number } | null = null;
  for (const line of t.split(/\n|\s\/\s|[|｜]/)) {
    if (!/(?:徒歩|歩)\s*\d{1,2}\s*分/.test(line)) continue;
    const a = parseAccessLine(line.replace(/^[\s*・\-]*(?:最寄り?駅?|交通|アクセス)\s*[:：]?\s*/, ""));
    if (!a || a.bus || a.walk == null) continue;
    // 「地下鉄堺筋線 恵美須町 徒歩5分」（「駅」も「」も無い形）は徒歩の直前の語を駅にする
    const station = a.station ?? (line.normalize("NFKC").match(/([^\s/／|｜]+?)\s*(?:駅)?\s*(?:徒歩|歩)\s*\d{1,2}\s*分/) ?? [])[1] ?? null;
    if (!station) continue;
    const st = station.replace(/^.*[\s:：/／]/, "").replace(/^[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]+/u, "").replace(/駅$/, "").trim();
    if (!st || st.length > 12 || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(st)) continue;
    if (!best || a.walk < best.walk) best = { station: st, walk: a.walk };
  }
  if (best) { out.station = best.station; out.walk = best.walk; }
  if (/新築/.test(t)) out.ageYears = 0;
  else { const ag = t.match(/築\s*(\d{1,2})\s*年/); if (ag) out.ageYears = num(ag[1]); }
  return out;
}

/** 名前の無い物件の重複の鍵（同じ値の掲載を別の URL で2回送った時に1件にする） */
const factsKey = (f: CustomerSentFacts) => `f:${f.rentYen}:${f.madori}:${f.areaSqm}:${f.station}:${f.walk}:${f.floor}`;
const hasAnyFact = (f: CustomerSentFacts) => !!(f.name || f.rentYen != null || f.madori || f.areaSqm != null || f.station);

/** 物件の URL（ポータル・業者のページ）か。動画・SNS・LINE・アプリの案内は物件の URL として扱わない */
export function propertyUrlsIn(text: string | null | undefined): string[] {
  return [...String(text ?? "").matchAll(/https?:\/\/[^\s）)」』]+/g)].map((m) => m[0]).filter((u) => portalSiteOf(u) !== null);
}

/** URL の共有文（SUUMO「物件名 3階 / URL / by SUUMO」・ニフティ「路線 駅 徒歩5分 / 1R 5.2万円 / URL」）の値。URL の行は除いて読む */
export function factsFromShareText(text: string): CustomerSentFacts {
  const t = String(text ?? "").split("\n").filter((l) => !/https?:\/\//.test(l) && !/^\s*by\s+SUUMO\s*$/i.test(l)).join("\n");
  const f = factsFromPropertyText(t);
  // 名前に間取りが入る物は建物名ではない（SUUMO の名前の無い掲載「西大橋 1LDK 4階」＝駅＋間取り＋階）→ 駅にする
  const LAYOUT_IN_NAME = /(?<![0-9A-Za-z])[1-5]?\s*(?:SLDK|LDK|SDK|DK|SK|K|R)(?![A-Za-z])|ワンルーム/;
  if (f.name && LAYOUT_IN_NAME.test(f.name.normalize("NFKC"))) f.name = null;
  const first = (t.split("\n").map((l) => l.trim()).find(Boolean) ?? "").normalize("NFKC");
  const st = first.match(/^([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,10})\s+[1-5]\s*(?:SLDK|LDK|SDK|DK|SK|K|R)(?![A-Za-z])/u);
  if (st && !f.station) f.station = st[1].replace(/駅$/, "");
  // SUUMO の1行目「物件名 3階」（extractScreenshotProperty は号室の無い「N階」を名前として返す）
  if (!f.name && !st) {
    const m = first.match(/^(.{2,40}?)\s+(\d{1,2})\s*階\s*$/);
    if (m && !/徒歩|万円|駅/.test(m[1]) && !LAYOUT_IN_NAME.test(m[1])) { f.name = m[1].trim(); f.floor = num(m[2]); }
  }
  return f;
}

type Msg = { sender?: string | null; text?: string | null; image_type?: string | null; created_at?: string | null };

const WORDS_WINDOW_MS = 20 * 60_000;
/** 一言に使う発言か（画像・URL だけ・スタンプ・ファイルは除く） */
function isWords(m: Msg): boolean {
  const t = String(m.text ?? "").trim();
  if (!t || /^\[(?:画像|スタンプ|ファイル)\]/.test(t)) return false;
  const noUrl = t.replace(/https?:\/\/\S+/g, "").replace(/by\s+SUUMO/gi, "").trim();
  // 条件のフォーマット（①【ご入居の時期】…）のような長い発言は一言にしない（物件への反応ではない・材料が長くなる）
  return noUrl.length >= 2 && noUrl.length <= 120;
}

/**
 * お客様が送ってきた物件を新しい順に集める（純関数）。
 * @param msgs 会話の発言（古い順）。呼び出し側で DeepSeek に渡してよい範囲（申込の線より後）に絞ってから渡すこと
 * @param pages URL ごとに読んだポータルのページ（無くてよい）
 * @param mask 一言の伏せ字（サーバーは maskPII）
 */
export function collectCustomerSentProperties(
  msgs: ReadonlyArray<Msg>,
  opts: { limit?: number; pages?: ReadonlyMap<string, PortalPage>; mask?: (s: string) => string } = {},
): { items: CustomerSentProperty[]; stats: { images: number; propertyImages: number; personal: number; notProperty: number; unread: number; urls: number } } {
  const limit = opts.limit ?? 6;
  const mask = opts.mask ?? ((s: string) => s);
  const stats = { images: 0, propertyImages: 0, personal: 0, notProperty: 0, unread: 0, urls: 0 };
  const cust = msgs.filter((m) => m.sender === "customer");
  // 一言は時刻の近い順に2通まで（物件の共有文そのもの＝URL つきの発言は一言にしない）。後の発言を先に（物件への反応のことが多い）
  const wordsAround = (at: string | null): string | null => {
    const t0 = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t0)) return null;
    const near = cust.map((m) => ({ m, t: Date.parse(m.created_at ?? "") }))
      .filter(({ m, t }) => Number.isFinite(t) && Math.abs(t - t0) <= WORDS_WINDOW_MS && isWords(m) && propertyUrlsIn(m.text).length === 0)
      .sort((a, b) => Math.abs(a.t - t0) + (a.t < t0 ? 60_000 : 0) - (Math.abs(b.t - t0) + (b.t < t0 ? 60_000 : 0)))
      .slice(0, 2).sort((a, b) => a.t - b.t);
    const ws = near.map(({ m }) => String(m.text ?? "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim());
    if (!ws.length) return null;
    const joined = mask(ws.join(" ／ "));
    return joined.length > 80 ? joined.slice(0, 80) + "…" : joined;
  };
  const out: CustomerSentProperty[] = [];
  const seen = new Set<string>();
  for (const m of [...cust].reverse()) {
    const text = String(m.text ?? "");
    const at = m.created_at ?? null;
    if (/^\s*\[画像\]/.test(text)) {
      stats.images++;
      const g = customerImagePropertyGate(text, m.image_type);
      if (!g.ok) { if (g.reason === "personal") stats.personal++; else if (g.reason === "unread") stats.unread++; else stats.notProperty++; continue; }
      stats.propertyImages++;
      const f = factsFromPropertyText(g.body);
      if (!hasAnyFact(f)) continue;
      const key = f.name ? `n:${f.name}` : factsKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length < limit) out.push({ ...f, at, source: "image", kind: g.kind, url: null, expired: false, words: wordsAround(at) });
      continue;
    }
    const urls = propertyUrlsIn(text);
    if (!urls.length) continue;
    stats.urls += urls.length;
    const share = factsFromShareText(text);
    for (const url of urls) {
      const p = opts.pages?.get(url);
      const f: CustomerSentFacts = p && p.status === "ok"
        ? { name: p.name ?? share.name, floor: p.floor ?? share.floor, rentYen: p.rentYen ?? share.rentYen, adminYen: p.adminYen ?? share.adminYen, madori: p.madori ?? share.madori, areaSqm: p.areaSqm ?? share.areaSqm, station: p.station ?? share.station, walk: p.walk ?? share.walk, ageYears: share.ageYears }
        : share;
      const expired = p?.status === "expired";
      if (!hasAnyFact(f)) continue;
      const key = f.name ? `n:${f.name}` : factsKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length < limit) out.push({ ...f, at, source: "url", kind: null, url, expired, words: wordsAround(at) });
    }
  }
  return { items: out, stats };
}

/**
 * DeepSeek に渡す発言の中の画像の行を、線を通した形に直す（純関数）。毎週の好みの読み（pref_read_customer）が使う。
 * 2026-10-14 調べて分かった道: 毎週の読みはお客様の発言を**画像の書き起こしごと** DeepSeek に渡していた（申込の線より後の 60日）。
 *   本人確認書類・収入証明書は受け取った時点で種類だけなので中身は出ていないが、【種類不明】・見出しの無い昔の行の書き起こし
 *   （重説の写真のお客様の氏名など）はそのまま出ていた。
 *   ・物件の画像（線を通った物）→「[画像] 【物件の画面（ポータル）】 7.2万円・1K・26.75㎡・築12年」（物件の値だけ＝好みの材料にもなる）
 *   ・種類だけの書類（本人確認書類 等）→ そのまま（中身はもう無い）
 *   ・それ以外の画像 →「[画像] 【見出し】」だけ（書き起こしは渡さない）
 *   戻す: CUSTOMER_PREF_IMAGE_GATE=off（書き起こしごと渡す旧）
 */
export function imageTextForDeepSeekRead(text: string, imageType: string | null | undefined, env: Record<string, string | undefined> = process.env): string {
  if ((env.CUSTOMER_PREF_IMAGE_GATE ?? "").trim().toLowerCase() === "off") return text;
  const t = String(text ?? "").trim();
  if (!/^\[画像\]/.test(t)) return text;
  if (t === "[画像]" || t === ID_DOCUMENT_TEXT || savedPersonalDocumentLabel(t)) return t;
  const g = customerImagePropertyGate(t, imageType);
  if (g.ok) {
    const f = factsLabel(factsFromPropertyText(g.body));
    return `[画像] 【${IMAGE_KIND_LABEL[g.kind]}】${f ? ` ${f}` : ""}`;
  }
  if (g.reason === "personal") return "[画像] 【物件以外：個人情報の載った画像】";
  const k = savedImageKind(t);
  return `[画像] 【${IMAGE_KIND_LABEL[k ?? "unknown"]}】`;
}

const man = (yen: number) => `${(Math.round(yen / 1000) / 10).toString()}万円`;

/** 1件の値の文（「プルス新北野 3階・6.9万円（管理費 6000円）・1LDK・35㎡・新大阪 徒歩7分・築5年」） */
export function factsLabel(f: CustomerSentFacts): string {
  const parts = [
    f.name ? `${f.name}${f.floor != null ? ` ${f.floor}階` : ""}` : f.floor != null ? `${f.floor}階` : null,
    f.rentYen != null ? `${man(f.rentYen)}${f.adminYen != null ? `（管理費 ${f.adminYen === 0 ? "なし" : `${f.adminYen.toLocaleString()}円`}）` : ""}` : null,
    f.madori,
    f.areaSqm != null ? `${f.areaSqm}㎡` : null,
    f.station ? `${f.station}${f.walk != null ? ` 徒歩${f.walk}分` : ""}` : null,
    f.ageYears != null ? (f.ageYears === 0 ? "新築" : `築${f.ageYears}年`) : null,
  ].filter(Boolean);
  return parts.join("・");
}

const mdOf = (at: string | null) => {
  const d = at ? new Date(Date.parse(at) + 9 * 3600_000) : null;
  return d && Number.isFinite(d.getTime()) ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : "";
};

/** 🌟 の順位付けに渡すブロック（無ければ null）。向き（良い／無し）は書かない＝DeepSeek が一言から読む */
export function customerSentPropertyBlock(items: ReadonlyArray<CustomerSentProperty>): string | null {
  if (!items.length) return null;
  const lines = items.map((it) => {
    const src = it.source === "url" ? "URL" : `画像（${IMAGE_KIND_LABEL[it.kind ?? "property_material"]}）`;
    const w = it.words ? ` ／ その時のお客様の一言「${it.words}」` : " ／ 一言なし";
    return `- ${mdOf(it.at)} ${src}: ${factsLabel(it)}${it.expired ? "（掲載終了）" : ""}${w}`;
  });
  return `【お客様が自分で送ってきた物件（好みの参考）】
お客様が気に入って送った物か、無しと言った物かは、その時の一言から読むこと（一言が無い・読めない時は「気になっている物件」として参考程度）。
希望条件より弱く扱い、条件に合う物件の中で近い物（家賃・間取り・広さ・駅・築年）を上にする材料にだけ使うこと。
${lines.join("\n")}`;
}
