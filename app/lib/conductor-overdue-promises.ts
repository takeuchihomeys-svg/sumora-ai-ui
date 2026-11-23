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

// ─── 2026-11-23 作業員L（台帳 #659・竹内さん #662「統括は全部管理して細かく反映」の「使う」の段）───
//   入口の統括の材料に渡した期日超えの約束が、その番で使われたかを判断の記録（digest の op）に短く残す（記録だけ・次の番のブレインは読まない）。
//   op＝"<件数>|<種類を+で>|<その番の一手が約束を果たす一手か 1/0>"（例 "2|pickup+check|1"）。止める OVERDUE_PROMISES_DIGEST=off
export const overduePromisesDigestOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.OVERDUE_PROMISES_DIGEST ?? "").trim().toLowerCase() !== "off";
/** 約束の種類ごとに、果たす一手（AIX の種類） */
const FULFIL_ACT: Record<string, RegExp> = {
  pickup: /^(?:property_send|property_recommendation|property_search|pickup)/,
  check: /^(?:property_check_result|acknowledge_check|mgmt_)/,
  estimate: /^estimate/,
};
/** その番の一手（ブレインの AIX の種類・返信なら null）が、渡した期日超えの約束のどれかを果たす一手か */
export function fulfilsOverduePromise(list: ReadonlyArray<Pick<OverduePromise, "kind">>, finalAix: string | null | undefined): boolean {
  const a = String(finalAix ?? "").trim();
  if (!a) return false;
  return list.some((p) => FULFIL_ACT[p.kind]?.test(a) ?? false);
}
export type OverduePromisesRec = { n: number; kinds: string[]; fulfil: boolean };
/** meta に残す形（無い・0件は null） */
export function overduePromisesRecOf(list: ReadonlyArray<Pick<OverduePromise, "kind">> | null | undefined, finalAix: string | null | undefined): OverduePromisesRec | null {
  if (!list || !list.length) return null;
  return { n: list.length, kinds: [...new Set(list.map((p) => p.kind))].sort(), fulfil: fulfilsOverduePromise(list, finalAix) };
}
/** digest の op（形の違う物は null） */
export function overduePromisesDigest(rec: unknown): string | null {
  const r = rec as Partial<OverduePromisesRec> | null | undefined;
  if (!r || typeof r.n !== "number" || r.n <= 0 || !Array.isArray(r.kinds)) return null;
  return `${r.n}|${r.kinds.join("+")}|${r.fulfil ? 1 : 0}`;
}
/** digest の op を読む（物差し用・形が違えば null） */
export function parseOverduePromisesDigest(op: unknown): OverduePromisesRec | null {
  const m = String(op ?? "").match(/^(\d+)\|([a-z_+]*)\|([01])$/);
  return m ? { n: Number(m[1]), kinds: m[2] ? m[2].split("+") : [], fulfil: m[3] === "1" } : null;
}

/**
 * 物差し（読むだけ・作業員A の統括の受け持ち表の「使う・反映する」の列）: 判断の記録の op を集めて、期日超えの約束を渡した番のうち、その番の一手が約束を果たす一手だった割合。
 *   use_rate＝果たす一手の番 / 渡した番。種類ごとにも（同じ番に2種類あれば両方に数える）
 */
export type OverdueUseSummary = { given: number; fulfil: number; useRate: number | null; byKind: Record<string, { given: number; fulfil: number }> };
export function overdueUseSummary(ops: ReadonlyArray<unknown>): OverdueUseSummary {
  const byKind: Record<string, { given: number; fulfil: number }> = {};
  let given = 0, fulfil = 0;
  for (const o of ops) {
    const r = parseOverduePromisesDigest(o);
    if (!r) continue;
    given++; if (r.fulfil) fulfil++;
    for (const k of r.kinds) { const c = (byKind[k] ??= { given: 0, fulfil: 0 }); c.given++; if (r.fulfil) c.fulfil++; }
  }
  return { given, fulfil, useRate: given ? Math.round((fulfil / given) * 1000) / 10 : null, byKind };
}
