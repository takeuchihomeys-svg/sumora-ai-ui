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

/**
 * 2026-11-25 作業員L（台帳 #664 の④・統括役の頼み「統括に渡す読みの期日超えの決め方が見張り・B1 と食い違う」）:
 *   見張り（promiseDropOf）と統括の読み（overduePromisesOf）は、同じ時刻・同じ材料なら同じ答え（本番の5会話・28番で確かめた）。食い違いの元は呼ぶ側の2つ:
 *   ① 時計: brain-core は「今」を会話の一番新しい通の時刻＋1ms（turnAt0）で渡す。見張りは本当の今。brain-sweep・generate-pending-drafts のように
 *      最後の通より後で回る番では、その間に期限を過ぎた約束を数えない（7d5c6008: 11/24 19:38 JST の generate-pending-drafts は最後の通 13:37 の時刻で読み、15:39 に過ぎた確認の約束を 0 件）
 *   ② 待ち: 1.5秒で切る。brain-sweep は米国（iad1）で回る事があり、DB（東京）の読みが間に合わない（8739fa57: 11/24 9:01 JST の brain-sweep は n=null・timedOut）
 *   OVERDUE_NOW_CLOCK=shadow: 渡すのは今まで通り（最後の通の時刻）・本当の今で読んだ件数を記録だけ（brain:overdue-promises-now）。
 *     試験は時刻が最後の通で止まる（REPLAY_FLOOR_FILE）ので off/on の差が出ない＝本番の記録で確かめる
 *   OVERDUE_NOW_CLOCK=on（既定 off）: 「今」を本当の今に（試験の再生 REPLAY_FLOOR_FILE の時は今まで通り最後の通の時刻＝試験の時刻が崩れない）・待ちを 4秒に
 */
export const overdueNowClockOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.OVERDUE_NOW_CLOCK ?? "").trim().toLowerCase() === "on";
// 2026-11-25 統括役の決め: 記録だけ＝11/22 の決まりで既定 shadow（=off で止まる・=on で本当の今を渡す）
export const overdueNowClockShadow = (env: Env = typeof process !== "undefined" ? process.env : {}) => { const v = (env.OVERDUE_NOW_CLOCK ?? "").trim().toLowerCase(); return v !== "off" && v !== "on"; };
/** 判断の記録の digest に残す短い形（"渡した数|本当の今の数|何時間の差"・毎朝の1枚が数える） */
export function overdueNowDigest(rec: unknown): string | null {
  const r = rec as { nTurn?: number | null; nNow?: number; gapH?: number } | null | undefined;
  if (!r || typeof r.nNow !== "number") return null;
  return `${r.nTurn ?? "-"}|${r.nNow}|${r.gapH ?? 0}`;
}
export function parseOverdueNowDigest(v: unknown): { nTurn: number | null; nNow: number; gapH: number } | null {
  const m = String(v ?? "").match(/^(-|\d+)\|(\d+)\|(-?\d+)$/);
  return m ? { nTurn: m[1] === "-" ? null : Number(m[1]), nNow: Number(m[2]), gapH: Number(m[3]) } : null;
}
export const OVERDUE_PROMISES_TIMEOUT_MS_WIDE = 4000;
/** 統括の読みに渡す「今」と待ちの上限（純関数） */
export function overdueReadClock(o: { turnAt: string | null; nowMs: number; env?: Env }): { nowMs: number; timeoutMs: number; by: "turn" | "now"; shadowNowMs?: number } {
  const env = o.env ?? (typeof process !== "undefined" ? process.env : {});
  const turnMs = o.turnAt ? Date.parse(o.turnAt) + 1 : null;
  if (!overdueNowClockOn(env)) {
    const base = { nowMs: turnMs ?? o.nowMs, timeoutMs: OVERDUE_PROMISES_TIMEOUT_MS, by: (turnMs != null ? "turn" : "now") as "turn" | "now" };
    // shadow: 試験の再生でない時だけ・今の方が後の時だけ
    return overdueNowClockShadow(env) && !String(env.REPLAY_FLOOR_FILE ?? "").trim() && turnMs != null && o.nowMs > turnMs ? { ...base, shadowNowMs: o.nowMs } : base;
  }
  if (String(env.REPLAY_FLOOR_FILE ?? "").trim() && turnMs != null) return { nowMs: turnMs, timeoutMs: OVERDUE_PROMISES_TIMEOUT_MS_WIDE, by: "turn" };
  return { nowMs: Math.max(o.nowMs, turnMs ?? 0), timeoutMs: OVERDUE_PROMISES_TIMEOUT_MS_WIDE, by: "now" };
}

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
