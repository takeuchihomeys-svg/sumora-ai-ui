// scripts/lib/exam-problem-rag.ts — 試験の問題を RAG で選ぶ（純関数・DB なし・LLM なし）
// 2026-11-27 作業員L（竹内さん 11/27「明日の昼じゃなくて今から作る」・統括役の頼み・L の 1〜7）:
//   ① 問題ごとの「場面の形」の文（駅＝型・細かい状態・直前のお客様の文〔伏せ字〕・写しの材料・正解の手）を埋め込む
//   ② スイッチごとの「効く場面の説明」（部品のコメント・SWITCH_REACH・印・設計知見の題）を埋め込む
//   ③ 説明に近い問題を「効く候補」（上位 k）と「守りの候補」（その次の k）に
//   ④ 候補はそのまま使わない＝昼の届きの確かめ（LLM 0）で印が出た問題だけ残す（scripts/exam-problem-rag.ts）
//   既定は記録だけ（EXAM_PROBLEM_RAG=shadow）。届いた割合が今の選びより上がると確かめてから選びに使う
export type RagProblemIn = {
  id: string; type?: string; sub?: string; hourJst?: number; customer?: string;
  context?: ReadonlyArray<{ s?: string; t?: string; aix?: boolean }>;
  accept?: readonly string[]; mustNot?: readonly string[]; asks?: ReadonlyArray<{ q?: string; route?: string; point?: string }>;
  pc?: unknown; prodBrain?: { action?: string; mode?: string } | null; ledger?: Record<string, unknown> | null;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** 写しの材料（ledger の表ごとの行の数・0行は書かない） */
export function snapshotMaterialsOf(ledger: Record<string, unknown> | null | undefined): Array<[string, number]> {
  if (!ledger) return [];
  return Object.entries(ledger).map(([k, v]) => [k, Array.isArray(v) ? v.length : v && typeof v === "object" ? 1 : 0] as [string, number]).filter(([, n]) => n > 0).sort((a, b) => a[0].localeCompare(b[0]));
}
/** ① 問題の「場面の形」の文。お客様・スタッフの文は mask（maskForEmbedding）で伏せてから入れる。スタッフの実際の文（staffText）は入れない（正解の言い回しで寄せない） */
export function sceneShapeText(p: RagProblemIn, mask: (s: string) => string): string {
  const ctx = (p.context ?? []).slice(-4).map((c) => `${c.s === "customer" ? "客" : c.aix ? "スタッフ(AIX)" : "スタッフ"}: ${clip(oneLine(mask(c.t ?? "")), 60)}`);
  const mats = snapshotMaterialsOf(p.ledger).map(([k, n]) => `${k}:${n}`);
  const asks = (p.asks ?? []).map((a) => `${clip(oneLine(mask(a.q ?? "")), 40)}→${a.route ?? ""}`);
  return [
    `場面: ${p.type ?? "?"} / ${p.sub ?? "?"}`,
    p.hourJst != null ? `時刻: ${p.hourJst}時` : "",
    `直前のお客様: ${clip(oneLine(mask(p.customer ?? "")), 300)}`,
    ctx.length ? `流れ: ${ctx.join(" / ")}` : "",
    asks.length ? `依頼: ${asks.join(" / ")}` : "",
    `写しの材料: ${mats.length ? mats.join(", ") : "なし"}`,
    `条件の行: ${p.pc ? "あり" : "なし"}`,
    `正解: ${(p.accept ?? []).join("・") || "?"}${p.mustNot?.length ? ` / 避ける: ${p.mustNot.join("・")}` : ""}`,
    p.prodBrain?.action ? `本番のブレイン: ${p.prodBrain.action}${p.prodBrain.mode ? `(${p.prodBrain.mode})` : ""}` : "",
  ].filter(Boolean).join("\n");
}
/** ② スイッチの「効く場面の説明」（部品のコメント・表の説明・印・設計知見の題を束ねる） */
export function switchSceneText(sw: string, parts: { comments?: readonly string[]; needs?: readonly string[]; mark?: string | null; kb?: readonly string[] }): string {
  return [
    `スイッチ: ${sw}`,
    parts.mark ? `材料の印: ${parts.mark}` : "",
    parts.needs?.length ? `要る材料: ${parts.needs.join(", ")}` : "",
    ...(parts.comments ?? []).slice(0, 4).map((c) => `部品: ${clip(oneLine(c), 400)}`),
    ...(parts.kb ?? []).slice(0, 3).map((k) => `設計知見: ${clip(oneLine(k), 300)}`),
  ].filter(Boolean).join("\n");
}
/** コードの本文から、スイッチ名の近くのコメント行を拾う（純関数）。名前の行の前 before 行までの // コメントと、名前の行のコメント */
// 2026-11-27: 続いたコメントの塊だけ（コードの行で切る）・他のスイッチの名前が出る塊は捨てる（隣の部品の説明が混ざる＝BRAIN_CHECK_PROMISE_FLOW に連鎖の見立ての説明が入った）
const commentOf = (l: string): string | null => { const m = l.match(/\/\/\s?(.*)$/) ?? l.match(/^\s*\*\s?(.*?)(\*\/)?$/) ?? l.match(/\/\*\*?\s?(.*?)(\*\/)?$/); return m ? m[1].trim() : null; };
const isCommentLine = (l: string) => /^\s*(\/\/|\/\*|\*)/.test(l);
export function commentsNearSwitch(src: string, sw: string, before = 6, max = 3, others: readonly string[] = []): string[] {
  const lines = src.split(/\r?\n/); const out: string[] = [];
  const foreign = others.filter((o) => o !== sw && !sw.includes(o) && !o.includes(sw));
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (!lines[i].includes(`"${sw}"`) && !lines[i].includes(`${sw}:`)) continue;
    const xs: string[] = [];
    for (let j = i - 1; j >= Math.max(0, i - before) && isCommentLine(lines[j]); j--) { const c = commentOf(lines[j]); if (c) xs.unshift(c); }
    const own = commentOf(lines[i]); if (own && lines[i].indexOf("//") > lines[i].indexOf(sw)) xs.push(own);
    const t = xs.join(" ");
    if (t.length < 20 || out.includes(t) || foreign.some((o) => t.includes(o))) continue;
    out.push(t);
  }
  return out;
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  let d = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
/** 問題のベクトルの平均を引く（純関数）。2026-11-27 初回: 平均を引かないと同じ問題（q208・q135・q091）が 47スイッチのほぼ全部で上位に出た（hubness）＝全部に似た問題が勝つ */
export function centerVecs(vecs: Readonly<Record<string, readonly number[]>>): { mean: number[]; centered: Record<string, number[]> } {
  const xs = Object.values(vecs); const dim = xs[0]?.length ?? 0; const mean = new Array<number>(dim).fill(0);
  for (const v of xs) for (let i = 0; i < dim; i++) mean[i] += v[i] / xs.length;
  const centered: Record<string, number[]> = {}; for (const [id, v] of Object.entries(vecs)) centered[id] = v.map((x, i) => x - mean[i]);
  return { mean, centered };
}
export const subVec = (v: readonly number[], m: readonly number[]) => v.map((x, i) => x - (m[i] ?? 0));
/** ③ 近い問題の候補（純関数）: 上位 k を効く候補・その次の k を守りの候補。exclude（一度も合格していない等）は飛ばす */
export function ragCandidates(sv: readonly number[], vecs: Readonly<Record<string, readonly number[]>>, k = 12, exclude: ReadonlySet<string> = new Set()): { eff: Array<{ id: string; sim: number }>; guard: Array<{ id: string; sim: number }> } {
  const xs = Object.entries(vecs).filter(([id]) => !exclude.has(id)).map(([id, v]) => ({ id, sim: Math.round(cosine(sv, v) * 1000) / 1000 })).sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id));
  return { eff: xs.slice(0, k), guard: xs.slice(k, 2 * k) };
}
/** ⑥ 手で選んだ問題との突き合わせ（RAG が外した問題の数） */
export function ragMissOf(rag: readonly string[], hand: readonly string[]): { hit: string[]; missed: string[]; share: number | null } {
  const set = new Set(rag); const hit = hand.filter((h) => set.has(h));
  return { hit, missed: hand.filter((h) => !set.has(h)), share: hand.length ? Math.round((hit.length / hand.length) * 100) / 100 : null };
}
export const EXAM_PROBLEM_RAG_MODE = (env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}) => { const v = (env.EXAM_PROBLEM_RAG ?? "").trim().toLowerCase(); return v === "on" ? "on" : "shadow"; };
/** ⑤ 前の回との比べ（純関数）: そのスイッチを on にした回（同時の on が maxCo 以下）で走った問題＝今の選び。
 *   今の選び: 走った問題のうち印が出た割合。RAG: 候補のうち走った問題で印が出た割合・まだ走っていない候補の数（昼の届きの確かめに回す）。
 *   費用は問題 1問の費用（辞書の unitUsd）の和 */
