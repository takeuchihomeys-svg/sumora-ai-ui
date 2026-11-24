// app/lib/route-misread-move.ts — 統括の判断が読んだ「今どこ」（申込までの地図の駅）を、その後の実際の一手（スタッフが送った AIX）で照らす（純関数・DB/LLM なし・台帳 #657）
//
// 2026-11-24 作業員A（統括役の頼み・#657「今どこを正しく把握し、道筋で申込まで進める」）。毎日数える物差し route:station_misread_move:<型>。
//   照らし方: 判断の駅（brain_decision_logs.digest.ar の node|branch・11/23 から／conversations.last_brain_meta.apply_route・backfill の印は別に数える）と、
//   判断の後 24時間以内にこちらが最初に送った AIX の種類。その AIX が「次の一手」になっている駅（ROUTE_NODES／ROUTE_BRANCHES の next.aix）と比べる。
//   型: match（その駅の次の一手）／behind（地図が手前＝実際は先の駅の一手）／ahead（地図が先＝実際は手前の駅の一手）／other_path（分かれ道の一手・または分かれ道を読んだのに本線の一手）／
//       timed（時刻で送る物・24時間より後＝一手に数えない）／unknown（返信だけ・どの駅の一手でもない AIX）
//   原因（3つ）: material（材料が無い＝その先の駅を示す送付の記録が判断の前に無い）／misread（読み違い＝判断の前に記録があったのに手前の駅・または先・分かれ道）／counting（数え方＝時刻で送る物・遅い一手）
import { ROUTE_NODES, ROUTE_BRANCHES, MAIN_ROUTE, type RouteNodeId } from "./apply-route-map";

export type MoveKind = "match" | "behind" | "ahead" | "other_path" | "timed" | "unknown";
export type MoveCause = "material" | "misread" | "counting" | null;
export const MOVE_KIND_JA: Record<MoveKind, string> = { match: "合う", behind: "地図が手前（実際は先の駅の一手）", ahead: "地図が先（実際は手前の駅の一手）", other_path: "別の道（分かれ道）", timed: "時刻で送る物・遅い一手（数えない）", unknown: "駅の一手でない" };
export const MOVE_CAUSE_JA: Record<Exclude<MoveCause, null>, string> = { material: "材料が無い", misread: "読み違い", counting: "数え方" };
const TIMED_AIX = new Set(["greeting_viewing"]);
const norm = (a: string) => (a === "property_recommendation" ? "property_send" : a);

/** digest.ar（"node|branch|substate|版"）を読む */
export function parseAr(ar: string | null | undefined): { node: string | null; branch: string | null; substate: string | null } | null {
  if (!ar || typeof ar !== "string") return null;
  const [node, branch, substate] = ar.split("|").map((x) => (x && x !== "-" && x !== "null" ? x : null));
  return node || branch ? { node: node ?? null, branch: branch ?? null, substate: substate ?? null } : null;
}
/** その AIX が「次の一手」になっている本線の駅の並びの位置と、分かれ道 */
export function naturalOf(aix: string): { mainIdx: number[]; branches: string[] } {
  const a = norm(aix);
  const mainIdx = MAIN_ROUTE.map((id, i) => ((ROUTE_NODES[id].next.aix ?? []).map(norm).includes(a) ? i : -1)).filter((i) => i >= 0);
  const branches = (Object.keys(ROUTE_BRANCHES) as Array<keyof typeof ROUTE_BRANCHES>).filter((b) => ((ROUTE_BRANCHES[b].next?.aix ?? []) as string[]).map(norm).includes(a)).map(String);
  return { mainIdx, branches };
}
export type MoveInput = { node: string | null; branch: string | null; moveAix: string | null; hoursAfter: number | null; sentBefore?: ReadonlyArray<string> };
/** 1つの判断 → 型と原因 */
export function misreadMoveOf(i: MoveInput): { kind: MoveKind; cause: MoveCause } {
  if (!i.moveAix || i.hoursAfter == null) return { kind: "unknown", cause: null };
  if (TIMED_AIX.has(i.moveAix) || i.hoursAfter > 24) return { kind: "timed", cause: "counting" };
  const nat = naturalOf(i.moveAix);
  const j = i.node ? MAIN_ROUTE.indexOf(i.node as RouteNodeId) : -1;
  if (i.branch) {
    if (nat.branches.includes(i.branch)) return { kind: "match", cause: null };
    if (nat.mainIdx.length) return { kind: "other_path", cause: "misread" }; // 分かれ道を読んだのに本線の一手（戻っていた）
  }
  if (!nat.mainIdx.length) return nat.branches.length ? { kind: "other_path", cause: "misread" } : { kind: "unknown", cause: null };
  if (j < 0) return { kind: "unknown", cause: null };
  if (nat.mainIdx.includes(j)) return { kind: "match", cause: null };
  if (Math.min(...nat.mainIdx) > j) {
    // 地図が手前: 判断の前にその先の駅を示す送付があったか（あれば読み違い・無ければ材料が無い）
    const later = (i.sentBefore ?? []).some((s) => naturalOf(s).mainIdx.some((k) => k > j));
    return { kind: "behind", cause: later ? "misread" : "material" };
  }
  return { kind: "ahead", cause: "misread" };
}
/**
 * 2026-11-24 作業員A（#657 の続き・照らせる番を増やす）: 手打ちの返信の締めを、同じ働きの AIX の一手として読む（読めない返信は null）。
 *   お申込みのご案内→申込の後押し・内覧のご案内／日程を伺う→内覧の候補日・御見積書を作る→見積書・ピックアップしてお送り→物件を送る・確認させて頂きます→物件確認した
 *   答えだけ・問いだけ・お待ちしております は駅の一手として読まない（作らない側に倒す）
 */
export function replyAsMove(text: string | null | undefined): string | null {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return null;
  if (/お申込み?(?:頂|いただ|下さ|ください|され)|お申込みで(?:お部屋を?)?(?:抑|押さ)え/.test(t)) return "application_push";
  if (/ご内覧|内覧(?:頂|いただ|のご案内|させて)|ご案内させて頂|ご都合(?:の)?(?:よろしい|良い)(?:お日にち|日)/.test(t)) return "viewing_invite";
  if (/御見積書|お見積/.test(t) && /(?:作成|お送り)/.test(t)) return "estimate_sheet";
  if (/ピックアップ(?:して|させて)|(?:お部屋|物件)を?(?:お送り|お探し)させて頂/.test(t)) return "property_send";
  if (/(?:管理会社|募集状況|空室)[^。！!]{0,20}確認(?:させて頂|致し|いたし|して)/.test(t)) return "property_check_result";
  return null;
}

/** 毎朝の1枚の行（型ごとの割合・n は照らせた番＝unknown と timed を除く） */
export function misreadMoveMetricRows(rows: ReadonlyArray<{ kind: MoveKind }>): Array<{ metric: string; value: number | null; n: number }> {
  const judged = rows.filter((r) => r.kind !== "unknown" && r.kind !== "timed");
  const n = judged.length;
  const pct = (k: MoveKind) => (n ? Math.round((judged.filter((r) => r.kind === k).length / n) * 1000) / 10 : null);
  return [
    { metric: "route:station_misread_move", value: n ? Math.round((judged.filter((r) => r.kind !== "match").length / n) * 1000) / 10 : null, n },
    ...(["behind", "ahead", "other_path"] as const).map((k) => ({ metric: `route:station_misread_move:${k}`, value: pct(k), n })),
  ];
}
