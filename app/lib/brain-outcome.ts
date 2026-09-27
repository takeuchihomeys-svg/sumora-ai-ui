// app/lib/brain-outcome.ts
// ブレインの判断（brain_decision_logs）の「後にスタッフが何をしたか」を事実（AIX の記録・こちらの送信・下書きの記録）から決める（純関数）。
// 2026-09-27 竹内「このようにテスト繰り返して質上げていくために足りない部分等見つけていく／そうすれば完全自動化できるから」
//
// なぜ作ったか（記録の穴・2026-09-27 に実物で測った・YUMA 除く 8/31〜9/27 の判断 1,641件）:
//   outcome は画面（page.tsx executeSend / sendMessageText）が送信の瞬間に「その会話の outcome が空の一番新しい判断」だけに書いていた。
//   ① 次の判断が先に来た判断（お客様の連投・スタッフの宣言での再分析）は誰も書かない … 261件
//   ② 何も送らなかった判断は書く時が来ない … 316件（次の判断まで送信なし 217・最後の判断 99）
//   ③ 24時間より後の送信・画面以外の送信（予約送信・お客様役） … 46件
//   さらに書いた値も事実とずれていた: aix_followed は押した AIX がブレインと違っても付く／draft_followed は下書きの控えが空でも付く
//   （draft_modified は1件も無い）／ignored は手打ち・画像・下書きの手直しの区別が無い。
// 直し: 判断ごとに「次の判断か24時間まで」の窓で最初の行動を事実から決め、cron/brain-aix-eval が毎日 outcome に書き戻す
//   （画面の即時の値は仮。OUTCOME_RESOLVED_FROM 以降の判断だけ、窓が閉じたらここの値で上書きする。過去の行は書き換えない）。自動化の度合いの表（automation-readiness）も同じ関数を読む。
//
// 値（outcome）:
//   aix_followed    … ブレインと同じ AIX を押した＝提案どおり（acknowledge_check は property_check_result と同じ。旧の名前をそのまま使う）
//   aix_different   … ブレインと違う AIX を押した＝提案は外れ（ブレインが AIX なしの時に押したも含む・押した種類は actual_aix_type）
//   draft_followed  … 下書きをそのまま送った（絵文字・空白も触っていない）
//   draft_modified  … 下書きを直して送った（類似度 0.3 以上）
//   draft_rewritten … 下書きがあったが書き直した（類似度 0.3 未満）
//   manual          … 下書きなしで手打ち・画像だけを送った（旧の ignored の中身）
//   reply_unknown   … 文を送ったが下書きの記録（ai_reply_examples）が見つからない
//   superseded      … 何もしないうちに次の判断が来た（連投・再分析）
//   no_action       … 24時間何も送らなかった
//   （窓がまだ閉じていない判断は null のまま）
import { classifyEdit, type EditDiff } from "./edit-diff";

export const OUTCOME_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 送った文と下書きの記録（ai_reply_examples.sent_at）を結ぶ時刻の幅 */
export const EXAMPLE_MATCH_MS = 5 * 60 * 1000;

export type BrainOutcome =
  | "aix_followed" | "aix_different" | "draft_followed" | "draft_modified" | "draft_rewritten"
  | "manual" | "reply_unknown" | "superseded" | "no_action";

export const BRAIN_OUTCOME_JA: Record<BrainOutcome, string> = {
  aix_followed: "ブレインと同じ AIX",
  aix_different: "別の AIX",
  draft_followed: "下書きをそのまま",
  draft_modified: "下書きを直して",
  draft_rewritten: "下書きを書き直し",
  manual: "手打ち（下書きなし）",
  reply_unknown: "文を送った（下書きの記録なし）",
  superseded: "次の判断が先",
  no_action: "何もしない（24時間）",
};

export type OutcomeDecision = { id: string; conversation_id: string; created_at: string; suggested_action: string | null };
export type OutcomePress = { conversation_id: string; aix_type: string | null; created_at: string };
export type OutcomeStaffMessage = { conversation_id: string; created_at: string; text: string | null; is_aix_generated?: boolean | null };
export type OutcomeReplyExample = { conversation_id: string | null; sent_at: string | null; sent_reply: string | null; ai_draft: string | null; entry_source?: string | null };

