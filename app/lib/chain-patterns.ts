// app/lib/chain-patterns.ts — 連鎖の型（同時にそろっていた材料の組 → 竹内さんの一手）（竹内さん 11/26「パズルのように組み合わせて連鎖させていく・実際の脳のように連携させていく」・純関数・DB/LLM なし）
// 2026-11-26 作業員A（統括役の頼み・台帳 p0・作業員L と分け合う）:
//   ① 番ごとの材料の印（駅・駅の中の状態・前に送った AIX とその日数）を決まった計算で並べ、組（駅＋印2つまで）ごとに竹内さん本人の一手の過半数を数える。
//      駅だけでは決まらない（過半数が低い）のに、組にすると決まる（過半数が 20pt 以上上がる・n≥5）＝「1つでは足りない所」＝連鎖の型
//   ② 当てはまった型を1行の「見立て」（A がそろっている＋B → 竹内さん本人は D）にして、ブレインの材料（控えの行 chain_insight）に。既定 off（CHAIN_INSIGHT_LINE）。
//      前例（ブレインの出力に欄を足すと道がずれた q406）を踏まえ、出力の欄は足さない・決め直させない＝材料の1行で「決めるのはあなた」
import { CHAIN_PATTERNS_REPLY } from "./chain-patterns-reply";
export type ChainFeatures = { station: string; sub: string | null; marks: string[] };
const DAY = 864e5;
/** 前に送った AIX の印（種類×日数の幅）。sentBefore＝AIX の種類 → 一番新しい送った時刻 */
export function sentMarksOf(sentBefore: Record<string, string> | null | undefined, T: number): string[] {
  const out: string[] = [];
  for (const [k, at] of Object.entries(sentBefore ?? {})) {
    const d = (T - Date.parse(at)) / DAY;
    if (!(d >= 0)) continue;
    const short = ({ estimate_sheet: "見積", property_send: "物件", property_recommendation: "物件", property_check_result: "確認", viewing_invite: "内覧誘い", meeting_place: "集合", greeting_viewing: "当日", condition_hearing: "聞き取り", application_push: "申込案内" } as Record<string, string>)[k];
    if (!short) continue;
    out.push(`${short}${d <= 1 ? ":今日" : d <= 3 ? ":3日内" : ":前"}`);
  }
  return [...new Set(out)].sort();
}
export function featuresOf(r: { node: string | null; branch: string | null; sub1?: string | null; sentBefore?: Record<string, string>; at: string }): ChainFeatures {
  return { station: r.branch ? `分:${r.branch}` : String(r.node ?? "other"), sub: r.sub1 ?? null, marks: sentMarksOf(r.sentBefore, Date.parse(r.at)) };
}
/** 組の鍵（駅＋状態＋印2つまで）。印の少ない組から順に */
export function comboKeysOf(f: ChainFeatures): string[] {
  const base = [f.station, ...(f.sub ? [`状態:${f.sub}`] : [])];
  const ms = f.marks;
  const keys = [base.join("+")];
  for (let i = 0; i < ms.length; i++) { keys.push([...base, ms[i]].join("+")); for (let j = i + 1; j < ms.length; j++) keys.push([...base, ms[i], ms[j]].join("+")); }
  return keys;
}
export type ChainPattern = { key: string; parts: string[]; move: string; share: number; n: number; stationShare: number; lift: number };
/** 型を数える（純関数）: rows＝竹内さん本人の番（act＝一手）。minN 以上・駅だけより lift 以上上がる組 */
export function chainPatternsOf(rows: ReadonlyArray<{ f: ChainFeatures; act: string }>, minN = 5, minLift = 20): ChainPattern[] {
  const by = new Map<string, string[]>();
  for (const r of rows) for (const k of comboKeysOf(r.f)) by.set(k, [...(by.get(k) ?? []), r.act]);
  const maj = (acts: string[]) => { const c: Record<string, number> = {}; for (const a of acts) c[a] = (c[a] ?? 0) + 1; const [m, v] = Object.entries(c).sort((a, b) => b[1] - a[1])[0] ?? ["", 0]; return { m, share: acts.length ? Math.round((v / acts.length) * 1000) / 10 : 0 }; };
  const out: ChainPattern[] = [];
  for (const [k, acts] of by) {
    const parts = k.split("+"); if (parts.length < 2 || acts.length < minN) continue;
    const st = by.get(parts[0]) ?? acts; const a = maj(acts), s = maj(st);
    if (a.share - s.share >= minLift) out.push({ key: k, parts, move: a.m, share: a.share, n: acts.length, stationShare: s.share, lift: Math.round((a.share - s.share) * 10) / 10 });
  }
  return out.sort((x, y) => y.lift * y.n - x.lift * x.n);
}
/** 型の表（11/26 昼の60日の照らしの json＝竹内さん本人の番 226 から数えた12型・audit-chain-patterns で毎晩数え直す）。
 *   物差し（ブレインの判断が残る 111番）: 型が当てはまった番 28 で合う 57.1%・当てはまらない番 83 で 49.4%（+7.7pt）
 *   例: 見積の駅＋今日見積書を送った → 竹内さんは内覧の誘いの返信（駅だけ 33% → 67%）・ヒアリング＋予算を超える物件の状態 → 確かめる約束（43% → 83%） */
