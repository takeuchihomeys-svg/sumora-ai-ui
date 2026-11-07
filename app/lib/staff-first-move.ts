// app/lib/staff-first-move.ts — お客様の番に対するこちらの「最初の一手」（作業員1・2026-11-04・統括役の指示・純関数）
//   物差しを揃える: 本番の外れの数え（audit-prod-as-exam）・取扱説明書の毎週の当たり・近い番の表の正解・再生の試験の正解は、どれもこの「最初の一手」で比べる。
//   気付き（11/04 q201・番 10415）: 見張りの番の staff_aix は番の後に押した AIX を全部持つ＝「確認の約束の返信 → 確かめた後に AIX」の番で、後の AIX を一手と数えて
//   その場の AIX（ブレインの外れ）を当たりにしていた。最初の送信が返信なら一手は返信。AIX ならその種類（同じ時刻の近くに押した AIX の記録から）。

export type FirstMove = { kind: "aix" | "reply"; aix: string | null; picker: string | null; writer: string | null; at: number };
export type StaffMsgLite = { at: number; isAix: boolean; writer: string | null };
export type StaffAixLite = { at: number; aixType: string; checkPattern: string | null };

/** 番の後（24時間以内）の最初のこちらの送信。AIX なら、その送信の時刻の前10分〜後2分に押した AIX の記録で種類を決める（無ければ aix_unknown） */
export function staffFirstMove(turnAtMs: number, msgs: ReadonlyArray<StaffMsgLite>, aixLogs: ReadonlyArray<StaffAixLite>): FirstMove | null {
  const first = msgs.filter((m) => m.at >= turnAtMs && m.at - turnAtMs < 86_400_000).sort((a, b) => a.at - b.at)[0];
  if (!first) return null;
  if (!first.isAix) return { kind: "reply", aix: null, picker: null, writer: first.writer, at: first.at };
  const near = aixLogs.filter((a) => a.at >= first.at - 10 * 60_000 && a.at <= first.at + 2 * 60_000).sort((a, b) => Math.abs(a.at - first.at) - Math.abs(b.at - first.at))[0];
  return { kind: "aix", aix: near?.aixType ?? "aix_unknown", picker: near?.checkPattern ?? null, writer: first.writer, at: first.at };
}

/** 見張りの番の staff_aix（[{at, aix_type, check_pattern}]）を StaffAixLite に */
export function aixLogsFromWatch(staffAix: ReadonlyArray<{ at?: string; aix_type?: string; check_pattern?: string | null }> | null | undefined): StaffAixLite[] {
  return (staffAix ?? []).filter((a) => a.at && a.aix_type).map((a) => ({ at: Date.parse(String(a.at)), aixType: String(a.aix_type), checkPattern: a.check_pattern ?? null }));
}

// ─── 見張りの数え方（2026-11-07 作業員1・統括役の頼み・作業員8 から引き取り）────────────────────
//   ① 番の後、しばらく経って送った AIX は「後で送った AIX（約束の果たし）」＝その番の外れに入れない（別に数える）
//      線は竹内さん本人の 90日の最初の一手（scripts/audit-watch-count-late-aix.ts・読むだけ）で決める＝STAFF_LATE_AIX_MIN
//   ② お礼・了承の番で30分以内に約束を果たす AIX（見積書・物件確認した・オススメ・物件送付）を送った番は、
//      手元に物件・結果がある印が DB にあったかに関わらず「スタッフの番」（スタッフしか知らない事・KB 120721d0・弱い所 420）
//   既定 on（数えだけ）。止める WATCH_COUNT_LATE_AIX=off
export const STAFF_LATE_AIX_MIN = 90;
export const ACK_FULFIL_AIX_MIN = 30;
const ACK_FULFIL_AIX = new Set(["estimate_sheet", "property_check_result", "property_recommendation", "property_send"]);
export type MoveExclusion = "late_aix" | "ack_fulfil_aix";
export function watchCountLateAixOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.WATCH_COUNT_LATE_AIX ?? "").trim().toLowerCase() !== "off";
}
/** 見張りの場面の鍵・TPO からお礼・了承の番か（お客様の文を読めない所の代わり） */
export function ackSceneOf(sceneKey: string | null | undefined, tpoLabel?: string | null): boolean {
  return /短い了承・お礼/.test(sceneKey ?? "") || /^感謝返し$/.test(tpoLabel ?? "");
}
/** その番をブレインの当たり外れから外すか（外すなら理由）。fm は staffFirstMove の答え */
export function staffMoveExclusion(turnAtMs: number, fm: FirstMove | null, o: { ackOnly?: boolean; lateMin?: number; env?: Record<string, string | undefined> } = {}): MoveExclusion | null {
  if (!fm || fm.kind !== "aix" || !watchCountLateAixOn(o.env)) return null;
  const min = (fm.at - turnAtMs) / 60_000;
  if (o.ackOnly && min <= ACK_FULFIL_AIX_MIN && fm.aix && ACK_FULFIL_AIX.has(fm.aix)) return "ack_fulfil_aix";
  if (min >= (o.lateMin ?? STAFF_LATE_AIX_MIN)) return "late_aix";
  return null;
}
