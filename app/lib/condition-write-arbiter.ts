// app/lib/condition-write-arbiter.ts
// 条件の自動の書き手どうしの「取り合い」を止める（純関数）。
//
// 2026-11-15 作業員K（竹内さん 11/15「連動してお客さんの最新の条件を具体的に判断して…AIX ツールが判断して更新していく」）:
//   直近30日の property_condition_history を測ると、自動の書き手（format・p4・brain_bridge・condition_brain・path_c）が約190行書き、
//   スタッフが画面で直したのは 14日以内 0行。一方で **同じお客様の発言から2つの書き手が同じ欄を書き合い、前の値に戻す** 取り合いが
//   7回あった（例: brain_bridge が希望エリアに駅を1つ足し → 4秒後に condition_brain が丸ごと上書きで消す／
//   間取り「1K以上（ワンルーム除く）」と「1K」の行き来が1人に5回）。拡張はその時々の値で検索するので、検索の条件が揺れる。
//
// ■ 決まり（誤って止めない側に寄せる）
//   ・止めるのは「自動の書き手が、別の自動の書き手が直前（REVERT_WINDOW_MS 以内）に書いた欄を、その書き換えの前の値にそのまま戻す」時だけ
//     かつ、戻そうとする書き手の根拠の発言が、前の書き手の根拠の発言より新しくない時（新しい発言での言い直しは止めない）
//   ・スタッフの画面の直し（screen_edit）・今回だけの戻し（scope／scope_temporary／restore／undo）は比べる相手にも止める相手にもしない（人と決まった戻しが優先）
//   ・止めた欄は書かず、「条件の更新の案」として記録に残す（迷う物は自動で書かない＝頼み4 ②）
//   ・値の比べは空白・全角半角・区切り（、・,／/）をそろえてから
//
// スイッチ: CONDITION_WRITE_ARBITER=off（既定）|shadow（止めずに「止めるならこれ」をログ）|on（止める）

export type ArbiterMode = "off" | "shadow" | "on";
export function conditionWriteArbiterMode(env: Record<string, string | undefined> = process.env): ArbiterMode {
  const v = String(env.CONDITION_WRITE_ARBITER ?? "").trim().toLowerCase();
  return v === "on" || v === "shadow" ? v : "off";
}

/** 取り合いを見る自動の書き手（人の直し・決まった戻しは入れない） */
export const AUTO_WRITERS = ["format", "p4", "brain_bridge", "condition_brain", "path_c"] as const;
const AUTO = new Set<string>(AUTO_WRITERS);
/** 直前とみなす長さ（測った7回は 4秒〜15,665秒。同じ発言の処理の後追いに当てる） */
export const REVERT_WINDOW_MS = 6 * 3600_000;

export type HistoryRowLike = {
  changed_field: string;
  old_value: string | null;
  new_value: string | null;
  source_message_id: string | null;
  created_at: string;
};

export function normalizeConditionValue(v: unknown): string {
  return String(v ?? "")
    .replace(/[０-９Ａ-Ｚａ-ｚ（）]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, "")
    .replace(/[、,，／/]/g, "・")
    .replace(/・+/g, "・")
    .replace(/^・|・$/g, "");
}

function writerOf(src: string | null | undefined): string {
  return String(src ?? "").split(":")[0].trim().toLowerCase();
}
function messageOf(src: string | null | undefined): string | null {
  const m = String(src ?? "").split(":");
  return m.length > 1 && m[1] ? m[1] : null;
}

export type ArbiterVerdict = {
  field: string;
  action: "write" | "skip";
  reason: string;
  /** 止めた時: 戻されそうになった書き手と、その時刻 */
  against?: { writer: string; at: string };
};

/**
 * 1つの欄の書き込みを決める。
 * @param messageAt 書こうとする書き手の根拠の発言の時刻（分からなければ null＝新しいとはみなさない）
 * @param messageAtOf 履歴の根拠の発言 id → 時刻（分からなければ undefined）
 */
