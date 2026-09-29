// scripts/audit-condition-pollution.ts — お客様の条件の欄に「物件の問い合わせ・申込フォーム・スタッフの提案」が混ざっていないかの監査（読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-pollution.ts [--days=180] [--show=4] [--out=x.json]
//
// 2026-09-29 竹内（黒明さん事例）「エリアに『4階のお部屋・11階のお部屋』が入っている。SUUMO でこの物件空いてるかって送られてきた物件で、
//   お客さんが希望している条件でない。西中島南方も希望の条件じゃない。反映する部分の能力がかなり低い。根本的な部分。
//   お客さんの条件か、ただ物件 SUUMO 等のサイト送ってきているだけか等」
//
// 見る物（お客様の名前・電話は出さない。お客様 ID は先頭8文字だけ・発言は60字まで）:
//   A. 希望エリア（desired_area）の語ごとの出所: 条件フォームの原文／お客様の条件の発言／物件の問い合わせ（号室・空いて・SUUMO・○階の部屋）／
//      画像の書き起こし（物件のスクショ）／申込・審査の書類（勤務先所在地 等）／スタッフの発言だけ／どこにも無い
//      → ①本物の希望 ②混入 ③判断つかず。形（○階・号室・建物名・文の断片）で明らかに地名でない語も②
//   B. その語を書いた経路の推定: 条件の履歴（property_condition_history・書く経路は P4／カジュアル更新／条件ブレイン／画面の編集）の有無 ×
//      新着要望のログ（additional_conditions の [..|auto]）の有無 × 元の発言の形（地域指定の判定 isAreaSpecificationMessage と同じ式）
//   C. その他の欄（other_requests・preferences・ng_points）に入った「物件の話・依頼」の節（号室・○階の方・この物件・抑えつつ・新着でご連絡 等）
//   D. 検索への影響: 混入した駅が search_audits の intended.station_names / intent.stations に入った回・
//      本物の区があるのに区が検索から落ちた回（area_mode=station で city_codes 空）
//   E. 見分けの材料と誤爆の形: お客様の発言の形ごとに「その後10分以内に希望エリアが変わった」件数、
//      「11階以上」「2階以上」等の本物の階の条件がどの欄に入ったか、条件の発言と物件の問い合わせが1通に同居した数
//   D2. 本物の区があるのに area_mode=station（inferAreaMode「駅が1つでも含まれれば station」）で、駅の語が本物でない人
//   E2. 形ごとの原文（N階のお部屋・本物の階の条件・上の階・駅＋徒歩N分）を目で読む
//   F. 入口の判定（isFormatMessage → isPropertySiteUrl → 物件情報の形 → 地域指定の形）を過去の発言に当てる
//   H. Path C が実際に動いた回（llm_usage_logs の /api/resolve-area・2026-09-14 14:11 UTC〜）と発言の種類
//   経路の裏付け（B）: 履歴の直前の LLM 呼び出し（line-webhook＝P4／bg-async＝条件ブレイン／なし＝画面の編集）、履歴の無い語は
//      発言の直後の resolve-area（Path C）・bg-async（ブレインの橋＝上書き・履歴なし）
//   申込・審査の書類は本文を出さない（safe()）。
//
// 2026-09-29 監査の目視（②混入 23語 → 目で見直し）: 「本町」（dbb2c263・建物名の一部だがお客様が本町の物件を検討中）・
//   「大阪市中央区」（4fd690b9・スタッフが「ご希望の大阪市中央区エリアで」と書いている＝電話等で聞いた希望の可能性）・
//   「西区(阿波座」（67b17b10・スタッフの宣言の括弧が「・」で割れた断片）の4語は③に読むのが妥当。残り19語が混入
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import { isKnownStation, normStation, normWard, wardOfStation, STATION_LINES } from "../app/lib/osaka-geo";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "180"));
const SHOW = Number(arg("show", "4"));
const OUT = arg("out");
const YUMA_CUSTOMER = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";

async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let a = 0; ; a += 1000) { const { data, error } = await q(a, a + 999); if (error) throw new Error(error.message); out.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  return out;
}
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const nf = (s: unknown) => String(s ?? "").normalize("NFKC");
const cut = (s: string, n = 60) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const id8 = (s: string) => s.slice(0, 8);
/** 申込・審査の書類は本文を出さない（氏名・生年月日・電話・住所が入る）。地名の語だけ出す。電話・郵便番号の形も伏せる */
function safe(s: string, n = 60): string {
  const t = nf(s);
  if (isApplyForm(t)) {
    const geo = [...new Set(t.match(/(?:勤務先所在地|所在地)[^\n・]{0,24}|[一-鿿ァ-ヶ]{1,8}駅(?:最寄り)?/g) ?? [])].slice(0, 4);
    return `〔申込・審査の書類（本文は出さない）: ${geo.map((g) => g.replace(/[0-9]/g, "＊")).join(" / ") || "地名の語なし"}〕`;
  }
  return cut(t.replace(/\d{2,5}-?\d{2,4}-?\d{3,4}/g, "＊＊＊").replace(/〒\s*\d{3}-?\d{4}/g, "〒＊＊＊"), n);
}
/** 語の前後だけ切り出す（元の発言の該当箇所を見せる） */
function around(s: string, words: string[], n = 90): string {
  const t = nf(s);
  if (isApplyForm(t)) return safe(t);
  const i = words.map((w) => t.indexOf(w)).filter((x) => x >= 0).sort((a, b) => a - b)[0];
  if (i === undefined || i < n / 2) return safe(t, n);
  return "…" + safe(t.slice(Math.max(0, i - 30)), n);
}

