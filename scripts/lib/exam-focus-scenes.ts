// scripts/lib/exam-focus-scenes.ts — 試験を寄せる場面の順位（#823 ③・純関数・LLM/DB なし・2026-11-27 作業員A）
//
// line-watch-eval の毎日の照らし（line_watch_turns: ブレインの判断・下書き と スタッフの一手）から、場面ごとの外れの数を出し、
//   試験の問題（exam-dictionary の problems の scene）の数と並べて、試験を寄せる場面の順位にする（記録だけ・朝の1枚に1行）。
// 外れ（番ごと・どれか1つ）:
//   文の外れ   … verdict が partial・different（下書きとスタッフの文が違う）
//   AIX の外れ … verdict_detail.aix_verdict が not_pressed（ブレインの AIX をスタッフが押さない）・unexpected（スタッフだけ AIX）・other（違う AIX）
//   返信を AIX … ブレインは返信なのにスタッフが AIX を押した（#812 の影の 84番と同じ型）
// 順位: 外れの数が多く、問題が少ない場面を先に（点＝外れ ÷ (1 ＋ 問題の数/5)）。判定の無い番（na・null）は数えない。

export type WatchRow = { scene: string; verdict: string | null; aixVerdict: string | null; brainReply: boolean; staffAix: boolean };
export type FocusRow = { scene: string; judged: number; miss: number; textMiss: number; aixMiss: number; replyAsAix: number; missRate: number | null; problems: number; score: number };
const JUDGED = new Set(["same", "same_meaning", "partial", "different"]);
const AIX_MISS = new Set(["not_pressed", "unexpected", "other"]);

/** 見張りの場面のキー → 試験の問題の場面（exam-dictionary の problems.scene）。決まらなければ null */
export function problemSceneOf(watchScene: string): string | null {
  const s = watchScene;
  if (/^対象外/.test(s)) return null;
  if (/短い了承・お礼|お礼|了承/.test(s)) return "ack";
  if (/質問/.test(s)) return "question";
  if (/条件提示|条件フォーム/.test(s)) return "conditions";
  if (/検討中|保留/.test(s)) return "considering";
  if (/内覧/.test(s) || /AIX:(?:viewing_invite|meeting_place|greeting_viewing)/.test(s)) return "viewing";
  if (/持ち込み|物件への反応/.test(s) || /AIX:(?:property_send|property_recommendation|property_check_result)/.test(s)) return "property_share";
  if (/AIX:(?:estimate_sheet|cost_breakdown)/.test(s)) return "cost";
  if (/AIX:application_push|申込/.test(s)) return "apply";
  return "other";
}

/** 場面ごとの外れと、試験の問題の数（problemCount＝試験の場面 → 問題の数） */
export function focusTable(rows: readonly WatchRow[], problemCount: Readonly<Record<string, number>>): FocusRow[] {
  const by = new Map<string, WatchRow[]>();
  for (const r of rows) if (!/^対象外/.test(r.scene)) by.set(r.scene, [...(by.get(r.scene) ?? []), r]);
  return [...by].map(([scene, xs]) => {
    const judged = xs.filter((x) => JUDGED.has(String(x.verdict)) || AIX_MISS.has(String(x.aixVerdict)) || (x.brainReply && x.staffAix));
    let textMiss = 0, aixMiss = 0, replyAsAix = 0, miss = 0;
    for (const x of judged) {
      const t = x.verdict === "partial" || x.verdict === "different", a = AIX_MISS.has(String(x.aixVerdict)), r = x.brainReply && x.staffAix;
      if (t) textMiss++; if (a) aixMiss++; if (r) replyAsAix++; if (t || a || r) miss++;
    }
    const ps = problemSceneOf(scene); const problems = ps ? problemCount[ps] ?? 0 : 0;
    return { scene, judged: judged.length, miss, textMiss, aixMiss, replyAsAix, missRate: judged.length ? Math.round((miss / judged.length) * 1000) / 10 : null, problems, score: Math.round((miss / (1 + problems / 5)) * 10) / 10 };
  }).sort((a, b) => b.score - a.score || b.miss - a.miss);
}
/** 朝の1枚の1行（上位3つ） */
export function focusLine(t: readonly FocusRow[], days: number): string {
  const top = t.filter((r) => r.miss > 0).slice(0, 3);
  if (!top.length) return `- 試験を寄せる場面（見張りの ${days}日）: 外れの多い場面なし`;
  return `- 試験を寄せる場面（見張りの ${days}日・外れが多く問題が少ない順）: ${top.map((r, i) => `${i + 1}. ${r.scene}（外れ ${r.miss}/${r.judged}・文 ${r.textMiss}・AIX ${r.aixMiss}・返信を AIX ${r.replyAsAix}・問題 ${r.problems}）`).join("　")}`;
}
