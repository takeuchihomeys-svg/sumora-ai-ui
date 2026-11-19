// app/lib/unknowns-intake.ts — 分からない事の表（brain_unknowns）へ入れる入口を足す（純関数・DB も LLM も持たない）
//
// 2026-11-05 竹内さんの決定（KB P1 3892c30c「分からない部分・知識の足りない部分は DB の3つの表に必ず集める」）・統括役の指示・作業員1:
//   抜けていた入口を足す。どれも記録だけ（判断・文は変えない）。
//     prod_miss        … 本番の竹内さん本人の番で、ブレインの道（AIX の系統／返信）と竹内さんの最初の一手（staff-first-move）が違った番。
//                        2択（digest.tc=true）は、どちらかの側が竹内さんと同じなら外れにしない（試験の採点の決まり 10/28 と同じ）。
//                        竹内さんの AIX の種類が記録に無い番（aix_unknown）は比べられないので入れない。
//     material_missing … ブレインの自己申告 digest.mm（判断に要ったのに無かった材料）と digest.mx（DB から読めなかった材料の鍵）
//     knowledge_gap    … digest.mm のうち、会社の決まり・手順・仕組みの知識を言う物（材料ではなく知識の足りなさ）
//     exam_regression  … 試験の係の結果の「確かな悪化」（worseSure）の問題
//   sample_ref に残すのは会話 id・時刻・番 id・試験の label と問題 id だけ（お客様の文・下書き・名前は残さない）。
import type { UnknownHit } from "./brain-unknowns";
import { normalizeGapName } from "./material-gap-weekly";
import { BRAIN_MATERIAL_LABELS } from "./brain-material-miss";
import { STAFF_FAIL_RE } from "./post-apply-brain-gate";
import { isOwnScreeningFailureTurn } from "./screening-failed-switch";

/** 記録の切替（既定 on・記録だけ）。止める BRAIN_UNKNOWNS_PROD_MISS=off／BRAIN_UNKNOWNS_SELF_REPORT=off */
export function prodMissIntakeEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_UNKNOWNS_PROD_MISS ?? "").trim().toLowerCase() !== "off";
}
export function selfReportIntakeEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_UNKNOWNS_SELF_REPORT ?? "").trim().toLowerCase() !== "off";
}
/**
 * 2026-11-13 作業員1（統括役の朝の穴の割り当て）: 申込以降の番の自己申告を分からない事に入れない（申込以降は対象外・竹内さんの決定）。
 *   直近24時間の material_missing 92行の約半分が審査・契約・書類・保証会社等＝申込中（applying 2会話 19件）と、status が物件提案中のまま
 *   申込の記録がある会話（4会話 34件）から来ていた。番の時の status と turn-application-gate（その番の時刻で申込の記録があるか）で外す。
 *   2026-11-14 作業員G（統括役の決め・竹内さんの決定 project_post_apply_out_of_scope「申込以降は対象外・審査落ち→切り替えだけ対象」）:
 *   既定 on にした（戻す BRAIN_UNKNOWNS_POST_APPLY_GATE=off）。11/13 の material_missing 58件のうち 7件（4会話）が申込以降。
 *   ただし審査落ちの切り替えの番は数える（rejectionSwitchKeep）: 最後の申込の記録より後に否決（スタッフの否決の通・お客様の自分の審査落ちの報告）があり、
 *   その否決が番より前＝否決の後、新しい申込をまだしていない期間（実物 b50fd451 11/13 14:11「審査が否決」→14:12 の番「独立系保証会社の送れる物件」）。
 */
export function unknownsPostApplyGateOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_UNKNOWNS_POST_APPLY_GATE ?? "").trim().toLowerCase() !== "off";
}

/** 否決の通か（スタッフ＝否決を伝えた通・お客様＝自分の審査落ちの報告。仮定・他人の審査は数えない） */
export function isRejectionMessage(m: { sender: string | null | undefined; text: string | null | undefined }): boolean {
  const t = String(m.text ?? "");
  if (!t.trim()) return false;
  if (m.sender === "customer") return isOwnScreeningFailureTurn(t);
  // スタッフの通は文ごと。仮定・説明（「審査落ちした場合」「通らない可能性」実物 330ad233 10/21）は否決の報告ではない
  return t.split(/[。！!？?\n]+/).some((s) => STAFF_FAIL_RE.test(s) && !STAFF_FAIL_HYPO_RE.test(s));
}
const STAFF_FAIL_HYPO_RE = /場合|たら|れば|なら|可能性|ない(?:よう|様)|かも|もし|際は|時は|ことも|事も/;

/**
 * 審査落ちの切り替えの番か（申込以降の門で外さずに数える）。
 * @param recordTimes 申込の記録の時刻（turn-application-gate の records の first・last）
 * @param rejectionAts 否決の通の時刻（isRejectionMessage に当たった物）
 */
