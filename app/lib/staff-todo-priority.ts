// app/lib/staff-todo-priority.ts — 【やることリスト】のお客様の並び（組と点・「なぜ上か」）（純関数・DB も LLM もなし）
//
// 2026-10-21 竹内さんの決定:
//   268a904a「ターゲットかつやることあるお客様を最優先」／cb760598「新規の問い合わせも優先度がかなり高い」→ 組の順
//     ①ターゲットかつやることあり ②新規の問い合わせ（初回の返信・条件ヒアリング・最初の物件送付まで） ③その他のやることあり ④ターゲットの毎日の新着確認だけ
//   1214dc48「優先度を決める所を強化する」→ 組の中は点: お客様の熱（新規・内覧歴・申込歴・反応）・申込までの近さ（地図の駅）・期限の遅れ・
//     売上（AD・利益＝今は材料なし・入れ口だけ）・放置の長さ。迷う所（同点）は今は決まった順（最初に立った順→会話 ID）。
//     将来は司令塔（つなぎのブレイン）が決める入れ口 TodoConductor を置く（今は何もしない）。結果から重みを学ぶのも将来（重みは1か所＝TODO_SCORE_WEIGHTS）
// テスト: app/lib/__tests__/staff-todo-priority.test.ts
import type { TargetTier } from "./brain-attention";

export type TodoGroup = 1 | 2 | 3 | 4 | 5;
/**
 * 組の見出しの名前。2026-10-21: 丸数字（①〜⑤）は行の番号（「☑3」と返す番号）と同じ字で見分けにくいので、見出しは「1.」の形
 *   （「━ 3. やること ━」の下の「③…」の行と取り違えないように）。行の番号は丸数字のまま
 */
export const TODO_GROUP_LABEL: Record<TodoGroup, string> = {
  1: "1. ターゲット×やること",
  2: "2. 新規の問い合わせ",
  3: "3. やること",
  4: "4. ターゲットの新着確認",
  5: "5. その他の新着確認",
};

/** お客様ごとの材料（読み手が DB とハブから作る・無い物は undefined） */
export type TodoPrioritySignal = {
  /** ターゲットの段（brain-attention.classifyTarget）。ターゲットでなければ null */
  tier?: TargetTier | null;
  /** 申込歴あり（再探し） */
  reapply?: boolean;
  /** 新規の問い合わせ（まだ物件を一度も送っていない新しいお客様・ターゲットの「新規」） */
  newInquiry?: boolean;
  /** 申込までの地図の駅の番号（0=問い合わせ … 10=申込中。ハブの where.node／無ければ状態と AIX から） */
  routeIndex?: number;
  /** 最後のお客様の発言（反応の新しさ） */
  lastCustomerAt?: string | null;
  /** ハブの反応（良い反応の物件の数） */
  goodReactions?: number;
  /** 売上の見込み（AD・利益の円。今は材料なし＝入れ口だけ） */
  profitYen?: number | null;
  /** 【その他 本日のリスト】から入れた毎日の新着確認（ターゲットでない・7日以上送っていない人）＝いちばん下の組 */
  otherDaily?: boolean;
};
/** お客様の並びに使う、行から数えた数 */
export type TodoCustomerFacts = {
  hasOpenTask: boolean;        // 新着確認の行以外の残り
  hasOpenNewArrival: boolean;  // 新着確認の行の残り
  maxOverdueDays: number;
  maxElapsedDays: number;
  /** いちばん早く立った時刻（同点の時の決まった順） */
  firstOriginMs: number;
};

/** 点の重み（1か所。結果から学ぶ時はここを変える） */
export const TODO_SCORE_WEIGHTS = {
  tier: { viewed: 40, screening_failed: 40, contact_due: 25, new: 25, engaged: 15 } as Record<TargetTier, number>,
  reapply: 40,
  newInquiry: 25,
  reaction24h: 10,
  goodReaction: 5,
  routePerStation: 3,
  overduePerDay: 12, overdueCapDays: 5,
  profitPer10k: 2, profitCap: 20,
  neglectPerDay: 3, neglectCapDays: 10,
};

const HEAT_LABEL: Record<TargetTier, string> = { viewed: "内覧済み", screening_failed: "審査落ち", contact_due: "連絡の約束日", new: "新規", engaged: "物件検索中" };