export type RagEvalRun = { label: string; switches: readonly string[]; rows: ReadonlyArray<{ id: string; marks: Record<string, unknown> }> };
export function ragEvalOf(sw: string, marks: readonly string[], runs: readonly RagEvalRun[], ragIds: readonly string[], unitUsd: (id: string) => number = () => 0, maxCo = 3) {
  const mine = runs.filter((r) => r.switches.includes(sw) && r.switches.length <= maxCo);
  const ran = new Map<string, boolean>();
  for (const r of mine) for (const row of r.rows) { const hit = marks.some((k) => Number(row.marks?.[k] ?? 0) > 0); ran.set(row.id, (ran.get(row.id) ?? false) || hit); }
  const ranIds = [...ran.keys()]; const reached = ranIds.filter((id) => ran.get(id));
  const ragRan = ragIds.filter((id) => ran.has(id)); const ragReached = ragRan.filter((id) => ran.get(id));
  const share = (a: number, b: number) => (b ? Math.round((a / b) * 100) / 100 : null);
  const usd = (ids: readonly string[]) => Math.round(ids.reduce((a, id) => a + unitUsd(id), 0) * 1000) / 1000;
  return {
    sw, runs: mine.map((r) => r.label),
    now: { n: ranIds.length, reached: reached.length, share: share(reached.length, ranIds.length), usd: usd(ranIds), usdPerReached: reached.length ? Math.round((usd(ranIds) / reached.length) * 1000) / 1000 : null },
    rag: { n: ragIds.length, ran: ragRan.length, reached: ragReached.length, share: share(ragReached.length, ragRan.length), notRun: ragIds.filter((id) => !ran.has(id)) },
    reachedMissedByRag: reached.filter((id) => !ragIds.includes(id)),
  };
}
/** ② の書き直し（統括役 11/27「部品のコメントの言葉ではなく、効く場面を竹内さんの会話の言葉（お客様の通の例）で」）:
 *   問題の場面の形（sceneShapeText）と同じ書き方で、効く場面を書く。届いた例が無いスイッチだけ使う（届いた例があれば重心で引く方が強い・1つ抜きで 23/46 対 説明 3/46） */