export type ResolvedOutcome = {
  decision: OutcomeDecision;
  /** 窓が閉じていない判断は null */
  outcome: BrainOutcome | null;
  /** 押した AIX（aix_* の時） */
  pressedAix: string | null;
  /** 送った文と下書きの差（draft_* の時） */
  edit: EditDiff | null;
  /** 最初の行動の時刻 */
  actedAt: string | null;
};

const ms = (iso: string) => new Date(iso).getTime();
const normAix = (a: string | null | undefined) => { const s = (a ?? "").trim(); return s === "acknowledge_check" ? "property_check_result" : s; };
const isMediaText = (t: string | null | undefined) => !t || t === "[画像]" || t === "[動画]" || t === "[ファイル]" || t === "[スタンプ]";

function groupBy<T>(rows: ReadonlyArray<T>, key: (r: T) => string | null | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); if (!k) continue; const a = m.get(k) ?? []; a.push(r); m.set(k, a); }
  for (const a of m.values()) a.sort((x, y) => ms((x as { created_at?: string; sent_at?: string }).created_at ?? (x as { sent_at?: string }).sent_at ?? "") - ms((y as { created_at?: string; sent_at?: string }).created_at ?? (y as { sent_at?: string }).sent_at ?? ""));
  return m;
}

/** こちらの文の送信に下書きの記録を結ぶ（同じ会話・±5分・文が同じか、送った文が記録の文を含む／含まれる） */
export function matchReplyExample(msg: OutcomeStaffMessage, examples: ReadonlyArray<OutcomeReplyExample>): OutcomeReplyExample | null {
  const t = ms(msg.created_at);
  const text = String(msg.text ?? "").trim();
  let best: OutcomeReplyExample | null = null, bestGap = Infinity;
  for (const e of examples) {
    if (!e.sent_at) continue;
    const gap = Math.abs(ms(e.sent_at) - t);
    if (gap > EXAMPLE_MATCH_MS) continue;
    const sr = String(e.sent_reply ?? "").trim();
    if (!sr || !text) continue;
    if (sr === text || sr.includes(text) || text.includes(sr)) {
      if (gap < bestGap) { best = e; bestGap = gap; }
    }
  }
  return best;
}

/**
 * 判断ごとの outcome（純関数）。
 * @param nowMs 窓が閉じたかの判定に使う現在時刻（テスト用に注入）
 */
export function resolveBrainOutcomes(input: {
  decisions: ReadonlyArray<OutcomeDecision>;
  presses: ReadonlyArray<OutcomePress>;
  staffMessages: ReadonlyArray<OutcomeStaffMessage>;
  replyExamples: ReadonlyArray<OutcomeReplyExample>;
  nowMs?: number;
}): ResolvedOutcome[] {
  const nowMs = input.nowMs ?? Date.now();
  const decBy = groupBy(input.decisions, (d) => d.conversation_id);
  const pressBy = groupBy(input.presses.filter((p) => p.aix_type), (p) => p.conversation_id);
  const msgBy = groupBy(input.staffMessages, (m) => m.conversation_id);
  const exBy = groupBy(input.replyExamples.filter((e) => (e.entry_source ?? "line_reply") === "line_reply"), (e) => e.conversation_id);
  const out: ResolvedOutcome[] = [];
  for (const [conv, decs] of decBy) {
    const presses = pressBy.get(conv) ?? [];
    const msgs = msgBy.get(conv) ?? [];
    const exs = exBy.get(conv) ?? [];
    decs.forEach((d, i) => {
      const start = ms(d.created_at);
      const next = decs[i + 1] ? ms(decs[i + 1].created_at) : Infinity;
      const end = Math.min(next, start + OUTCOME_WINDOW_MS);
      const inWin = (iso: string) => { const t = ms(iso); return t >= start && t < end; };
      const press = presses.find((p) => inWin(p.created_at)) ?? null;
      if (press) {
        const same = !!normAix(d.suggested_action) && normAix(press.aix_type) === normAix(d.suggested_action);
        out.push({ decision: d, outcome: same ? "aix_followed" : "aix_different", pressedAix: press.aix_type, edit: null, actedAt: press.created_at });
        return;
      }
      // AIX で送った文（is_aix_generated）は AIX の記録の側で数える（ここでは手打ちに数えない）
      const sends = msgs.filter((m) => inWin(m.created_at) && !m.is_aix_generated);
      const firstText = sends.find((m) => !isMediaText(m.text));
      if (firstText) {
        const ex = matchReplyExample(firstText, exs);
        if (!ex) { out.push({ decision: d, outcome: "reply_unknown", pressedAix: null, edit: null, actedAt: firstText.created_at }); return; }
        const draft = String(ex.ai_draft ?? "").trim();
        if (!draft) { out.push({ decision: d, outcome: "manual", pressedAix: null, edit: null, actedAt: firstText.created_at }); return; }
        const edit = classifyEdit(draft, String(ex.sent_reply ?? ""));
        const outcome: BrainOutcome = edit.amount === "none" ? "draft_followed" : edit.amount === "rewrite" ? "draft_rewritten" : "draft_modified";
        out.push({ decision: d, outcome, pressedAix: null, edit, actedAt: firstText.created_at });
        return;
      }
      if (sends.length > 0) { out.push({ decision: d, outcome: "manual", pressedAix: null, edit: null, actedAt: sends[0].created_at }); return; }
      if (next !== Infinity && next < start + OUTCOME_WINDOW_MS) { out.push({ decision: d, outcome: "superseded", pressedAix: null, edit: null, actedAt: null }); return; }
      if (end <= nowMs) { out.push({ decision: d, outcome: "no_action", pressedAix: null, edit: null, actedAt: null }); return; }
      out.push({ decision: d, outcome: null, pressedAix: null, edit: null, actedAt: null });
    });
  }
  return out;
}

