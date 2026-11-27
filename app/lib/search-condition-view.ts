// app/lib/search-condition-view.ts — 検索の見立て（#820 案A・記録だけ・純関数・LLM なし・2026-11-27 作業員A）
//
// 竹内さん 11/27 承認「その順で進める（推奨）」（台帳 #820）: 案B（探す条件の1枚）の次に、案A の記録だけ。検索に渡すのは試験の後。
//   調べ（30日の送った物件の検索 69回）で目で読んだ外れ: 「駐車場と併せて13万」が家賃の上限13万のまま・「共益費込みで15万」が上限14万。
//   ヒアリングのフォームの家賃の欄そのものが「ご希望家賃（管理費込み）」＝フォームで答えた金額は総額。込みの意味が欄にも検索にも無い。
//   「できれば・なるべく・でも大丈夫」の言葉が 27% の回にあるのに、検索は1本の線（強さ requirement_strength は判定と文だけで検索に渡らない）。
// ここは決まった網で「検索の見立て」を作るだけ（ブレインの判断はやり直させない＝q065 の教訓・新しい出力の欄は作らない）。
//   ① 家賃の上限が何を含むか（家賃だけ／管理費込み／駐車場込み）と、その金額
//   ② 欄ごとの強さ（絶対／できれば）を言った文
// スイッチ SEARCH_CONDITION_VIEW（既定 off）: on の時だけ探す命令の payload.search_view に残す（検索・欄・文は変えない）。

import { stagedOn, STAGE_OFF } from "./switch-stage";

type Env = Record<string, string | undefined>;
// 2026-11-27 作業員A（竹内さんの決め 11/27「これから on にする部品は段階で読む」・stage-coverage の点検）: 今の読み（=== "on"）と同じ答えを段階で読む＝夜の見張りが1段戻せる
export const searchConditionViewOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("SEARCH_CONDITION_VIEW", env, STAGE_OFF);

export type RentBasis = { basis: "rent_only" | "with_fee" | "with_parking"; amountMan: number | null; from: "form_label" | "text"; quote: string };
const N = (s: string) => String(s ?? "").normalize("NFKC");
const num = (s: string | undefined) => (s != null && Number.isFinite(Number(s)) ? Number(s) : null);

/** ① 家賃の上限の含む物（新しい通ほど優先・最後に言った物） */
export function rentBasisOf(texts: readonly string[]): RentBasis | null {
  let out: RentBasis | null = null;
  for (const raw of texts) {
    const t = N(raw);
    // 駐車場と併せて13万／駐車場込みで13万
    const p = t.match(/駐車場(?:代)?(?:と|も)?(?:併せて|合わせて|込み|込みで|含めて)[^0-9]{0,6}(\d{1,2}(?:\.\d)?)\s*万/);
    if (p) { out = { basis: "with_parking", amountMan: num(p[1]), from: "text", quote: p[0].slice(0, 30) }; continue; }
    // 共益費込みで家賃15万／管理費込み12万
    const f = t.match(/(?:管理費|共益費)(?:込み|込|含む|含め)[^0-9\n]{0,8}?(\d{1,2}(?:\.\d)?)\s*万/);
    if (f) { out = { basis: "with_fee", amountMan: num(f[1]), from: "text", quote: f[0].slice(0, 30) }; continue; }
    // フォームの欄「ご希望家賃（管理費込み）」の答え（〜万・〜万円〜〜万円）
    const form = t.match(/ご?希望(?:の)?家賃[（(](?:管理費|共益費)込み?[）)][^0-9\n]{0,10}\n?[^0-9\n]{0,6}(\d{1,2}(?:\.\d)?)(?:\s*万)?(?:\s*円)?(?:\s*[〜~～-]\s*(\d{1,2}(?:\.\d)?)\s*万)?/);
    if (form) { out = { basis: "with_fee", amountMan: num(form[2] ?? form[1]), from: "form_label", quote: form[0].replace(/\s+/g, " ").slice(0, 30) }; continue; }
    if (/家賃(?:のみ|だけ)で|管理費(?:は)?別で/.test(t)) { const m = t.match(/(\d{1,2}(?:\.\d)?)\s*万/); out = { basis: "rent_only", amountMan: num(m?.[1]), from: "text", quote: t.slice(0, 30) }; }
  }
  return out;
}

export type FieldStrength = { field: "rent" | "layout" | "area" | "walk" | "age" | "other"; strength: "must" | "soft"; quote: string };
const FIELD_RE: Array<[FieldStrength["field"], RegExp]> = [
  ["rent", /家賃|予算|万円|万以内|万まで/], ["layout", /間取り|[1-4](?:LDK|DK|K)|ワンルーム|広さ|㎡|平米/], ["walk", /徒歩|駅近|駅から/],
  ["age", /築|新築|築浅/], ["area", /エリア|駅|区|市|沿線|周辺/],
];
const SOFT_RE = /できれば|出来れば|なるべく|理想は|理想を言え|でも大丈夫|でも構いません|でもいい|でも可|妥協|多少(?:は)?(?:オーバー|超え)/;
const MUST_RE = /絶対|必須|譲れ(?:ない|ません)|マスト|必ず/;
/** ② 欄ごとの強さを言った文（文ごと・同じ欄は新しい方） */
export function fieldStrengthsOf(texts: readonly string[]): FieldStrength[] {
  const m = new Map<string, FieldStrength>();
  for (const raw of texts) for (const s of N(raw).split(/(?<=[。!?！？\n])/)) {
    const soft = SOFT_RE.test(s), must = MUST_RE.test(s);
    if (!soft && !must) continue;
    const field = FIELD_RE.find(([, re]) => re.test(s))?.[0] ?? "other";
    m.set(field, { field, strength: must && !soft ? "must" : "soft", quote: s.trim().slice(0, 40) });
  }
  return [...m.values()];
}

export type SearchConditionView = { v: 1; at: string; rent: RentBasis | null; strengths: FieldStrength[]; rentMaxYen: number | null; rentGapMan: number | null };
/** 見立て1枚（記録だけ）。rentGapMan＝込みの金額と検索の家賃の上限の差（込みなのに上限が同じ＝0 は「込みの分だけ高く探している」疑い） */
export function buildSearchConditionView(o: { customerTexts: readonly string[]; rentMaxYen: number | null | undefined; nowIso: string }): SearchConditionView {
  const rent = rentBasisOf(o.customerTexts);
  const rm = o.rentMaxYen && o.rentMaxYen > 0 ? o.rentMaxYen : null;
  const gap = rent && rent.amountMan != null && rm ? Math.round((rm / 10000 - rent.amountMan) * 10) / 10 : null;
  return { v: 1, at: o.nowIso, rent, strengths: fieldStrengthsOf(o.customerTexts), rentMaxYen: rm, rentGapMan: gap };
}
/** 込み（管理費・駐車場）の金額を、家賃の上限としてそのまま探している疑い（差が 0.5万以内・込みの言い方がある時） */
export function inclusiveRentRisk(v: SearchConditionView): boolean {
  return !!v.rent && v.rent.basis !== "rent_only" && v.rentGapMan != null && Math.abs(v.rentGapMan) <= 0.5;
}