export function rejectionSwitchKeep(recordTimes: ReadonlyArray<string | null | undefined>, rejectionAts: ReadonlyArray<string>, atIso: string): boolean {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return false;
  const fails = rejectionAts.map((x) => Date.parse(x)).filter((t) => Number.isFinite(t) && t <= at);
  if (!fails.length) return false;
  const lastFail = Math.max(...fails);
  const recs = recordTimes.map((x) => (x ? Date.parse(x) : NaN)).filter((t) => Number.isFinite(t) && t <= at);
  return !recs.length || lastFail >= Math.max(...recs);
}
/** 自己申告の1行を外すか（status は番の時の conversation_status・gateReason は turnApplicationReason の答え） */
export function selfReportPostApply(status: string | null | undefined, gateReason: string | null, skipStatuses: ReadonlySet<string>): string | null {
  if (status && skipStatuses.has(status.trim())) return `番の時の status ${status.trim()}`;
  return gateReason;
}

/** AIX の種類 → 系統（audit-prod-as-exam.aixFamily と同じ線・空は返信） */
export function moveFamily(aix: string | null | undefined): string {
  const s = String(aix ?? "").trim();
  if (!s) return "返信";
  if (/property_check|acknowledge_check/.test(s)) return "確認";
  if (/estimate|cost_/.test(s)) return "見積";
  if (/property_send|property_recommend|new_arrival/.test(s)) return "物件";
  if (/viewing|meeting/.test(s)) return "内覧";
  if (/application|apply/.test(s)) return "申込";
  if (/zenryoku|support/.test(s)) return "サポート";
  return s;
}

export type ProdTurn = {
  turnId: number; conversationId: string; at: string;
  /** 見張りの番の brain_action（2段・返信は空） */
  brainAction: string | null;
  /** digest.tc === true（2択をセットした番） */
  twoChoice: boolean;
  /** 番の後の最初の送信の書き手（staff-first-move の writer） */
  staffWriter: string | null;
  staffMove: { kind: "aix" | "reply"; aix: string | null } | null;
};

/** 竹内さん本人の番の外れ（基準は竹内さんだけ・KB 41dadfe6） */
export function prodMissHits(turns: ReadonlyArray<ProdTurn>, writer = "takeuchi"): UnknownHit[] {
  const out: UnknownHit[] = [];
  for (const t of turns) {
    if (!t.staffMove || t.staffWriter !== writer) continue;
    const s = t.staffMove.kind === "aix" ? (t.staffMove.aix ?? "aix_unknown") : "";
    if (s === "aix_unknown") continue;
    const sf = moveFamily(s), bf = moveFamily(t.brainAction);
    if (bf === sf || (t.twoChoice && sf === "返信")) continue;
    out.push({ kind: "prod_miss", key: `${bf}→${sf}`, label: `ブレイン ${bf}／竹内さん ${sf}`, ref: { conversation_id: t.conversationId, at: t.at, turn_id: t.turnId } });
  }
  return out;
}

/** 知識の足りなさ（材料ではない）と読む自己申告の言葉 */
const KNOWLEDGE_RE = /決まり|ルール|規定|方針|手順|流れ|仕組み|知識|会社の(?:事実|情報)|相場/;

export type DigestSelfReport = { conversationId?: string | null; at: string; mm?: unknown; mx?: unknown };
/** digest.mm・digest.mx → material_missing／knowledge_gap（同じ判断の同じ名前は1回） */
export function selfReportHits(rows: ReadonlyArray<DigestSelfReport>): UnknownHit[] {
  const out: UnknownHit[] = [];
  for (const r of rows) {
    const ref = { ...(r.conversationId ? { conversation_id: r.conversationId } : {}), at: r.at };
    const names = new Set((Array.isArray(r.mm) ? r.mm : []).filter((x): x is string => typeof x === "string").map(normalizeGapName).filter(Boolean).map((n) => n.slice(0, 60)));
    for (const n of names) out.push({ kind: KNOWLEDGE_RE.test(n) ? "knowledge_gap" : "material_missing", key: `mm:${n}`, label: n, ref });
    for (const k of new Set((Array.isArray(r.mx) ? r.mx : []).filter((x): x is string => typeof x === "string"))) {
      out.push({ kind: "material_missing", key: `mx:${k}`, label: `読めなかった材料: ${BRAIN_MATERIAL_LABELS[k] ?? k}`, ref });
    }
  }
  return out;
}

export type ExamResultLite = { label: string; switch?: string | null; at?: string | null; worseSure?: ReadonlyArray<{ id: string; why?: string }> | null };
/** 試験の係の結果の確かな悪化 → exam_regression（鍵はスイッチの最初の名前と問題 id） */
export function examRegressionHits(r: ExamResultLite): UnknownHit[] {
  const sw = String(r.switch ?? "").split(",")[0].trim() || "?";
  return (r.worseSure ?? []).map((w) => ({ kind: "exam_regression" as const, key: `${sw}:${w.id}`, label: `${sw} で悪化: ${String(w.why ?? "").slice(0, 60)}`, ref: { exam_label: r.label, qid: w.id, ...(r.at ? { at: r.at } : {}) } }));
}