export const SWITCH_SCENE_WORDS: Record<string, string> = {
  PICKUP_WHY_TO_BRAIN: [
    "場面: 物件を送った後 / other:その他・物件を送った後",
    "直前のお客様: 送って頂いたお部屋見ました。ちょっと駅から遠いですね。こちらの2件目は思ったより狭いです。1件目が気になります",
    "流れ: スタッフ(AIX): 🌟（オススメポイント）・初期費用を抑えてご入居頂けます / スタッフ: ご条件に近いお部屋ピックアップさせて頂きました / 客: 送って頂いたお部屋見ました",
    "写しの材料: aix_usage_logs:3, property_pickups:5, sent_properties:5",
    "正解: 返信",
  ].join("\n"),
  APPLY_ROUTE_NEXT_BY_TURN: [
    "場面: 内覧の前後・申込の手前 / 質問の番",
    "直前のお客様: 内覧は土曜の14時でお願いします。初期費用はだいたいいくらくらいになりますか？申込はどうしたら良いですか",
    "流れ: スタッフ: 内覧のご希望日時をお伺いしてもよろしいでしょうか / 客: 内覧は土曜の14時でお願いします",
    "写しの材料: aix_usage_logs:2, sent_properties:3",
    "正解: 返信・AIX:内覧",
  ].join("\n"),
  BRAIN_CHECK_PROMISE_FLOW: [
    "場面: お客様が物件を送ってきた / property_share:送っただけ",
    "直前のお客様: ありがとうございます！よろしくお願いします",
    "流れ: 客: こちらのお部屋まだ空いてますか？ https://suumo.jp/chintai/bc_[番号非表示]/ by SUUMO / スタッフ: ありがとうございます！！こちらのお部屋確認させて頂きます！！ / 客: ありがとうございます！よろしくお願いします",
    "写しの材料: aix_usage_logs:2, sent_properties:1",
    "正解: 返信・AIX:property_check_result",
  ].join("\n"),
};
/** 2段の引き方（純関数）: 届いた例が2問以上なら重心・場面の言葉があればそれ・無ければ説明 */
export function ragQueryModeOf(reached: number, hasScene: boolean): "重心" | "場面の言葉" | "説明" { return reached >= 2 ? "重心" : hasScene ? "場面の言葉" : "説明"; }
export function centroidOf(ids: readonly string[], vecs: Readonly<Record<string, readonly number[]>>): number[] | null {
  const xs = ids.map((id) => vecs[id]).filter((v): v is readonly number[] => !!v); if (!xs.length) return null;
  const c = new Array<number>(xs[0].length).fill(0); for (const v of xs) for (let i = 0; i < c.length; i++) c[i] += v[i] / xs.length; return c;
}
/** 前の on の回で印が出た問題（純関数・同時の on が maxCo 以下の回だけ） */
export function reachedIdsOf(sw: string, marks: readonly string[], runs: readonly RagEvalRun[], maxCo = 3): string[] {
  const s = new Set<string>();
  for (const r of runs) if (r.switches.includes(sw) && r.switches.length <= maxCo) for (const row of r.rows) if (marks.some((k) => Number(row.marks?.[k] ?? 0) > 0)) s.add(row.id);
  return [...s].sort();
}