// ── 形（語そのもの）──────────────────────────────────────────────
/** 希望エリアの語に入っていたら地名ではない形 */
const SHAPE_RES: Array<[string, RegExp]> = [
  ["階（○階・○階のお部屋）", /[0-9一二三四五六七八九十]+階/],
  ["号室・部屋・物件", /号室|のお部屋|の部屋|この物件|物件$/],
  ["URL・ポータル", /https?:|suumo|homes|athome|chintai|\.jp\b|\.com\b/i],
  ["文の断片（空いて・抑え・入居・ご連絡 等）", /空いて|抑え|入居|連絡|したい|です|ます|ください|この|その|良かった/],
  ["建物名らしい", /レジデンス|レジュール|コート|ハイツ|マンション|メゾン|プレサンス|アパート|ハイム|コーポ|ヴィラ|ドーム|タワー|LUXE|Luxe|グラン|ラグゼ|エスリード|セレニテ|アドバンス|スプランディッド|フィオーレ|ビル$|荘$/],
];
function shapeOf(tok: string): string | null {
  const t = nf(tok).replace(/[（(][^）)]*[）)]/g, ""); // 括弧の補足（「(2路線以上使えるとありがたい)」）は形に数えない
  for (const [k, re] of SHAPE_RES) if (re.test(t)) return k;
  return null;
}
/** 語の芯（駅・区の照合用） */
function coreOf(tok: string): string {
  return nf(tok).replace(/^大阪府/, "").replace(/[（(][^）)]*[）)]/g, "").replace(/(周辺|エリア|付近|沿線|辺り|あたり|方面|全域|近辺|界隈)$/g, "").replace(/駅$/, "").trim();
}
function splitArea(s: string | null | undefined): string[] {
  return nf(s).split(/[・、,，/／\s]+|\bor\b|または|もしくは/).map((t) => t.trim()).filter((t) => t.length > 0);
}
function geoKind(core: string): "ward" | "station" | "line" | "other" {
  if (/線$/.test(core)) return "line";
  if (/[区市町]$/.test(core) && normWard(core)) return "ward";
  if (isKnownStation(core)) return "station";
  if (normWard(core)) return "ward";
  return "other";
}
/** 照合用の別の書き方（大阪市西区 → 西区・西） */
function variants(core: string): string[] {
  const v = new Set<string>([core]);
  const w = core.replace(/^大阪市/, ""); v.add(w);
  if (/区$/.test(w) && w.length >= 2) v.add(w.replace(/区$/, "") + "区");
  const st = normStation(core); if (st) v.add(st);
  return [...v].filter((x) => x === core || x.length >= 2);
}

