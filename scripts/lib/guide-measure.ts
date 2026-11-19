// scripts/lib/guide-measure.ts — 誘導の物差し（純関数・LLM なし・DB なし・費用0）
//
// 2026-11-18 作業員L（竹内さん 11/15「その部分も具体的に細かく強化していく・必要な土台も増やしていく」・統括役の決め 1→2→3→4→5）。
//   ① 竹内さん本人の番ごとに、一手の前と後（次のお客様の返事まで・48時間以内）に、お客様が申込までの地図のどの駅にいたかを数え、
//      進んだ・止まった・戻った・離れた に分ける（申込以降は外す・審査落ちの切り替えは残す）。
//   駅は判断の記録（brain_decision_logs.digest.sg＝customer_stage_now → apply-route-map の駅）で、一手の直前の判断と、返事の後の判断から取る。
//   一手 … AIX の種類（同じ番の AIX）／返信の締めの型（誘いの有無: 内覧・申込・見積・物件・日程・約束・待ち）。
//   返事 … customer-reaction-predict.classifyCustomerBurst（question・thanks・stall・complaint・proceed・silent・other）。48時間で返事が無ければ silent。
// ② 型の表（guideTable）: 駅 × 一手 × 気持ちの状態（今は返事の前のお客様の束の型＝数えられる物だけ）→ 次の駅に進んだ割合。数の少ない組は「少ない」。
// ③ 先読みの数え表（reactionTable）: 一手 → 次の返事の型の割合（customer-reaction-table-data.ts を置き換える案の元）。
import { classifyCustomerBurst, type ReactionCat } from "../../app/lib/customer-reaction-predict";
import { MAIN_ROUTE, type RouteNodeId } from "../../app/lib/apply-route-map";

export type GMsg = { sender: string; text: string | null; created_at: string; staff_writer?: string | null; is_aix_generated?: boolean | null };
export type GAix = { aix_type: string | null; sent_at: string | null; created_at: string };
export type GDecision = { created_at: string; stage: string | null };
export type Outcome = "advanced" | "stuck" | "back" | "left";
export const OUTCOME_JA: Record<Outcome, string> = { advanced: "進んだ", stuck: "止まった", back: "戻った", left: "離れた（48時間返事なし）" };

/** customer-state の段階 → 地図の駅（apply-route-map の STAGE_TO_NODE と同じ・searching は pickup に寄せる） */
const STAGE_NODE: Record<string, RouteNodeId | null> = {
  first: "inquiry", searching: "pickup", proposing: "proposing", interested: "interested", estimate_sent: "estimate",
  viewing_arranging: "viewing_arrange", viewing_scheduled: "viewing_scheduled", viewed: "viewed", apply_prep: "apply_prep",
  applying: "applying", won: null, dropped: null,
  // 旧の checkpoint_stage の値
  hearing: "hearing", viewing: "viewing_arrange", contract: null,
};
export const nodeOfStage = (s: string | null | undefined): RouteNodeId | null => (s ? STAGE_NODE[s] ?? null : null);
const idx = (n: RouteNodeId | null) => (n ? MAIN_ROUTE.indexOf(n) : -1);
const POST_APPLY = new Set<RouteNodeId>(["applying"]);

/** 返信の締めの型（誘いの有無）。竹内さんの文の言葉から決まった形で（作らない・網） */
export function closeKindOf(text: string): string {
  const t = text.normalize("NFKC");
  if (/お申込み?(?:頂|いただ|下さ|ください|され)|お申込みで(?:お部屋を?)?(?:抑|押さ)え/.test(t)) return "invite_apply";
  if (/ご内覧|内覧(?:頂|いただ|のご案内|させて)|ご案内させて頂/.test(t)) return "invite_viewing";
  if (/御見積書|お見積/.test(t) && /(?:作成|お送り)/.test(t)) return "invite_estimate";
  if (/ご都合(?:の)?(?:よろしい|良い)|何時頃|お日にち/.test(t)) return "ask_schedule";
  if (/ピックアップ|お送りさせて頂きます|お調べ|確認(?:出来|でき)次第|確認させて頂きます/.test(t)) return "promise";
  if (/[？?]/.test(t)) return "ask";
  if (/お気軽に|ご検討|ごゆっくり|お待ちしております/.test(t)) return "wait";
  return "answer";
}