// ── 2026-11-27 夜 作業員L（統括役の頼み・作業員A の報告「近さが 0.50〜0.60 に固まり、お礼だけ・送っただけの番に寄る」）: 場面の形の文 v2 ──
//   v1 は流れ4通（スタッフの長い定型の文・URL）と写しの材料の数が文の大半＝どの問題も似て、お客様の言葉の差が埋もれた。
//   v2: ① お客様の直前の文から決まり文句（お礼・了承・挨拶・絵文字・URL）を外して先頭に2回（比重を上げる）② 外して何も残らなければ「（お礼・了承だけ）」の1語
//       ③ こちらの直前の1通だけ・定型を外して 40字 ④ 材料は表の名前だけ（数を書かない）⑤ 正解の手と本番のブレインは残す
const BOILER_RE = /(?:本当に|大変|とても)?(?:ありがとう(?:ございます|ございました|ござます)?|有難う(?:ございます)?|よろしく(?:お願い(?:いた|致)?します|お願いします|です)?|宜しく(?:お願い(?:いた|致)?します)?|承知(?:しました|致しました|いたしました)|かしこまりました|了解(?:です|しました|致しました)?|お疲れ様です|お世話になって(?:おります|います)|失礼(?:します|致します|いたします)|すみません|はい|わかりました|分かりました|助かります|お願いします)[！!。、,.～〜ー…]*/g;
const URL_RE = /https?:\/\/\S+|by SUUMO|\[番号非表示\]/g;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const STAFF_TEMPLATE_RE = /(?:お手隙の際に)?ご査収(?:ください|下さい)[^。！!]*|お気軽にご連絡(?:ください|下さい)[^。！!]*|失礼致します[！!]*|[^。！!\n]*さん(?:夜分遅くに|お世話になっております)[^。！!\n]*|（オススメポイント）|（室内イメージ）|🌟/g;
export function stripBoilerplate(s: string): string {
  return s.replace(URL_RE, " ").replace(EMOJI_RE, "").replace(BOILER_RE, " ").replace(/[！!。、,.\s]+/g, " ").trim();
}
export function sceneShapeTextV2(p: RagProblemIn, mask: (s: string) => string): string {
  const cust = stripBoilerplate(oneLine(mask(p.customer ?? "")));
  const custLine = cust.length >= 2 ? clip(cust, 220) : "（お礼・了承だけ）";
  const lastStaff = [...(p.context ?? [])].reverse().find((c) => c.s !== "customer");
  const staff = lastStaff ? clip(stripBoilerplate(oneLine(mask(String(lastStaff.t ?? "")).replace(STAFF_TEMPLATE_RE, " "))), 40) : "";
  const asks = (p.asks ?? []).map((a) => `${clip(stripBoilerplate(oneLine(mask(a.q ?? ""))), 40)}→${a.route ?? ""}`);
  const mats = snapshotMaterialsOf(p.ledger).map(([k]) => k);
  return [
    `お客様: ${custLine}`,
    `お客様: ${custLine}`,
    asks.length ? `依頼: ${asks.join(" / ")}` : "",
    `場面: ${p.type ?? "?"} / ${p.sub ?? "?"}`,
    staff ? `こちらの直前: ${lastStaff?.aix ? "AIX " : ""}${staff}` : "",
    `正解: ${(p.accept ?? []).join("・") || "?"}${p.mustNot?.length ? ` / 避ける: ${p.mustNot.join("・")}` : ""}`,
    p.prodBrain?.action ? `本番のブレイン: ${p.prodBrain.action}` : "",
    mats.length ? `材料: ${mats.join("・")}` : "",
  ].filter(Boolean).join("\n");
}
/** v2 の場面の言葉（問題の文と同じ書き方・届いた例の無い部品）。お客様の言葉を先頭に2回 */
export const SWITCH_SCENE_WORDS_V2: Record<string, string> = {
  PICKUP_WHY_TO_BRAIN: "お客様: 送って頂いたお部屋見ました ちょっと駅から遠いですね 2件目は思ったより狭いです 1件目が気になります\nお客様: 送って頂いたお部屋見ました ちょっと駅から遠いですね 2件目は思ったより狭いです 1件目が気になります\n場面: 物件を送った後 / other:その他・物件を送った後\nこちらの直前: AIX ご条件に近いお部屋をピックアップしました\n正解: 返信\n材料: property_pickups・sent_properties・aix_usage_logs",
  APPLY_ROUTE_NEXT_BY_TURN: "お客様: 内覧は土曜の14時でお願いします 初期費用はだいたいいくらくらいになりますか 申込はどうしたら良いですか\nお客様: 内覧は土曜の14時でお願いします 初期費用はだいたいいくらくらいになりますか 申込はどうしたら良いですか\n場面: 内覧の前後・申込の手前 / 質問の番\nこちらの直前: 内覧のご希望日時をお伺いしてもよろしいでしょうか\n正解: 返信・AIX:内覧",
  BRAIN_CHECK_PROMISE_FLOW: "お客様: （お礼・了承だけ）\nお客様: （お礼・了承だけ）\n場面: お客様が物件を送ってきた / property_share:送っただけ\nこちらの直前: こちらのお部屋確認させて頂きます\n正解: 返信・AIX:property_check_result\n材料: aix_usage_logs・sent_properties",
  ACK_SOFT_NEXT: "お客様: このお部屋すごく良いですね 間取りも好みです 駐車場は空いてますか\nお客様: このお部屋すごく良いですね 間取りも好みです 駐車場は空いてますか\n場面: 物件への反応 / 好意・中身の質問\nこちらの直前: AIX オススメのお部屋をお送りしました\n正解: 返信 / 避ける: 2段:pickup\n材料: sent_properties・aix_usage_logs",
  SEARCH_CHOICE_TWO_MODE_SPLIT: "お客様: 他にも条件に合うお部屋ありますか もう少し探してほしいです\nお客様: 他にも条件に合うお部屋ありますか もう少し探してほしいです\n場面: 出し切り / 物件を送った後の言い足し\nこちらの直前: AIX ご条件に近いお部屋全てピックアップさせて頂きました\n正解: 返信・AIX:左右 / 避ける: AIX:zenryoku_support・右:全力\n材料: sent_properties・aix_usage_logs",
  CHECK_NOW_POSSIBLE_LINE: "お客様: こちらのお部屋まだ空いてますか 内装の写真もありますか\nお客様: こちらのお部屋まだ空いてますか 内装の写真もありますか\n場面: 物件を送ってきた・空きの質問 / property_share:質問つき\nこちらの直前: 確認させて頂きます\n正解: AIX:property_check_result / 避ける: 2段:check\n材料: aix_usage_logs・sent_properties",
  PICKUP_FIT_NOW_LINE: "お客様: やっぱり2階以上で駅から10分以内がいいです 予算は8万までで\nお客様: やっぱり2階以上で駅から10分以内がいいです 予算は8万までで\n場面: 探す約束の後・条件の言い直し / conditions:言い直し\nこちらの直前: ご条件に合うお部屋お探しさせて頂きます\n正解: AIX:物件・返信 / 避ける: 2段:pickup\n材料: property_pickups・aix_usage_logs",
};
/** 2026-11-27 夜（統括役の決め）: 3段の引き方（純関数）。① 届いた例が2問以上＝重心 ② 無ければ形の当てはめ（作業員A の決まった計算）の候補を RAG で並べ替える
 *   ③ 昼の届きの確かめで例が2問できたら①へ（呼ぶ側が reached を足す）。形の当てはめも無ければ 場面の言葉 → 説明 の順（今までの2段） */