export const CHAIN_PATTERNS: readonly ChainPattern[] = [
  {"key":"hearing+状態:cost_over_budget","parts":["hearing","状態:cost_over_budget"],"move":"reply:promise","share":83.3,"n":6,"stationShare":42.9,"lift":40.4},
  {"key":"estimate+見積:今日","parts":["estimate","見積:今日"],"move":"reply:invite_viewing","share":66.7,"n":6,"stationShare":33.3,"lift":33.4},
  {"key":"viewing_scheduled+物件:前","parts":["viewing_scheduled","物件:前"],"move":"reply:answer","share":75,"n":8,"stationShare":50,"lift":25},
  {"key":"hearing+状態:apply_screening_worry","parts":["hearing","状態:apply_screening_worry"],"move":"reply:promise","share":80,"n":5,"stationShare":42.9,"lift":37.1},
  {"key":"viewing_scheduled+内覧誘い:今日+見積:今日","parts":["viewing_scheduled","内覧誘い:今日","見積:今日"],"move":"aix:greeting_viewing","share":80,"n":5,"stationShare":50,"lift":30},
  {"key":"viewing_scheduled+見積:今日","parts":["viewing_scheduled","見積:今日"],"move":"aix:greeting_viewing","share":80,"n":5,"stationShare":50,"lift":30},
  {"key":"viewing_scheduled+見積:今日+集合:今日","parts":["viewing_scheduled","見積:今日","集合:今日"],"move":"aix:greeting_viewing","share":80,"n":5,"stationShare":50,"lift":30},
  {"key":"viewing_scheduled+物件:前+見積:前","parts":["viewing_scheduled","物件:前","見積:前"],"move":"reply:answer","share":80,"n":5,"stationShare":50,"lift":30},
  {"key":"viewing_scheduled+見積:前","parts":["viewing_scheduled","見積:前"],"move":"reply:answer","share":71.4,"n":7,"stationShare":50,"lift":21.4},
  {"key":"pickup+確認:今日","parts":["pickup","確認:今日"],"move":"reply:answer","share":60,"n":5,"stationShare":34.8,"lift":25.2},
  {"key":"pickup+物件:前","parts":["pickup","物件:前"],"move":"reply:promise","share":60,"n":5,"stationShare":34.8,"lift":25.2},
  {"key":"pickup+物件:今日","parts":["pickup","物件:今日"],"move":"reply:promise","share":60,"n":5,"stationShare":34.8,"lift":25.2},
];
export function chainInsightLineOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CHAIN_INSIGHT_LINE ?? "").trim().toLowerCase() === "on";
}
const MOVE_JA: Record<string, string> = { "reply:promise": "確かめる・探す約束の返信", "reply:invite_viewing": "内覧の誘いの返信", "reply:invite_estimate": "見積の誘いの返信", "reply:answer": "問いへの答えの返信", "reply:wait": "待つ返信", "reply:invite_apply": "申込のご案内の返信",
  "aix:estimate_sheet": "AIX【見積書送る】", "aix:property_send": "AIX【物件ピックアップした】", "aix:property_recommendation": "AIX【物件オススメ】", "aix:property_check_result": "AIX【物件確認した】", "aix:viewing_invite": "AIX【内覧誘い】", "aix:application_push": "AIX【申込へ】", "aix:condition_hearing": "AIX【条件の聞き取り】" };
/** 今の番に当てはまる一番細かい型の見立ての1行（当たらない時は ""・純関数） */
export function chainInsightLine(f: ChainFeatures, patterns: readonly ChainPattern[] = [...CHAIN_PATTERNS, ...CHAIN_PATTERNS_REPLY]): string {
  const keys = new Set(comboKeysOf(f));
  const hit = patterns.filter((p) => keys.has(p.key)).sort((a, b) => b.parts.length - a.parts.length || b.share - a.share)[0];
  if (!hit) return "";
  return `【連鎖の見立て（材料の組・竹内さん本人の60日・決めるのはあなた）】${hit.parts.join("＋")} がそろった番は、竹内さん本人は ${MOVE_JA[hit.move] ?? hit.move}（${hit.share}%・${hit.n}番。駅だけでは ${hit.stationShare}%）`;
}