export type GuideTurn = {
  conv: string; at: string; act: string; actKind: "aix" | "reply"; before: RouteNodeId | null; after: RouteNodeId | null;
  mood: ReactionCat; reply: ReactionCat; hours: number | null; outcome: Outcome;
};

/** 1つの会話（古い順の messages・AIX の記録・判断の記録）→ 竹内さん本人の番ごとの誘導の記録 */
export function guideTurnsOf(conv: string, msgs: ReadonlyArray<GMsg>, aix: ReadonlyArray<GAix>, decisions: ReadonlyArray<GDecision>, windowH = 48): GuideTurn[] {
  const ms = [...msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const ds = [...decisions].filter((d) => d.stage).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const stageAt = (iso: string, after: boolean) => {
    const t = Date.parse(iso);
    const d = after ? ds.find((x) => Date.parse(x.created_at) >= t) : [...ds].reverse().find((x) => Date.parse(x.created_at) <= t);
    return d ? nodeOfStage(d.stage) : null;
  };
  const out: GuideTurn[] = [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.sender !== "staff" || m.is_aix_generated || m.staff_writer !== "takeuchi") continue;
    // 番＝お客様の束の後の、竹内さんの最初の通（同じ番の続きの通は数えない）
    if (i > 0 && ms[i - 1].sender === "staff") continue;
    const prevCust: string[] = []; for (let j = i - 1; j >= 0 && ms[j].sender === "customer"; j--) prevCust.unshift(String(ms[j].text ?? ""));
    if (!prevCust.length) continue;
    // この番のこちらの通（次のお客様の通まで）と、同じ間の AIX
    let k = i; const ours: string[] = []; while (k < ms.length && ms[k].sender !== "customer") { if (!ms[k].is_aix_generated) ours.push(String(ms[k].text ?? "")); k++; }
    const endAt = k < ms.length ? ms[k].created_at : null;
    const aixHere = aix.find((a) => { const at = a.sent_at ?? a.created_at; return at >= m.created_at && (!endAt || at < endAt); });
    const act = aixHere?.aix_type ? `aix:${aixHere.aix_type}` : `reply:${closeKindOf(ours.join("\n"))}`;
    const before = stageAt(m.created_at, false);
    if (before && POST_APPLY.has(before)) continue; // 申込以降は外す
    const reply: string[] = []; for (let j = k; j < ms.length && ms[j].sender === "customer"; j++) reply.push(String(ms[j].text ?? ""));
    const hours = endAt ? (Date.parse(endAt) - Date.parse(m.created_at)) / 36e5 : null;
    const replied = hours != null && hours <= windowH;
    const after = replied ? stageAt(endAt!, true) : before;
    const outcome: Outcome = !replied ? "left" : idx(after) > idx(before) ? "advanced" : idx(after) < idx(before) && idx(after) >= 0 ? "back" : "stuck";
    out.push({ conv, at: m.created_at, act, actKind: aixHere ? "aix" : "reply", before, after, mood: classifyCustomerBurst(prevCust), reply: replied ? classifyCustomerBurst(reply) : "silent", hours: hours == null ? null : Math.round(hours * 10) / 10, outcome });
  }
  return out;
}

export const FEW = 5;
export type Cell = { n: number; advanced: number; stuck: number; back: number; left: number; few: boolean };
const cell = (): Cell => ({ n: 0, advanced: 0, stuck: 0, back: 0, left: 0, few: true });
/** ② 型の表: 駅 × 一手 × 返事の前の気持ちの型 → 結果の数（数の少ない組は few） */
export function guideTable(turns: ReadonlyArray<GuideTurn>): Map<string, Cell> {
  const m = new Map<string, Cell>();
  for (const t of turns) {
    for (const key of [`${t.before ?? "?"}|${t.act}|*`, `${t.before ?? "?"}|${t.act}|${t.mood}`]) {
      const c = m.get(key) ?? cell(); c.n++; c[t.outcome]++; c.few = c.n < FEW; m.set(key, c);
    }
  }
  return m;
}
/** ③ 先読みの数え表: 一手 → 次の返事の型の数 */
export function reactionTable(turns: ReadonlyArray<GuideTurn>): Map<string, Record<string, number>> {
  const m = new Map<string, Record<string, number>>();
  for (const t of turns) { const r = m.get(t.act) ?? {}; r[t.reply] = (r[t.reply] ?? 0) + 1; m.set(t.act, r); }
  return m;
}
