/**
 * 空室確認の結果が「手元にあるか」を決まった計算で1行にする（純関数・2026-11-23 作業員G・台帳 #615）
 *
 * なぜ: AIX の番の外れ「材料が無い」で、ブレインは確認の結果がまだ無いのか、スタッフが既に確かめているのかを分けられなかった。
 *   結果が DB にある時は【空室確認の回答結果（確定事実）】の段（buildCheckResultsText）が出るが、結果がまだ無い時は何も出ず、
 *   「確認中（スタッフが管理会社に聞いている）」と「確認していない」の区別が材料に無い。
 *   スタッフが電話で確かめた結果は AIX【物件確認した】で送るまで DB に無い＝その番は AIX の番（P0 ca55d42b・スタッフだけが知る事は AIX）。
 * 決まり（line_tasks の property_check だけ・作らない側に倒す）:
 *   on_hand … 直近の空室確認のタスクに結果（result）がある（＝確定事実の段がある）
 *   pending … 空室確認のタスクが開いていて結果がまだ無い（＝スタッフが確かめている。結果は AIX【物件確認した】で届く）
 *   done_no_record … 一番新しいタスクが完了で結果の記録なし（確認は済んでいる・答えは会話のこちらの文）
 *   none    … 空室確認のタスクが無い・一番新しいのが取り消し
 * 既定 off（CHECK_RESULT_STATE=on）。off の時はブレインに渡す文が1文字も変わらない
 */
export type CheckTask = { task_type: string; status: string; created_at: string; result: string | null; resolved_at?: string | null };
export type CheckResultState = { state: "on_hand" | "pending" | "done_no_record" | "none"; openSinceMin: number | null; resultAt: string | null };

export function checkResultStateOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CHECK_RESULT_STATE ?? "").trim().toLowerCase() === "on";
}

export function checkResultState(tasks: ReadonlyArray<CheckTask>, nowMs: number = Date.now()): CheckResultState {
  const checks = tasks.filter((t) => t.task_type === "property_check").sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!checks.length) return { state: "none", openSinceMin: null, resultAt: null };
  const open = checks.find((t) => t.status === "pending" && !t.result);
  const latest = checks[0];
  // 一番新しいタスクが開いている（結果なし）なら pending。古いタスクに結果があっても、今の問いの結果ではない
  if (open && open === latest) {
    const min = Math.max(0, Math.round((nowMs - Date.parse(open.created_at)) / 60_000));
    return { state: "pending", openSinceMin: Number.isFinite(min) ? min : null, resultAt: null };
  }
  const withResult = checks.find((t) => !!t.result);
  if (withResult && withResult === latest) return { state: "on_hand", openSinceMin: null, resultAt: withResult.resolved_at ?? null };
  // 2026-11-23 作業員A の当て直し（会話 65c2df5b・番 12578）: 一番新しいタスクが完了で結果の記録なし（11/15 より前の完了など）。
  //   確認は済んでいるが結果は記録に無い＝none（確認していない）と分ける。古い開いたままのタスクは新しい完了で上書きされたと見る
  if (latest.status !== "pending" && latest.status !== "cancelled") return { state: "done_no_record", openSinceMin: null, resultAt: null };
  return { state: "none", openSinceMin: null, resultAt: null };
}

/** ブレインの材料の1行（none の時は空） */
export function checkResultStateText(s: CheckResultState): string {
  if (s.state === "on_hand") return "\n【確認の結果の状態】空室確認の結果は手元にある（上の確定事実の段）。";
  if (s.state === "pending") {
    return `\n【確認の結果の状態】空室確認のタスクが開いていて結果はまだ無い（${s.openSinceMin != null ? `${s.openSinceMin}分前から・` : ""}スタッフが確かめている）。結果はスタッフだけが知る事＝結果は AIX で届く（物件確認した／部屋が空いていれば見積書送る）。返信で結果を作らない。`;
  }
  if (s.state === "done_no_record") return "\n【確認の結果の状態】空室確認は済んでいる（結果の記録は無い）。答えは会話の中のこちらの文を読む。";
  return "";
}