// ── 発言の形（元の通）────────────────────────────────────────────
const IMAGE_RE = /^\s*\[画像\]/;
/** 申込・審査の書類（勤務先の所在地・現住所 等）。条件ではない */
const APPLY_FORM_RE = /勤務先|勤続|年収|緊急連絡先|現住所|生年月日|雇用形態|保険種類|連帯保証人|本籍|続柄|在籍|転職先|ご転職|申込者|お申込者/;
/** 申込・審査の書類: 書類の見出しの語が2種類以上（「勤務先の近く」1語だけの条件の発言を書類と読まない） */
function isApplyForm(t: string): boolean {
  return new Set(t.match(new RegExp(APPLY_FORM_RE.source, "g")) ?? []).size >= 2;
}
/** その他の欄の節が「物件の話・依頼」か（「初期費用を抑えたい」は本物の要望なので除く） */
function isPropertyTalkClause(cl: string): boolean {
  if (!PROPERTY_TALK_CLAUSE_RE.test(cl)) return false;
  const strong = /号室|[0-9一二三四五六七八九十]+階の(?:方|お部屋|部屋|物件)|(?:この|こちらの|その)(?:物件|お部屋|部屋)|物件名|空いて|内見|内覧|新着で|オススメ物件|おすすめ物件|ご連絡|SUUMO|suumo|https?:|抑えつつ|押さえ/;
  return strong.test(cl);
}
/** 物件の問い合わせ（1件の物件を指す） */
const PROPERTY_INQUIRY_RES: Array<[string, RegExp]> = [
  ["URL（物件サイト）", /https?:\/\/\S*(suumo|homes|athome|chintai|able|minimini|apamanshop|eheya|door|smocca|ielove|realestate|mansion-review|goodrooms)/i],
  ["URL（その他）", /https?:\/\//],
  ["号室", /[0-9０-９]{2,4}\s*号室|号室/],
  ["○階の部屋・○階の方", /[0-9０-９一二三四五六七八九十]+階の(?:お)?(?:部屋|方|物件)/],
  ["空いてますか・空室・募集中か", /空いて(?:ます|い|る|おり)|空室|募集(?:中|して|出て)|まだあり/],
  ["この物件・このお部屋", /(?:この|こちらの|その|あの)(?:物件|お部屋|部屋)/],
  ["物件名・建物名", /物件名|レジデンス|レジュール|マンション|メゾン|プレサンス|エステムコート|アドバンス|ハイツ|ラグゼ|セレニテ|エスリード|スプランディッド|LUXE|Luxe/],
  ["1件の家賃・間取り（万円/管理費・間取り：）", /万円\s*\/\s*管理費|間取り\s*[:：]|広さ\s*[:：]|築年(?:数|月)\s*[:：]/],
  ["内見・内覧・抑えて", /内見|内覧|抑えて|押さえて|申し込み|申込/],
];
function inquiryShapes(t: string): string[] {
  const s = nf(t);
  return PROPERTY_INQUIRY_RES.filter(([, re]) => re.test(s)).map(([k]) => k);
}
/** 条件フォーム（うちのフォーマット・お客様が自分で書いた条件の一覧） */
const CONDITION_FORM_RE = /入居の時期|希望の家賃|ご希望の家賃|希望の広さ|ご希望のエリア|希望エリア|希望の地域|希望駅|お部屋探しご条件|下記条件|条件で(?:物件|お部屋)/;
/** 条件の言葉（問い合わせと同居しているか） */
const COND_WORDS_RE = /(?:で|を|も)探して|探しています|希望|条件|以内|以下|以上|エリア|周辺|予算|あたり|辺り/;
type MsgKind = "image" | "inquiry" | "condition_form" | "apply_form" | "mixed" | "condition";
/** お客様の1通の種類（順番が大事: 画像 → ポータルの貼り付け・URL → 条件フォーム → 申込の書類 → 問い合わせ（条件の言葉と同居なら mixed）→ 条件の発言） */
function msgKind(text: string): MsgKind {
  const t = nf(text);
  if (IMAGE_RE.test(t)) return "image";
  if (PROPERTY_LISTING_SHAPE_RE.test(t) || PROPERTY_SITE_URL_RE.test(t)) return COND_WORDS_RE.test(t.replace(/https?:\/\/\S+/g, "").replace(/物件名[\s\S]*/, "")) ? "mixed" : "inquiry";
  if (CONDITION_FORM_RE.test(t) && !isApplyForm(t)) return "condition_form";
  if (isApplyForm(t)) return "apply_form";
  if (inquiryShapes(t).length) return COND_WORDS_RE.test(t) ? "mixed" : "inquiry";
  return "condition";
}
/** スタッフの1通が物件の文（🌟物件名・号室・駅徒歩・見積の【物件名】）か */
const STAFF_PROPERTY_RE = /🌟|号室|「[^」]{1,12}」駅\s*徒歩|【[^】]{2,40}】/;
/** line-webhook の isPropertySiteUrl（app/api/parse-condition-url）と同じ: 最初の URL の host が5つのサイトの時だけ（複製・読むだけ） */
const KNOWN_PROPERTY_SITES = ["suumo.jp", "homes.co.jp", "chintai.net", "athome.co.jp", "lifull.com"];
function isPropertySiteUrlLikeProd(text: string): boolean {
  const m = text.match(/https?:\/\/[^\s]+/); if (!m) return false;
  try { const h = new URL(m[0]).hostname; return KNOWN_PROPERTY_SITES.some((s) => h.includes(s)); } catch { return false; }
}
/** 物件のポータル・物件ページの URL（本番の5サイトより広い・監査用） */
const PORTAL_HOST_RE = /suumo|homes\.co\.jp|chintai|athome|lifull|nifty|realestate\.yahoo|smocca|pethomeweb|sumaity|eheya|canary|pitat|realnetpro|house\.goo|iimon|homemate|shamaison|sumaisagashi|oshimaland|izumi-realestate|zkss|actrus|able\.co|minimini|apamanshop|door\.ac|ielove/i;

/** 本物の階の条件（誤爆しやすい形） */
const REAL_FLOOR_COND_RE = /[0-9一二三四五六七八九十]+階以上|[0-9一二三四五六七八九十]+階より上|高層階|上の階|1階(?:は)?(?:NG|嫌|不可|避け|以外)|2階以上/;

/** line-webhook-text.ts isAreaSpecificationMessage と同じ式（複製・読むだけの監査のため。変えたら両方）*/
const PROPERTY_LISTING_SHAPE_RE = /(?:物件名|交通|所在地|価格|物件種目)\s*[:：][\s\S]*(?:物件名|交通|所在地|価格|物件種目)\s*[:：]/;
const PROPERTY_SITE_URL_RE = new RegExp("https?://[^\\s]*(?:" + PORTAL_HOST_RE.source + ")", "i");
function looksLikeAreaSpec(text: string): boolean {
  if (isFormatMessageLikeProd(text)) return false;
  if (PROPERTY_LISTING_SHAPE_RE.test(text) || isPropertySiteUrlLikeProd(text)) return false;
  return looksLikeAreaSpecNoUrl(text);
}
/** line-webhook-text.ts isFormatMessage と同じ式（複製・読むだけ。変えたら両方）。true なら Path C は動かない（正式フォーマット／カジュアル更新の経路） */
function isFormatMessageLikeProd(text: string): boolean {
  if (PROPERTY_LISTING_SHAPE_RE.test(text)) return false;
  if (isPropertySiteUrlLikeProd(text)) {
    const textOnly = text.replace(/https?:\/\/[^\s]+/g, "").trim();
    if (textOnly.length < 15) return false;
    if (!["変えたい", "変更", "に変えて", "修正", "更新", "追加", "も見たい", "広げ", "せばめ"].some((k) => textOnly.includes(k))) return false;
    return isFormatMessageLikeProd(textOnly);
  }
  if ((text.match(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]/g) ?? []).length >= 2) return true;
  const conditionKeywords = ["入居時期", "希望家賃", "家賃", "希望地域", "希望エリア", "間取り", "徒歩", "初期費用", "築年数", "エリア", "LDK", "DK", "1K", "2K", "3K", "1R",
    "万以内", "万円以内", "万円まで", "万に", "万円に", "以下", "以内", "㎡", "平米", "ペット可", "ペット不可", "駐車場", "独立洗面", "バストイレ別",
    "オートロック", "駅近", "築浅", "築", "NG", "希望条件", "こだわり", "区", "市", "駅"];
  const changeKeywords = ["変えたい", "変更", "に変えて", "に変更", "にしたい", "にしてほしい", "やっぱり", "修正", "更新", "に変わ", "に移", "広げ", "せばめ", "上げ", "下げ", "にしようかな",
    "は無し", "はなし", "除外", "やめ", "外して", "抜い", "追加", "も見たい", "も含め", "も良い", "もOK", "も可", "もあり"];
  const condMatches = conditionKeywords.filter((k) => text.includes(k)).length;
  if (changeKeywords.some((k) => text.includes(k)) && condMatches >= 1) return true;
  if (condMatches >= 2) {
    const GENERIC = ["区", "市", "駅", "築", "NG", "以下", "以内"];
    return conditionKeywords.some((k) => !GENERIC.includes(k) && text.includes(k)) || /[0-9０-９一二三四五六七八九十]/.test(text);
  }
  return false;
}
function looksLikeAreaSpecNoUrl(text: string): boolean {
  if (/自転車|チャリ/.test(text) && /\d+分/.test(text)) return true;
  const adminMatches = text.match(/[^\s]{1,6}[都道府県市区町村]/g) ?? [];
  const hasTrigger = /辺り|あたり|周辺|エリア|で探|でも探|も探|希望|沿線/.test(text);
  const hasStationWord = /[一-鿿a-zA-Zａ-ｚＡ-Ｚァ-ヶ]{1,10}駅/.test(text);
  const hasLineName = /[一-鿿ァ-ヶ]{2,10}線/.test(text);
  const hasLinePrefix = /(?:阪急|阪神|JR|近鉄|京阪|南海|大阪メトロ|地下鉄|東急|小田急|京王|西武|東武|東京メトロ|都営)[\S]{1,8}/.test(text);
  const hasPlaceWithSuffix = /[一-鿿ァ-ヶ]{1,8}(?:あたり|周辺|エリア|沿線|辺り)/.test(text);
  const hasAreaAddRequest = /[一-鿿]{1,6}[区市](?:も|をお願い|もお願い)/.test(text);
  return adminMatches.length >= 2 || (adminMatches.length >= 1 && (hasTrigger || hasAreaAddRequest)) || hasStationWord || hasLineName || hasLinePrefix || hasPlaceWithSuffix;
}

/** その他の欄に入った「物件の話・依頼」の節 */
const PROPERTY_TALK_CLAUSE_RE = /号室|[0-9一二三四五六七八九十]+階の(?:方|お部屋|部屋|物件)|(?:この|こちらの|その)(?:物件|お部屋|部屋)|抑え(?:つつ|て|た)|押さえ|ご連絡(?:いただき|頂き|ください|下さい)|オススメ物件|おすすめ物件|新着で|物件名|空いて|内見|内覧|SUUMO|suumo|https?:/;

type Cust = { id: string; desired_area: string | null; other_requests: string | null; preferences: string | null; ng_points: string | null; raw_format_text: string | null; additional_conditions: string | null; area_mode: string | null; updated_at: string };
type Conv = { id: string; property_customer_id: string; status: string | null; line_user_id: string | null };
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
type Hist = { property_customer_id: string; changed_field: string; old_value: string | null; new_value: string | null; source_message_id: string | null; created_at: string };
type Audit = { id: number; property_customer_id: string; created_at: string; site: string; mode: string | null; trigger: string | null; area_mode: string | null; intended: { station_names?: string[]; city_codes?: string[]; unknown_tokens?: string[] | null } | null; intent: { stations?: string[]; wards?: string[] } | null };

