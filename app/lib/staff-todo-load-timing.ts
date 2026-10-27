// app/lib/staff-todo-load-timing.ts — 【やることリスト】の読み込みの時間の決まり（純関数・DB も LLM もなし）
//
// 2026-10-28 調べ（10/26 午後からグループに出なくなった件・/api/cron/staff-todo-list の 60秒の時間切れ）:
//   件数は小さい（AIX要対応 30日 526・約束 60日 455・49時間の発言 555＝55会話）のに、DB が遅い時間帯（statement timeout・522 が
//   10/26〜27 に集中）に 会話100件ごとの塊を順に待つ → ハブ（customer-hub）を予算 20秒まで読む → その他の本日のリストを後から読む、が重なって
//   60秒を超えた。どの段が遅いかがログに残っていなかった。
//   直し（STAFF_TODO_FAST_LOAD=on の時だけ・既定 off＝今まで通り）:
//     ① 段ごとの所要時間を1行の札（tag: staff-todo:timing）に出す（札は切替に関係なく出す＝読むだけ・動きは変えない）
//     ② ハブの予算を「残り時間」から決める（route の maxDuration の締め切りから組み立て・送信の分を残す）
//     ③ その他の本日のリストの読み込みを最初の読み込みと並べて走らせる（ターゲットで外すのは読み終えてから）
//     ④ 会話の塊の中の 申込歴あり・2番手の読みを並べる
// テスト: app/lib/__tests__/staff-todo-load-timing.test.ts

/** 速い読み方（③④と②の締め切り）を使うか（既定 off・STAFF_TODO_FAST_LOAD=on で入れる） */
export function staffTodoFastLoadEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.STAFF_TODO_FAST_LOAD ?? "").trim().toLowerCase() === "on";
}

/** 締め切りの後に残す時間（組み立て・LINE への送信・控えの保存） */
export const TODO_SEND_RESERVE_MS = 15_000;
/** ハブを読む最小の時間（これより短ければ読まない＝行と状態から数える） */
export const TODO_HUB_MIN_MS = 2_000;

/**
 * ハブを読む時間の上限。締め切り（deadlineAtMs）が無い時は今まで通り baseMs。
 * 締め切りがある時は min(baseMs, 締め切り − 今 − 残す時間)。残りが TODO_HUB_MIN_MS 未満なら 0（読まない）。
 */
export function hubBudgetMs(o: { baseMs: number; nowMs: number; deadlineAtMs?: number | null; reserveMs?: number }): number {
  const base = Number.isFinite(o.baseMs) && o.baseMs > 0 ? o.baseMs : 0;
  if (o.deadlineAtMs == null || !Number.isFinite(o.deadlineAtMs)) return base;
  const left = o.deadlineAtMs - o.nowMs - (o.reserveMs ?? TODO_SEND_RESERVE_MS);
  if (left < TODO_HUB_MIN_MS) return 0;
  return Math.min(base, left);
}

/** route の maxDuration（秒）と始まりの時刻から、読み込みの締め切り（ms）を作る */
export function todoDeadlineAtMs(startedAtMs: number, maxDurationSec: number): number {
  return startedAtMs + Math.max(0, maxDurationSec) * 1000;
}

/** 段ごとの所要時間（ms）。mark(name) はその段の終わり＝前の印からの時間を記録する */
export type StageTimer = { mark: (stage: string) => void; stages: () => Record<string, number>; totalMs: () => number };
export function createStageTimer(now: () => number = () => Date.now()): StageTimer {
  const start = now();
  let last = start;
  const out: Record<string, number> = {};
  return {
    mark(stage: string) { const t = now(); out[stage] = (out[stage] ?? 0) + (t - last); last = t; },
    stages: () => ({ ...out }),
    totalMs: () => now() - start,
  };
}

/** 締め切りまでに終わらない約束は待たずに fallback を返す（中の処理は止まらないが、読み手は先へ進む） */
export async function withinDeadline<T>(p: Promise<T>, leftMs: number, fallback: T): Promise<T> {
  if (!(leftMs > 0)) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((res) => { timer = setTimeout(() => res(fallback), leftMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
