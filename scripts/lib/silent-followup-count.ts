// scripts/lib/silent-followup-count.ts — #805: やることリストの「追い」の行（STAFF_TODO_SILENT_FOLLOWUP）が出る番と、その後スタッフが実際に追いを送ったか（純関数・DB/LLM なし）
// 2026-11-28 作業員A（統括役の決め (a)・on にするかは push の後の数日分の数で決める）
//   行の出る条件は app/lib/staff-todo-list.ts の ④-2 と同じ（最後がこちらの通・24〜48時間・窓 49時間の内にお客様の通・前のこちらの通が約束でない）。
//   ただし AIX 要対応・お約束の行がある会話は過去の時点を作り直せないので外していない＝行の数は上限（多めに出る）。
import { SILENT_FOLLOWUP_MIN_MS, SILENT_FOLLOWUP_MAX_MS, SILENT_PROMISE_BEFORE_RE } from "../../app/lib/staff-todo-list";

export type SfMsg = { sender: string; text: string | null; created_at: string; staff_writer?: string | null; is_aix_generated?: boolean | null };
/** その後: 行が出ている間（24〜48時間）にスタッフが追った／48時間より後に追った／追いの前にお客様が戻った／まだ何も無い（窓の中・窓の後） */
export type SfOutcome = "followed_in_window" | "followed_late" | "customer_back_first" | "open_in_window" | "none_after_window";
export type SfEpisode = {
  lastOursAt: string; rowFrom: string; outcome: SfOutcome;
  /** 追いの通（あれば） */
  followAt?: string; followWriter?: string | null; followAix?: boolean;
  /** 追いの後 72時間以内にお客様が返事した */
  backAfterFollow?: boolean;
};

const MS_49H = 49 * 3600_000;
const MS_72H = 72 * 3600_000;
const t = (s: string) => Date.parse(s);

/** msgs は1つの会話の通（順は問わない）。nowMs までに行が出た番（最後のこちらの通から24時間たった番）を全部返す */
export function silentEpisodesOf(msgs: readonly SfMsg[], nowMs: number): SfEpisode[] {
  const ms = [...msgs].filter((m) => Number.isFinite(t(m.created_at))).sort((a, b) => t(a.created_at) - t(b.created_at));
  const out: SfEpisode[] = [];
  for (let i = 0; i < ms.length; i++) {
    const last = ms[i];
    if (last.sender === "customer") continue;
    const next = ms[i + 1];
    const from = t(last.created_at) + SILENT_FOLLOWUP_MIN_MS;
    if (from > nowMs) continue; // まだ24時間たっていない
    if (next && t(next.created_at) <= from) continue; // 24時間の内に次の通がある＝止まっていない
    // 行が初めて出る時の窓（49時間）にお客様の通がある（ずっと前から止まっている会話は数えない）
    if (!ms.some((m) => m.sender === "customer" && t(m.created_at) >= from - MS_49H && t(m.created_at) < from)) continue;
    if (SILENT_PROMISE_BEFORE_RE.test(last.text ?? "")) continue;
    const ep: SfEpisode = { lastOursAt: last.created_at, rowFrom: new Date(from).toISOString(), outcome: "none_after_window" };
    const until = t(last.created_at) + SILENT_FOLLOWUP_MAX_MS;
    if (!next) ep.outcome = nowMs < until ? "open_in_window" : "none_after_window";
    else if (next.sender === "customer") ep.outcome = "customer_back_first";
    else {
      ep.outcome = t(next.created_at) < until ? "followed_in_window" : "followed_late";
      ep.followAt = next.created_at; ep.followWriter = next.staff_writer ?? null; ep.followAix = !!next.is_aix_generated;
      const back = ms.slice(i + 2).find((m) => m.sender === "customer");
      ep.backAfterFollow = !!back && t(back.created_at) - t(next.created_at) <= MS_72H;
    }
    out.push(ep);
  }
  return out;
}

export const SF_OUTCOME_JA: Record<SfOutcome, string> = {
  followed_in_window: "行が出ている間（24〜48時間）にスタッフが追った",
  followed_late: "48時間より後に追った",
  customer_back_first: "追いの前にお客様が戻った",
  open_in_window: "まだ行が出ている（今の窓の中）",
  none_after_window: "48時間の内に誰も送らなかった",
};