export type RagMode3 = "重心" | "形の当てはめ" | "場面の言葉" | "説明";
export function ragQueryMode3(reached: number, hasShape: boolean, hasScene: boolean): RagMode3 { return reached >= 2 ? "重心" : hasShape ? "形の当てはめ" : hasScene ? "場面の言葉" : "説明"; }
/** ② の並べ替え（純関数）: 形の当てはめの候補だけを、近さの順に並べる（候補の外の問題は足さない＝RAG は並べ替えだけ） */
export function rerankWithin(ids: readonly string[], q: readonly number[], vecs: Readonly<Record<string, readonly number[]>>): Array<{ id: string; sim: number }> {
  return ids.filter((id) => vecs[id]).map((id) => ({ id, sim: Math.round(cosine(q, vecs[id]) * 1000) / 1000 })).sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id));
}
export type ShapeCandidates = { eff: string[]; guard: string[]; why?: string };
/** 形の当てはめの置き場（作業員A の関数が来るまでの受け口）: { v: 1, switches: { 名前: { eff, guard, why } } } */
export function shapeCandidatesFrom(json: unknown, sw: string): ShapeCandidates | null {
  const s = (json as { v?: number; switches?: Record<string, ShapeCandidates> } | null)?.switches?.[sw];
  return s && Array.isArray(s.eff) ? { eff: s.eff, guard: Array.isArray(s.guard) ? s.guard : [], why: s.why } : null;
}