export function todoGroupOf(s: TodoPrioritySignal, f: TodoCustomerFacts): TodoGroup {
  const isTarget = !!s.tier || !!s.reapply;
  if (f.hasOpenTask) {
    if (s.newInquiry || s.tier === "new") return 2;
    if (isTarget) return 1;
    return 3;
  }
  if (isTarget) return 4;
  if (s.otherDaily) return 5;
  return 3;
}

export type TodoScore = { score: number; why: string; parts: Array<{ label: string; points: number }> };
/** 点と「なぜ上か」（15字まで・いちばん効いた理由から） */
export function todoScore(s: TodoPrioritySignal, f: TodoCustomerFacts, nowMs: number): TodoScore {
  const W = TODO_SCORE_WEIGHTS;
  const parts: Array<{ label: string; points: number }> = [];
  if (s.reapply) parts.push({ label: "申込歴あり", points: W.reapply });
  else if (s.tier) parts.push({ label: HEAT_LABEL[s.tier], points: W.tier[s.tier] });
  if (s.newInquiry && s.tier !== "new") parts.push({ label: "新規の問い合わせ", points: W.newInquiry });
  const lc = Date.parse(s.lastCustomerAt ?? "");
  if (Number.isFinite(lc) && nowMs - lc <= 24 * 3600_000 && nowMs >= lc) parts.push({ label: "今日反応あり", points: W.reaction24h });
  if ((s.goodReactions ?? 0) > 0) parts.push({ label: "良い反応あり", points: W.goodReaction });
  if (typeof s.routeIndex === "number" && s.routeIndex > 0) parts.push({ label: "申込に近い", points: s.routeIndex * W.routePerStation });
  if (f.maxOverdueDays > 0) parts.push({ label: `期限${f.maxOverdueDays}日過ぎ`, points: Math.min(f.maxOverdueDays, W.overdueCapDays) * W.overduePerDay });
  if (s.profitYen && s.profitYen > 0) parts.push({ label: "売上大", points: Math.min(W.profitCap, Math.floor(s.profitYen / 10_000) * W.profitPer10k) });
  if (f.maxElapsedDays > 0) parts.push({ label: `放置${f.maxElapsedDays}日`, points: Math.min(f.maxElapsedDays, W.neglectCapDays) * W.neglectPerDay });
  const score = parts.reduce((a, p) => a + p.points, 0);
  const top = [...parts].sort((a, b) => b.points - a.points);
  let why = top[0]?.label ?? "";
  if (top[1] && `${why}・${top[1].label}`.length <= 15) why = `${why}・${top[1].label}`;
  return { score, why: why.slice(0, 15), parts };
}

/**
 * 司令塔の入れ口（将来つなぎのブレインが同点・迷う所の順を決める）。今は渡されなければ何もしない＝決まった順のまま。
 * 受け取るのは並べた後のお客様（組と点つき）、返すのは並べ直したお客様（同じ物の並べ替えだけ。足す・消すはしない）
 */
export type TodoConductor = <T extends { conversationId: string; group: TodoGroup; score: number }>(ordered: T[]) => T[];

/** 組 → 点（高い順） → 最初に立った順 → 会話 ID（決まった順） */
export function compareTodoPriority(
  a: { group: TodoGroup; score: number; done: boolean; firstOriginMs: number; conversationId: string },
  b: { group: TodoGroup; score: number; done: boolean; firstOriginMs: number; conversationId: string },
): number {
  return a.group - b.group
    || (a.done ? 1 : 0) - (b.done ? 1 : 0)
    || b.score - a.score
    || (Number.isFinite(a.firstOriginMs) ? a.firstOriginMs : Infinity) - (Number.isFinite(b.firstOriginMs) ? b.firstOriginMs : Infinity)
    || (a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0);
}

/** 並べた後に司令塔へ渡す（渡された物が足し引きしていたら元の順を使う） */
export function applyConductor<T extends { conversationId: string; group: TodoGroup; score: number }>(ordered: T[], conductor?: TodoConductor | null): T[] {
  if (!conductor) return ordered;
  try {
    const out = conductor([...ordered]);
    const ids = (xs: T[]) => xs.map((x) => x.conversationId).sort().join(",");
    return out.length === ordered.length && ids(out) === ids(ordered) ? out : ordered;
  } catch { return ordered; }
}
