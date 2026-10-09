// app/lib/line-watch-turn-eval.ts
// 見張り 2段目の「番1行の判定」（純関数・DB も fetch も LLM も持たない）。
//   毎晩の cron（line-watch-eval-server.evaluateLineWatchTurns）と、過去の番の埋め戻し（line-watch-backfill・scripts/line-watch-backfill.ts）が
//   同じ関数を通す（二重に作らない・2026-10-08 竹内さんの決定 10/08 の1「見張りの判定を過去1〜3ヶ月分埋める」）。
//   中身は 2026-10-08 まで evaluateLineWatchTurns の中にあった処理をそのまま移した物（並び・規則は1文字も変えていない）。
import { staffWriterOfBurst, staffWriterSplitEnabled } from "./staff-writer";
import { staffWindowOf, judgeTurn, cleanDraft, pickJudgeDraft, JUDGE_VERSION, type WindowMsg, type WindowPress, type Judgement, type StaffWindow, type JudgeDraftSrc } from "./line-watch-judge";
import { resolveAckTopicScope, outOfTopicActs } from "./ack-topic-scope";
import { sceneKeyOf, type SceneKey } from "./line-watch-turn";

const P = (s: string) => Date.parse(s);

/** 判定に要る line_watch_turns の列（1段目の控え） */
export type WatchTurnInput = {
  conversation_id: string; customer_turn_at: string; conv_status: string | null;
  draft_last: string | null; draft_last_at: string | null; draft_first: string | null; draft_first_at: string | null; draft_versions: number | null; draft_sentinel: string | null;
  brain_action: string | null; brain_reply_mode: string | null; brain_versions: number | null; tpo_label: string | null;
};
export type WatchDecision = { id: string; created_at: string; analyzed_msg_ts: string | null; intent: string | null };
export type WatchTurnEval = {
  judgement: Judgement;
  scene: SceneKey;
  window: StaffWindow;
  draftSrc: JudgeDraftSrc;
  decision: WatchDecision | null;
  /** line_watch_turns の2段目の列（evaluated_at・judge_version を含む） */
  patch: Record<string, unknown>;
};

/**
 * 番1つの判定と、書く列。msgs・presses・decisions はその会話の物（番より前が入っていてよい・古い順）。
 *   msgs は番の4日前から（お礼・了承の番の読むべき範囲を決めるため）。intentFallback は decision の intent が無い時だけ場面に使う（埋め戻し用・cron は渡さない）
 */
export function evalWatchTurn(t: WatchTurnInput, ctx: {
  msgs: ReadonlyArray<WindowMsg>; presses: ReadonlyArray<WindowPress>; decisions: ReadonlyArray<WatchDecision>; nowMs: number;
  hasVersionCol?: boolean; intentFallback?: string | null;
}): WatchTurnEval {
  const { nowMs } = ctx;
  const w = staffWindowOf({ customerTurnAt: t.customer_turn_at, msgs: ctx.msgs, presses: ctx.presses, nowMs });
  // 2026-10-07 uran.: お礼・了承の番で下書きが読むべき範囲の外の行為を書いたか（下書きの欄が __SHOWN__ の時は最初の下書き）
  const upto = ctx.msgs.filter((m) => P(m.created_at) <= P(w.customerLastAt));
  // 2026-10-07: 下書きの欄が __SHOWN__（画面が表示した印）の番は draft_first で比べる（旧は返信の番の 39% を「印だけ」の na にしていた）
  const pick = pickJudgeDraft({ ...t, customer_last_at: w.customerLastAt });
  // 読むべき範囲の外の行為は前と同じく draft_first まで見る（uran. の見張り・スタッフが返さなかった番の数え方は変えない）
  const topicOut = outOfTopicActs(cleanDraft(t.draft_last).text ?? cleanDraft(t.draft_first).text, resolveAckTopicScope(upto));
  // 2026-10-08 返事を書いた人（直した所の表記→無ければ送った文全体の「確か」だけ）。STAFF_WRITER_SPLIT=off で渡さない
  const staffWriter = staffWriterSplitEnabled() ? staffWriterOfBurst(cleanDraft(pick.draft).text, w.texts.filter((x) => x.burst).map((x) => x.text).join("\n")) : null;
  const j = judgeTurn({
    draft: pick.draft, sentinel: t.draft_sentinel, brainAction: t.brain_action, brainReplyMode: t.brain_reply_mode,
    convStatus: t.conv_status, hasBrain: (t.brain_versions ?? 0) > 0, window: w, outOfTopicActs: topicOut, staffWriter,
  });
  if (topicOut.length && !j.detail.out_of_topic_acts) j.detail.out_of_topic_acts = topicOut;
  j.detail.draft_src = pick.src;
  const until = P(w.staffFirstAt ?? w.endAt);
  const dec = ctx.decisions.filter((d) => {
    const inTurn = d.analyzed_msg_ts ? P(d.analyzed_msg_ts) >= P(t.customer_turn_at) - 1000 && P(d.analyzed_msg_ts) <= P(w.customerLastAt) + 1000 : P(d.created_at) >= P(t.customer_turn_at);
    return inTurn && P(d.created_at) <= until;
  }).pop() ?? null;
  const scene = sceneKeyOf({ brainAction: t.brain_action, brainReplyMode: t.brain_reply_mode, tpoLabel: t.tpo_label, intent: dec?.intent ?? ctx.intentFallback ?? null, convStatus: t.conv_status });
  const draftAt = t.draft_last_at ?? t.draft_first_at;
  const patch: Record<string, unknown> = {
    staff_first_at: w.staffFirstAt,
    staff_texts: w.texts.map((x) => ({ at: x.at, burst: x.burst, text: x.text.slice(0, 2000) })),
    staff_aix: w.presses.map((p) => ({ aix_type: p.aix_type, check_pattern: p.check_pattern, at: p.at, burst: p.burst })),
    decision_id: dec?.id ?? null,
    verdict: j.verdict,
    verdict_detail: j.detail,
    scene_key: scene.key,
    draft_ready_before_staff: draftAt && w.staffFirstAt ? P(draftAt) <= P(w.staffFirstAt) : null,
    ...(ctx.hasVersionCol !== false ? { judge_version: JUDGE_VERSION } : {}),
    evaluated_at: new Date(nowMs).toISOString(),
  };
  return { judgement: j, scene, window: w, draftSrc: pick.src, decision: dec, patch };
}