type TokenFinding = {
  pc: string; token: string; core: string; geo: string; shape: string | null;
  verdict: "①本物" | "①本物（区・路線の駅に展開）" | "②混入" | "③判断つかず";
  why: string; source?: { at: string; kind: string; text: string };
  path: string; firstSeenAt: string | null;
  searchHits: number; searchHitsAfter: number;
};

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const custs = (await all<Cust>((a, b) => sb.from("property_customers")
    .select("id, desired_area, other_requests, preferences, ng_points, raw_format_text, additional_conditions, area_mode, updated_at").range(a, b) as never))
    .filter((c) => c.id !== YUMA_CUSTOMER);
  const convs = await all<Conv>((a, b) => sb.from("conversations").select("id, property_customer_id, status, line_user_id").not("property_customer_id", "is", null).range(a, b) as never);
  const convsOf = new Map<string, Conv[]>();
  for (const c of convs) convsOf.set(c.property_customer_id, [...(convsOf.get(c.property_customer_id) ?? []), c]);
  const pcOfConv = new Map(convs.map((c) => [c.id, c.property_customer_id]));
  const msgsOf = new Map<string, Msg[]>();
  for (const ids of chunks(convs.map((c) => c.id), 40)) {
    const rows = await all<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", ids).gte("created_at", since).order("created_at", { ascending: true }).range(a, b) as never);
    for (const r of rows) { const pc = pcOfConv.get(r.conversation_id); if (!pc || !r.text) continue; (msgsOf.get(pc) ?? msgsOf.set(pc, []).get(pc)!).push(r); }
  }
  const hist = await all<Hist>((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, new_value, source_message_id, created_at").gte("created_at", since).order("created_at", { ascending: true }).range(a, b) as never);
  const histOf = new Map<string, Hist[]>();
  for (const h of hist) (histOf.get(h.property_customer_id) ?? histOf.set(h.property_customer_id, []).get(h.property_customer_id)!).push(h);
  const audits = await all<Audit>((a, b) => sb.from("search_audits").select("id, property_customer_id, created_at, site, mode, trigger, area_mode, intended, intent").gte("created_at", since).range(a, b) as never);
  // 書いた経路の裏付け: LLM の呼び出しの記録（llm_usage_logs・9/14〜全リクエスト）。P4 は /api/line-webhook の Haiku、Path C は /api/resolve-area、
  //   ブレインの橋・条件ブレインは /api/generate-draft-bg-async。画面の編集・拡張の保存は LLM を呼ばない
  const LLM_SINCE = "2026-09-14T14:12:00Z"; // 記録の最初の行（2026-09-14 14:11 UTC）より前は裏付けなし
  const llm = (await all<{ created_at: string; route: string | null }>((a, b) => sb.from("llm_usage_logs").select("created_at, route").gte("created_at", since > LLM_SINCE ? since : LLM_SINCE).order("created_at").range(a, b) as never))
    .map((r) => ({ at: Date.parse(r.created_at), route: r.route ?? "" }));
  /** t の前 beforeMs〜後 afterMs に route の呼び出しがあったか */
  const llmNear = (t: number, route: string, beforeMs: number, afterMs: number) => llm.some((r) => r.route === route && r.at >= t - beforeMs && r.at <= t + afterMs);
  const auditsOf = new Map<string, Audit[]>();
  for (const x of audits) (auditsOf.get(x.property_customer_id) ?? auditsOf.set(x.property_customer_id, []).get(x.property_customer_id)!).push(x);

  const msgCount = [...msgsOf.values()].reduce((s, a) => s + a.length, 0);
  console.log(`お客様 ${custs.length}人（YUMA 除く）・会話 ${convs.length}・${DAYS}日の発言 ${msgCount}通・条件の履歴 ${hist.length}行（source_message_id あり ${hist.filter((h) => h.source_message_id).length}）・検索の点検 ${audits.length}回`);

  // ── A/B/D: 希望エリアの語ごと ───────────────────────────────────
  const findings: TokenFinding[] = [];
  for (const c of custs) {
    const toks = splitArea(c.desired_area);
    if (!toks.length) continue;
    const msgs = msgsOf.get(c.id) ?? [];
    const raw = nf(c.raw_format_text);
    const rawKind: MsgKind = raw ? msgKind(raw) : "condition";
    const addl = nf(c.additional_conditions);
    const hs = (histOf.get(c.id) ?? []).filter((h) => h.changed_field === "desired_area");
    const au = auditsOf.get(c.id) ?? [];
    // 本物の区・路線（条件フォーム・お客様の条件の発言にある物）— 区の中の駅・路線の駅への展開を見分ける
    const genuineWards = new Set<string>();
    const condMsgs = msgs.filter((m) => m.sender === "customer" && ["condition", "condition_form"].includes(msgKind(m.text!)));
    const condCorpus = [raw, ...condMsgs.map((m) => nf(m.text))].join("\n");
    for (const t of toks) {
      const core = coreOf(t); if (geoKind(core) !== "ward") continue;
      if (variants(core).some((v) => condCorpus.includes(v))) { const w = normWard(core); if (w) genuineWards.add(w); }
    }
    const genuineLines = new Set((condCorpus.match(/[一-鿿ァ-ヶ]{2,8}線/g) ?? []).map((l) => l.replace(/^(大阪メトロ|地下鉄|JR|阪急|阪神|京阪|近鉄|南海)/, "")).filter((l) => l.length >= 3));
    for (const t of toks) { const m = coreOf(t).match(/([一-鿿ァ-ヶ]{2,8}線)/); if (m && condCorpus.includes(m[1])) genuineLines.add(m[1]); }
    for (const tok of toks) {
      const core = coreOf(tok);
      if (!core) continue;
      const geo = geoKind(core);
      const shape = geo === "other" || geo === "line" ? shapeOf(tok) : (shapeOf(tok) === "建物名らしい" ? null : shapeOf(tok));
      const vs = variants(core);
      const has = (s: string) => vs.some((v) => nf(s).includes(v));
      const inRaw = has(raw);
      const cust = msgs.filter((m) => m.sender === "customer" && has(m.text!));
      const staff = msgs.filter((m) => m.sender === "staff" && has(m.text!));
      const byKind = (k: MsgKind) => cust.filter((m) => msgKind(m.text!) === k);
      const image = byKind("image");
      const form = byKind("apply_form");
      const inquiry = byKind("inquiry");
      const mixed = byKind("mixed");
      const cond = [...byKind("condition"), ...byKind("condition_form")];
      const staffProp = staff.filter((m) => STAFF_PROPERTY_RE.test(nf(m.text)));
      const staffScope = staff.filter((m) => !STAFF_PROPERTY_RE.test(nf(m.text)));
      const lineExpanded = geo === "station" && (STATION_LINES.get(normStation(core)) ?? []).some((l) => [...genuineLines].some((g) => l.includes(g)));
      // 初めて入った時（履歴で old に無く new にある最初の行）
      const firstHist = hs.find((h) => has(h.new_value ?? "") && !has(h.old_value ?? ""));
      const inAnyHist = hs.some((h) => has(h.new_value ?? ""));
      let verdict: TokenFinding["verdict"]; let why: string; let source: TokenFinding["source"];
      const pick = (arr: Msg[], kind: string) => { const m = firstHist ? [...arr].reverse().find((x) => x.created_at <= firstHist.created_at) ?? arr[0] : arr[0]; return m ? { at: m.created_at, kind, text: around(nf(m.text), vs) } : undefined; };
      if (!shape && inRaw && rawKind !== "condition" && rawKind !== "condition_form" && !cond.length) {
        // 条件フォームの原文（raw_format_text）そのものが物件の共有文（賃貸EX・ニフティ等）＝ autoParseFormat が物件を条件フォームと読んだ
        verdict = "②混入"; why = `条件フォームの原文が物件の共有文（${rawKind}）`; source = { at: "", kind: "raw_format_text", text: safe(raw, 90) };
      } else if (shape) {
        verdict = "②混入"; why = `形: ${shape}`;
        source = pick(inquiry, "物件の問い合わせ") ?? pick(cond, "お客様の発言") ?? pick(image, "画像の書き起こし");
      } else if (inRaw || cond.length) {
        verdict = "①本物"; why = inRaw ? "条件フォームの原文にある" : "お客様の条件の発言にある";
        source = inRaw ? { at: "", kind: "条件フォーム", text: "" } : pick(cond, "お客様の発言");
      } else if (geo === "station" && wardOfStation(core) && genuineWards.has(wardOfStation(core)!)) {
        verdict = "①本物（区・路線の駅に展開）"; why = `本物の区（${wardOfStation(core)}）の中の駅`;
      } else if (lineExpanded) {
        verdict = "①本物（区・路線の駅に展開）"; why = `本物の路線（${[...genuineLines].join("・")}）の駅`;
      } else if (form.length) {
        verdict = "②混入"; why = "申込・審査の書類の中だけ"; source = pick(form, "申込・審査の書類");
      } else if (inquiry.length) {
        verdict = "②混入"; why = "物件の問い合わせの中だけ"; source = pick(inquiry, "物件の問い合わせ");
      } else if (image.length) {
        verdict = "②混入"; why = "画像の書き起こし（スクショ）の中だけ"; source = pick(image, "画像の書き起こし");
      } else if (mixed.length) {
        verdict = "③判断つかず"; why = "物件の問い合わせと条件の言葉が同居した通の中だけ"; source = pick(mixed, "問い合わせ＋条件の同居");
      } else if (staffProp.length && !staffScope.length) {
        verdict = "②混入"; why = "スタッフが送った物件の文の中だけ（所在・最寄り駅）"; source = pick(staffProp, "スタッフの物件の文");
      } else if (staffScope.length) {
        verdict = "③判断つかず"; why = "スタッフの宣言・提案の中だけ（スタッフが決めた範囲／電話で聞いた可能性）"; source = pick(staffScope, "スタッフの宣言");
      } else {
        verdict = "③判断つかず"; why = msgs.length ? "発言・フォームのどこにも無い（画面の編集・180日より前・電話）" : `${DAYS}日の発言の記録なし`;
      }
      // 出所だけで②にした語でも、最初に入ったのが「直前10分にお客様の発言が無い履歴の行」＝スタッフの画面の編集（北摂エリア→茨木市・高槻市…の展開、
      //   関目高殿→旭区・都島区…の言い換え）なら、スタッフの判断なので③に戻す（2026-09-29 監査の目視: この形の②19語はほぼ全部スタッフの展開だった）
      if (verdict === "②混入" && !shape && firstHist) {
        const t1 = Date.parse(firstHist.created_at);
        const custNear = msgs.some((m) => m.sender === "customer" && Date.parse(m.created_at) <= t1 && t1 - Date.parse(m.created_at) <= 10 * 60_000);
        if (!custNear) { verdict = "③判断つかず"; why = `スタッフの画面の編集で入った（展開・言い換え＝スタッフの判断・元の語は${why}）`; }
      }
      // 書いた経路の推定
      let path: string;
      const autoLog = addl.split("\n").some((l) => /\|auto\]/.test(l) && /エリア/.test(l) && has(l));
      if (verdict.startsWith("①")) path = "-";
      else if (firstHist) {
        const srcMsg = [...msgs].reverse().find((m) => m.sender === "customer" && m.created_at <= firstHist.created_at && Date.parse(firstHist.created_at) - Date.parse(m.created_at) <= 10 * 60_000);
        const th = Date.parse(firstHist.created_at);
        if (firstHist.created_at >= LLM_SINCE && llmNear(th, "/api/line-webhook", 30_000, 2_000)) path = "P4（extractConditionsFromCasualReply）／カジュアル更新＝line-webhook の LLM の直後に履歴（裏付けあり）";
        else if (firstHist.created_at >= LLM_SINCE && llmNear(th, "/api/generate-draft-bg-async", 60_000, 2_000)) path = "条件ブレイン（property-brain-core）＝bg-async の LLM の直後に履歴（裏付けあり）";
        else if (firstHist.created_at >= LLM_SINCE) path = "画面の編集・拡張の保存（直前に LLM の呼び出しなし）";
        else path = srcMsg && has(srcMsg.text!) ? (autoLog ? "履歴あり＋autoログ＝P4 またはカジュアル更新（発言の直後）" : "履歴あり・autoログなし＝条件ブレイン（property-brain-core）か画面の編集")
          : srcMsg ? "履歴あり・直前の発言に語なし（条件ブレインが会話全体から／画面の編集）" : "履歴あり・直前10分に発言なし（画面の編集・拡張の保存）";
        if (!source && srcMsg) source = { at: srcMsg.created_at, kind: "履歴の直前の発言", text: around(nf(srcMsg.text), vs) };
      } else if (!inAnyHist) {
        const srcMsg = source?.at ? msgs.find((m) => m.created_at === source!.at) : undefined;
        const areaSpec = srcMsg ? looksLikeAreaSpec(nf(srcMsg.text)) : false;
        const ts = srcMsg ? Date.parse(srcMsg.created_at) : 0;
        if (srcMsg && srcMsg.created_at >= LLM_SINCE && areaSpec && llmNear(ts, "/api/resolve-area", 0, 45_000)) path = "Path C（detectAndAnnounceAreaChange・履歴を残さない・【地域指定】通知）＝発言の直後に resolve-area（裏付けあり）";
        else if (srcMsg && srcMsg.created_at >= LLM_SINCE && llmNear(ts, "/api/generate-draft-bg-async", 0, 120_000)) path = "ブレインの橋（bg-async applyBrainConditionChange・履歴を残さない・上書き）の疑い＝発言の直後に bg-async";
        else path = areaSpec ? (autoLog ? "履歴なし＋autoログ＝ブレインの橋（bg-async applyBrainConditionChange）" : "履歴なし・地域指定の形＝Path C（detectAndAnnounceAreaChange・【地域指定】通知）")
          : autoLog ? "履歴なし＋autoログ＝ブレインの橋（bg-async）" : "履歴なし（Path C／ブレインの橋／正式フォーマット／履歴の始まり 8/20 より前）";
      } else path = "履歴にはあるが最初の追加は期間外";
      const firstSeenAt = firstHist?.created_at ?? source?.at ?? null;
      const hitsIn = (x: Audit) => [...(x.intended?.station_names ?? []), ...(x.intent?.stations ?? []), ...(x.intended?.unknown_tokens ?? [])].some((s) => vs.includes(normStation(s)) || vs.includes(nf(s)));
      const searchHits = au.filter(hitsIn).length;
      const searchHitsAfter = firstSeenAt ? au.filter((x) => x.created_at >= firstSeenAt && hitsIn(x)).length : searchHits;
      findings.push({ pc: c.id, token: tok, core, geo, shape, verdict, why, source, path, firstSeenAt, searchHits, searchHitsAfter });
    }
  }

  const byV = (v: string) => findings.filter((f) => f.verdict === v);
  const custWith = (arr: TokenFinding[]) => new Set(arr.map((f) => f.pc)).size;
  console.log(`\n== A. 希望エリアの語 ${findings.length}語（${custWith(findings)}人）==`);
  for (const v of ["①本物", "①本物（区・路線の駅に展開）", "②混入", "③判断つかず"]) console.log(`  ${v}: ${byV(v).length}語・${custWith(byV(v))}人`);
  const polluted = byV("②混入");
  const tally = <T,>(arr: T[], key: (f: T) => string): Array<[string, T[]]> => { const m = new Map<string, T[]>(); for (const f of arr) m.set(key(f), [...(m.get(key(f)) ?? []), f]); return [...m.entries()].sort((a, b) => b[1].length - a[1].length); };
  console.log(`\n  ②混入の理由別:`);
  for (const [k, arr] of tally(polluted, (f) => f.why)) {
    console.log(`   - ${k}: ${arr.length}語・${custWith(arr)}人`);
    for (const f of arr.slice(0, SHOW)) console.log(`       [${id8(f.pc)}] 「${f.token}」← ${f.source ? `${f.source.kind} ${f.source.at.slice(0, 16)}「${f.source.text}」` : "元の発言なし"}`);
  }
  console.log(`\n== B. ②混入を書いた経路（推定）==`);
  for (const [k, arr] of tally(polluted, (f) => f.path)) console.log(`   - ${k}: ${arr.length}語・${custWith(arr)}人`);
  console.log(`\n  ③判断つかずの理由別:`);
  for (const [k, arr] of tally(byV("③判断つかず"), (f) => f.why)) {
    console.log(`   - ${k}: ${arr.length}語・${custWith(arr)}人`);
    for (const f of arr.slice(0, SHOW)) console.log(`       [${id8(f.pc)}] 「${f.token}」(${f.geo})${f.source ? ` ← ${f.source.kind} ${f.source.at.slice(0, 16)}「${f.source.text}」` : ""}`);
  }

  // ── C: その他の欄 ────────────────────────────────────────────
  console.log(`\n== C. その他・こだわり・NG の欄に入った「物件の話・依頼」の節 ==`);
  const clauseHits: Array<{ pc: string; field: string; clause: string }> = [];
  for (const c of custs) for (const f of ["other_requests", "preferences", "ng_points"] as const) {
    for (const cl of nf(c[f]).split(/[・、,\n]+/).map((s) => s.trim()).filter(Boolean)) if (isPropertyTalkClause(cl)) clauseHits.push({ pc: c.id, field: f, clause: cl });
  }
  console.log(`  ${clauseHits.length}節・${new Set(clauseHits.map((x) => x.pc)).size}人（欄: ${[...tally(clauseHits as never, (x: never) => (x as { field: string }).field)].map(([k, a]) => `${k} ${a.length}`).join("・")}）`);
  for (const x of clauseHits.slice(0, SHOW * 4)) console.log(`   [${id8(x.pc)}] ${x.field}: 「${safe(x.clause, 70)}」`);

  // ── D: 検索への影響 ───────────────────────────────────────────
  console.log(`\n== D. 検索への影響（search_audits・${DAYS}日）==`);
  const hitF = polluted.filter((f) => f.searchHitsAfter > 0);
  console.log(`  混入した語が検索の駅に入った: ${hitF.length}語・${custWith(hitF)}人・${hitF.reduce((s, f) => s + f.searchHitsAfter, 0)}回`);
  for (const f of hitF.slice(0, SHOW * 3)) console.log(`   [${id8(f.pc)}] 「${f.token}」 ${f.searchHitsAfter}回`);
  // 本物の区があるのに区が落ちた検索（area_mode=station で wards/city_codes 空）
  let wardDrop = 0; const wardDropPcs = new Set<string>(); const wardDropEx: string[] = [];
  for (const c of custs) {
    const gw = findings.filter((f) => f.pc === c.id && f.verdict.startsWith("①") && f.geo === "ward");
    if (!gw.length) continue;
    const pol = findings.filter((f) => f.pc === c.id && f.verdict === "②混入" && f.geo === "station");
    if (!pol.length) continue;
    for (const x of auditsOf.get(c.id) ?? []) {
      const noWard = !(x.intended?.city_codes?.length) && !(x.intent?.wards?.length);
      if (noWard && (x.intended?.station_names ?? []).some((s) => pol.some((p) => variants(p.core).includes(normStation(s))))) {
        wardDrop++; wardDropPcs.add(c.id);
        if (wardDropEx.length < SHOW) wardDropEx.push(`[${id8(c.id)}] ${x.created_at.slice(0, 16)} ${x.site}/${x.mode} 本物の区=${gw.map((g) => g.core).join("・")} → 検索の駅=${(x.intended?.station_names ?? []).join("・")}・区なし`);
      }
    }
  }
  console.log(`  本物の区があるのに、混入した駅だけで検索（区が落ちた）: ${wardDrop}回・${wardDropPcs.size}人`);
  for (const e of wardDropEx) console.log(`   ${e}`);

  // ── E: 見分けの材料と誤爆の形 ────────────────────────────────────
  console.log(`\n== E. 見分けの材料（お客様の発言 ${DAYS}日・画像の書き起こしを除く）==`);
  const shapeStats = new Map<string, { msgs: number; areaChanged: number; anyCondChanged: number; ex: string[] }>();
  let condAndInquiry = 0; const condAndInquiryEx: string[] = [];
  const realFloor: Array<{ pc: string; text: string; landed: string }> = [];
  for (const c of custs) {
    const msgs = msgsOf.get(c.id) ?? [];
    const hs = histOf.get(c.id) ?? [];
    for (const m of msgs) {
      if (m.sender !== "customer" || IMAGE_RE.test(m.text!)) continue;
      const t = nf(m.text);
      const t0 = Date.parse(m.created_at);
      const after = hs.filter((h) => !/戻した/.test(h.new_value ?? "")).filter((h) => { const d = Date.parse(h.created_at) - t0; return d >= 0 && d <= 10 * 60_000; });
      const areaCh = after.some((h) => h.changed_field === "desired_area");
      const shapes = inquiryShapes(t);
      if (isApplyForm(t)) shapes.push("申込・審査の書類");
      for (const s of shapes) {
        const st = shapeStats.get(s) ?? { msgs: 0, areaChanged: 0, anyCondChanged: 0, ex: [] };
        st.msgs++; if (areaCh) st.areaChanged++; if (after.length) st.anyCondChanged++;
        if (after.length && st.ex.length < 3) st.ex.push(`[${id8(c.id)}]「${safe(t, 70)}」→ ${after.map((h) => `${h.changed_field}+「${cut(nf(h.new_value).replace(nf(h.old_value), ""), 30)}」`).join(" ")}`);
        shapeStats.set(s, st);
      }
      // 条件の発言と物件の問い合わせが1通に同居（誤爆しやすい）
      if (shapes.length && /(?:で|を)?探して|希望|条件|以内|以下|以上|エリア|周辺|予算/.test(t) && /[区市]|駅|万/.test(t)) {
        condAndInquiry++; if (condAndInquiryEx.length < SHOW) condAndInquiryEx.push(`[${id8(c.id)}]「${safe(t, 90)}」(${shapes.join("/")})`);
      }
      if (REAL_FLOOR_COND_RE.test(t) && !shapes.includes("○階の部屋・○階の方")) {
        const fields = [["desired_area", c.desired_area], ["ng_points", c.ng_points], ["preferences", c.preferences], ["other_requests", c.other_requests]] as const;
        const floorWord = (t.match(REAL_FLOOR_COND_RE) ?? [""])[0];
        const landed = fields.filter(([, v]) => nf(v).includes(floorWord) || (/階以上/.test(floorWord) && /階以上/.test(nf(v)))).map(([k]) => k).join("・") || "どの欄にも無い";
        realFloor.push({ pc: c.id, text: safe(t, 70), landed });
      }
    }
  }
  console.log(`  形 | その形の発言 | 10分以内に希望エリアが変わった | 何かの条件が変わった | 例`);
  for (const [k, s] of [...shapeStats.entries()].sort((a, b) => b[1].msgs - a[1].msgs)) {
    console.log(`  ${k} | ${s.msgs} | ${s.areaChanged} | ${s.anyCondChanged}`);
    for (const e of s.ex) console.log(`      ${e}`);
  }
  console.log(`\n  誤爆しやすい形①: 本物の階の条件（11階以上・2階以上・1階NG 等）${realFloor.length}通`);
  for (const [k, arr] of tally(realFloor as never, (x: never) => (x as { landed: string }).landed)) console.log(`   - 入った欄 ${k}: ${arr.length}`);
  for (const x of realFloor.slice(0, SHOW)) console.log(`     [${id8(x.pc)}]「${x.text}」→ ${x.landed}`);
  console.log(`  誤爆しやすい形②: 条件の言葉と物件の問い合わせが1通に同居 ${condAndInquiry}通`);
  for (const e of condAndInquiryEx) console.log(`     ${e}`);
  // お客様が自分の条件として駅名を言った発言（地域指定の形・問い合わせの形なし）
  let selfStation = 0;
  for (const c of custs) for (const m of msgsOf.get(c.id) ?? []) if (m.sender === "customer" && !IMAGE_RE.test(m.text!) && looksLikeAreaSpec(nf(m.text)) && !inquiryShapes(m.text!).length && !isApplyForm(nf(m.text))) selfStation++;
  console.log(`  参考: 地域指定の形（Path C が動く形）で、問い合わせ・書類の形が無い発言 ${selfStation}通（＝お客様が自分の条件として地名を言う形。止めてはいけない側）`);

  // グループ会話（友人・家族が同じ会話で話す）
  const groupPcs = new Set(convs.filter((c) => /^C/.test(c.line_user_id ?? "")).map((c) => c.property_customer_id));
  const pollutedInGroup = polluted.filter((f) => groupPcs.has(f.pc));
  console.log(`\n  参考: グループ会話のお客様 ${groupPcs.size}人・そのうち②混入 ${pollutedInGroup.length}語`);

  // ── F: 入口の判定を過去の発言に当てる（本番の式の複製）────────────────────
  // Path C（地域指定・履歴なし・グループへ【地域指定】通知）は、どの種類の発言で動くか。本番の isPropertySiteUrl は最初の URL が5サイトの時だけ除外
  console.log(`\n== F. 入口の判定を過去のお客様の発言（${DAYS}日・画像の書き起こしを除く）に当てる ==`);
  const pathC = new Map<MsgKind, { n: number; ex: string[] }>();
  let portalUrlMsgs = 0, portalMissed = 0; const portalMissEx: string[] = [];
  for (const c of custs) for (const m of msgsOf.get(c.id) ?? []) {
    if (m.sender !== "customer") continue;
    const t = nf(m.text);
    if (IMAGE_RE.test(t)) continue;
    const hosts = [...t.matchAll(/https?:\/\/([^/\s]+)/g)].map((x) => x[1]);
    if (hosts.some((h) => PORTAL_HOST_RE.test(h))) {
      portalUrlMsgs++;
      if (!isPropertySiteUrlLikeProd(t)) { portalMissed++; if (portalMissEx.length < SHOW) portalMissEx.push(`[${id8(c.id)}] ${hosts.join(",")}「${safe(t.replace(/https?:\/\/\S+/g, "<URL>"), 60)}」`); }
    }
    // 本番の Path C の判定（isFormatMessage → isPropertySiteUrl（本番と同じ5サイト・最初の URL）→ 物件情報の形 → 地域指定の形）
    const fires = looksLikeAreaSpec(t);
    if (!fires) continue;
    const k = msgKind(t);
    const st = pathC.get(k) ?? { n: 0, ex: [] };
    st.n++; if (st.ex.length < SHOW && k !== "condition" && k !== "condition_form") st.ex.push(`[${id8(c.id)}]「${safe(t, 80)}」`);
    pathC.set(k, st);
  }
  console.log(`  物件ポータルの URL を含む発言 ${portalUrlMsgs}通のうち、本番の isPropertySiteUrl（5サイト・最初の URL だけ）が物件と見ない ${portalMissed}通`);
  for (const e of portalMissEx) console.log(`     ${e}`);
  const totalC = [...pathC.values()].reduce((s, x) => s + x.n, 0);
  console.log(`  Path C（地域指定）が動く発言 ${totalC}通の種類:`);
  for (const [k, st] of [...pathC.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`   - ${k}: ${st.n}`);
    for (const e of st.ex) console.log(`       ${e}`);
  }

  // ── G: 条件フォームの原文（raw_format_text）が物件の共有文になっている人（autoParseFormat が物件の文を条件フォームと読んだ跡）──
  console.log(`\n== G. 条件フォームの原文（raw_format_text）の種類 ==`);
  const rawKinds = tally(custs.filter((c) => nf(c.raw_format_text).trim()).map((c) => ({ pc: c.id, k: msgKind(nf(c.raw_format_text)), t: nf(c.raw_format_text) })) as never, (x: never) => (x as { k: string }).k);
  for (const [k, arr] of rawKinds) {
    console.log(`   - ${k}: ${arr.length}人`);
    if (k !== "condition" && k !== "condition_form") for (const x of (arr as unknown as Array<{ pc: string; t: string }>).slice(0, SHOW)) console.log(`       [${id8(x.pc)}]「${safe(x.t, 80)}」`);
  }

  // ── D2: 駅が1語でも入ると area_mode=station（inferAreaMode「駅が1つでも含まれれば station」）→ 本物の区が検索から落ちる ──
  console.log(`\n== D2. 本物の区があるのに area_mode=station のお客様（混入・判断つかずの駅が1語で区を押し出す形）==`);
  let d2All = 0; const d2Bad: string[] = [];
  for (const c of custs) {
    const fs_ = findings.filter((f) => f.pc === c.id);
    const wards = fs_.filter((f) => f.verdict.startsWith("①") && f.geo === "ward");
    const stations = fs_.filter((f) => f.geo === "station");
    if (!wards.length || !stations.length || c.area_mode !== "station") continue;
    d2All++;
    const genuineSt = stations.filter((f) => f.verdict.startsWith("①"));
    if (!genuineSt.length) d2Bad.push(`[${id8(c.id)}] 区=${wards.map((w) => w.core).join("・")} ／ 駅=${stations.map((s) => `${s.core}(${s.verdict})`).join("・")}`);
  }
  console.log(`  本物の区＋駅の語がありモードが station: ${d2All}人。そのうち駅の語が1つも本物でない（＝その駅のせいで区が落ちる）: ${d2Bad.length}人`);
  for (const e of d2Bad.slice(0, SHOW * 2)) console.log(`   ${e}`);

  // ── E2: 形ごとの原文（見分けの材料と誤爆の形を目で読む）──
  console.log(`\n== E2. 形ごとの原文（お客様の発言・画像の書き起こしを除く）==`);
  const custTexts = custs.flatMap((c) => (msgsOf.get(c.id) ?? []).filter((m) => m.sender === "customer" && !IMAGE_RE.test(m.text!)).map((m) => ({ pc: c.id, t: nf(m.text) })));
  const dump = (label: string, re: RegExp, n: number) => {
    const hit = custTexts.filter((x) => re.test(x.t));
    console.log(`  ${label}: ${hit.length}通`);
    for (const x of hit.slice(0, n)) console.log(`     [${id8(x.pc)}]「${around(x.t, [(x.t.match(re) ?? [""])[0]], 80)}」`);
  };
  dump("「N階の(お)部屋・N階の方・N階の物件」（物件1件を指す形）", /[0-9一二三四五六七八九十]+階の(?:お)?(?:部屋|方|物件)/, SHOW * 3);
  dump("本物の階の条件（N階以上・1階以外・最上階・高層階）", /[0-9一二三四五六七八九十]+階以上|1階以外|一階以外|最上階|高層階/, SHOW * 2);
  dump("「上の階」（物件の話・騒音の話で条件でないことが多い）", /上の階/, SHOW);
  dump("駅＋徒歩N分（URL・物件名・号室なし＝お客様の条件の形）", /^(?![\s\S]*https?:)(?![\s\S]*(?:物件名|号室))[\s\S]*駅\s*徒歩\s*\d+分/, SHOW);

  // ── H: Path C（地域指定）が実際に動いた回（llm_usage_logs の /api/resolve-area ＝ 9/14〜全リクエスト記録）──
  console.log(`\n== H. Path C（detectAndAnnounceAreaChange → /api/resolve-area）が実際に動いた回（llm_usage_logs・9/14〜）==`);
  const hSince = since > LLM_SINCE ? since : LLM_SINCE;
  const ra = await all<{ created_at: string }>((a, b) => sb.from("llm_usage_logs").select("created_at").eq("route", "/api/resolve-area").gte("created_at", hSince).order("created_at").range(a, b) as never);
  const custMsgsFlat = custs.flatMap((c) => (msgsOf.get(c.id) ?? []).filter((m) => m.sender === "customer").map((m) => ({ pc: c.id, at: Date.parse(m.created_at), t: nf(m.text) })));
  const hKinds = new Map<string, { n: number; ex: string[] }>(); let hMatched = 0;
  for (const r of ra) {
    const t1 = Date.parse(r.created_at);
    const m = custMsgsFlat.filter((x) => x.at <= t1 && t1 - x.at <= 45_000 && !IMAGE_RE.test(x.t) && looksLikeAreaSpec(x.t)).sort((a, b) => b.at - a.at)[0];
    if (!m) continue;
    hMatched++;
    const k = msgKind(m.t);
    const st = hKinds.get(k) ?? { n: 0, ex: [] };
    st.n++; if (st.ex.length < SHOW && k !== "condition") st.ex.push(`[${id8(m.pc)}] ${r.created_at.slice(0, 16)}「${safe(m.t, 70)}」`);
    hKinds.set(k, st);
  }
  console.log(`  /api/resolve-area の呼び出し ${ra.length}回のうち、45秒以内に地域指定の形のお客様の発言がある（＝Path C）${hMatched}回の発言の種類:`);
  for (const [k, st] of [...hKinds.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`   - ${k}: ${st.n}`);
    for (const e of st.ex) console.log(`       ${e}`);
  }

  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ findings, clauseHits, shapeStats: Object.fromEntries(shapeStats), realFloor }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