export function arbitrateField(args: {
  field: string;
  current: unknown;
  proposed: unknown;
  writer: string;
  now: string;
  /** 書こうとする書き手の根拠の発言の id（分かれば。同じ発言の読み直しを止める） */
  messageId?: string | null;
  messageAt?: string | null;
  history: readonly HistoryRowLike[];
  messageAtOf?: (messageId: string) => string | undefined;
}): ArbiterVerdict {
  const { field, writer } = args;
  if (!AUTO.has(writer)) return { field, action: "write", reason: "自動の書き手でない" };
  const cur = normalizeConditionValue(args.current), next = normalizeConditionValue(args.proposed);
  if (cur === next) return { field, action: "write", reason: "変わらない" };
  const now = Date.parse(args.now);
  // その欄の一番新しい履歴（今の値を作った行）
  const rows = args.history.filter((h) => h.changed_field === field).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const last = rows[0];
  if (!last) return { field, action: "write", reason: "履歴なし" };
  // 同じ書き手が同じ発言からこの欄を既に書いた＝下書きの作り直し等での読み直し（30日で brain_bridge 5回・根拠の発言から10分以上後の書き込み 15/79）
  if (args.messageId) {
    const again = rows.find((h) => writerOf(h.source_message_id) === writer && messageOf(h.source_message_id) === args.messageId);
    if (again) return { field, action: "skip", reason: "同じ発言からこの欄を既に書いた（読み直し）", against: { writer, at: again.created_at } };
  }
  const lw = writerOf(last.source_message_id);
  // スタッフの画面の直しより古い発言で上書きしない（30日で 0回・守りだけ）
  if (lw === "screen_edit" && args.messageAt && Date.parse(args.messageAt) < Date.parse(last.created_at)) {
    return { field, action: "skip", reason: "スタッフの直しより古い発言からの上書き", against: { writer: lw, at: last.created_at } };
  }
  if (!AUTO.has(lw)) return { field, action: "write", reason: "直前は人か決まった戻し" };
  if (lw === writer) return { field, action: "write", reason: "同じ書き手" };
  if (!Number.isFinite(now) || now - Date.parse(last.created_at) > REVERT_WINDOW_MS) return { field, action: "write", reason: "直前でない" };
  if (normalizeConditionValue(last.new_value) !== cur) return { field, action: "write", reason: "今の値は直前の行と違う" };
  if (normalizeConditionValue(last.old_value) !== next) return { field, action: "write", reason: "前の値に戻すのではない" };
  // 新しい発言での言い直しは止めない
  const lastMsg = messageOf(last.source_message_id);
  const lastMsgAt = lastMsg ? args.messageAtOf?.(lastMsg) : undefined;
  if (args.messageAt && lastMsgAt && Date.parse(args.messageAt) > Date.parse(lastMsgAt)) return { field, action: "write", reason: "新しい発言の言い直し" };
  // 足された語が残りの値に既に含まれている（「吉田駅・荒本駅周辺(吉田荒本あたり)」に「吉田荒本」を足した等）＝重なりの片付けは止めない
  const removed = cur.split("・").filter((x) => x && !next.split("・").includes(x));
  const core = (x: string) => x.replace(/(駅|周辺|あたり|辺り|付近)/g, "");
  if (removed.length && removed.every((x) => core(x).length >= 2 && next.includes(core(x)))) return { field, action: "write", reason: "重なりの片付け" };
  return { field, action: "skip", reason: "別の自動の書き手が直前に書いた値を、同じ発言から前の値に戻す（取り合い）", against: { writer: lw, at: last.created_at } };
}

/** 書く欄の束を決める。skip の欄を updates から外した物を返す（mode=shadow は外さずに verdicts だけ返す） */
export function arbitrateConditionUpdates(args: {
  mode: ArbiterMode;
  writer: string;
  now: string;
  messageId?: string | null;
  messageAt?: string | null;
  current: Record<string, unknown> | null;
  updates: Record<string, unknown>;
  history: readonly HistoryRowLike[];
  messageAtOf?: (messageId: string) => string | undefined;
}): { updates: Record<string, unknown>; skipped: ArbiterVerdict[] } {
  if (args.mode === "off") return { updates: args.updates, skipped: [] };
  const skipped: ArbiterVerdict[] = [];
  const out: Record<string, unknown> = {};
  for (const [f, v] of Object.entries(args.updates)) {
    if (f === "updated_at") { out[f] = v; continue; }
    const r = arbitrateField({ field: f, current: args.current?.[f], proposed: v, writer: args.writer, now: args.now, messageId: args.messageId, messageAt: args.messageAt, history: args.history, messageAtOf: args.messageAtOf });
    if (r.action === "skip") { skipped.push(r); if (args.mode === "shadow") out[f] = v; }
    else out[f] = v;
  }
  return { updates: out, skipped };
}
