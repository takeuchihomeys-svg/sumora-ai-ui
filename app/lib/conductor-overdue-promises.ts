// app/lib/conductor-overdue-promises.ts — 期限を過ぎて果たしていないこちらの約束を、入口の統括の材料の1行にする（純関数・DB/LLM なし）
//
// 2026-11-21 作業員N（信頼の土台 #55 の B1・統括役の決め「#435 の見張りに乗せて既定 off で一緒に作る」）:
//   B1 の数え（scripts/audit-promise-kept.ts・30日）で、ピックアップの約束の期限内は 77%・期限を過ぎて果たしていない約束は全体の 7%。
//   見張り（作業員L の promise-drop-watch・#435）と同じ線（種類・期限・果たした印・外す会話）で、今の会話の分を入口の統括に事実だけで渡す。
//   読み（1会話分）は作業員L の overduePromisesFor（promise-drop-watch-server.ts）。ここは並べ方だけ。
//   書くのは事実（種類・約束した日・期限の決まり方・何日過ぎたか）だけ。「送る」「謝る」等の道の言葉は入れない（q057・q069 の教訓・exchange-ledger と同じ）。
// スイッチ: CONDUCTOR_OVERDUE_PROMISES=on（既定 off＝何も足さない・読みもしない）。
import type { OverduePromise } from "./promise-drop-watch";

type Env = Record<string, string | undefined>;
export const conductorOverduePromisesOn = (env: Env = typeof process !== "undefined" ? process.env : {}) =>
  (env.CONDUCTOR_OVERDUE_PROMISES ?? "").trim().toLowerCase() !== "off"; // 2026-11-21 作業員G: 既定 on（①の組 grp-brain-1121 で確かな悪化0）。止める =off

/** 入口の統括で待つ上限（1会話分の読み・これを超えたら何も足さない） */
export const OVERDUE_PROMISES_TIMEOUT_MS = 1500;

const KIND_JA: Record<string, string> = { pickup: "物件のピックアップ", check: "募集状況・管理会社への確認", estimate: "御見積書" };

const jstDay = (iso: string) => {
  const d = new Date(Date.parse(iso) + 9 * 3_600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/** 期限を過ぎた約束の1行（無ければ ""）。事実だけ・古い順・最大3つ */
export function overduePromisesLine(list: ReadonlyArray<OverduePromise>): string {
  if (!list.length) return "";
  const parts = [...list].sort((a, b) => a.promisedAt.localeCompare(b.promisedAt)).slice(0, 3).map((p) =>
    `${KIND_JA[p.kind] ?? p.kind}（${jstDay(p.promisedAt)}に約束・期限 ${jstDay(p.dueAt)}${p.dueBy === "words" ? "（約束の文の期限）" : "（72時間）"}・${p.daysOver <= 0 ? "今日過ぎた" : `${p.daysOver}日過ぎ`}・まだ果たした記録なし）`);
  return `期限を過ぎたこちらの約束: ${parts.join("／")}`;
}