/**
 * AIX を押した時点のブレインの予想（log-aix-usage が suggested_action に書く・表が過去分を推定する時も同じ関数）。
 *   押した時刻より前の一番新しい判断（48時間以内）。判断があって AIX なしなら "none"、判断が無ければ null。
 */
export const PREDICTION_LOOKBACK_MS = 48 * 60 * 60 * 1000;
export function brainPredictionAt(decisionsOfConv: ReadonlyArray<{ created_at: string; suggested_action: string | null }>, atIso: string): string | null {
  const t = ms(atIso);
  let best: { created_at: string; suggested_action: string | null } | null = null;
  for (const d of decisionsOfConv) {
    const dt = ms(d.created_at);
    if (dt > t || t - dt > PREDICTION_LOOKBACK_MS) continue;
    if (!best || dt > ms(best.created_at)) best = d;
  }
  if (!best) return null;
  return best.suggested_action ? best.suggested_action : "none";
}

/**
 * cron/brain-aix-eval が outcome を事実から書き直す判断の始まり（この時刻より前の判断は書き換えない）。
 * 2026-09-27 竹内「学習のところ『提案と違う』と記録して、学習にもそう反映する形でよい」／親「過去の行は勝手に書き換えない」:
 * 過去の行は scripts/automation-readiness.ts が推定して食い違いを報告するだけ。
 */
export const OUTCOME_RESOLVED_FROM = "2026-09-28T00:00:00+09:00";

/**
 * 画面が送信の瞬間に書く仮の outcome（AIX）。押した AIX の種類がブレインの提案と違えば aix_different（旧は種類を見ずに aix_followed を付けていた）。
 * 種類が分からない時は null（書かない＝cron が事実から決める）。
 */
export function immediateAixOutcome(brainAction: string | null | undefined, sentAix: string | null | undefined): BrainOutcome | null {
  if (!sentAix) return null;
  return !!brainAction && normAix(brainAction) === normAix(sentAix) ? "aix_followed" : "aix_different";
}

/**
 * 画面が送信の瞬間に書く仮の outcome（文）。下書きの控えが空なのに「下書きどおり」と書いていた（旧 draft_followed）のを直す。
 * 書き直し（類似度 0.3 未満）の区別は cron が付ける。
 */
export function immediateTextOutcome(input: { draftIsAi: boolean; originalDraft: string | null | undefined; sentText: string }): BrainOutcome | null {
  const orig = String(input.originalDraft ?? "").trim();
  if (!input.draftIsAi) return "manual";
  if (!orig) return null;
  return orig === input.sentText.trim() ? "draft_followed" : "draft_modified";
}
