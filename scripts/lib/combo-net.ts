// scripts/lib/combo-net.ts — 返信と AIX の組の「本当の一致」（combo_net・純関数・LLM なし・DB なし）
//
// 2026-11-23 作業員A（統括役の決め・台帳 #624）: 組の一致（comboDaily の sameRate）の外れ 5番（14日）を実物で分けると、本当の外れは 1番だけだった
//   （2段の一致 2・割れ 1・竹内さんの決定で正解を改めた番 1）。今の数は変えずに、P の地図（AIX の番の木・端末の版）と同じ分け方の数を並べる。
// 決まり（P の地図の名前に合わせる）:
//   ・端末の記録で竹内さん本人の番だけ（手の通が全部 staff_writer=takeuchi かつ staff_writer_source=device）。それ以外は分母から外す（writer）
//   ・2段の一致: ブレインが2段（promise_then_aix_later）・竹内さんは返信だけ（reply_only）＝最初の一手が同じ（約束の返信が先）→ 一致に数える（two_stage_first）
//   ・外れのうち、竹内さんの決定で正解を改めた番（decided）・割れ（split）・竹内さんの少数側（minority）・時刻で送る物（timed＝竹内さんの AIX が当日のご挨拶）は分母から外す
//   ・それ以外の外れは本当の外れ（real）
// 竹内さんに出す数は、2週間並べてから切り替えを聞く（統括役 11/23）
export type ComboNetMark = "decided" | "split" | "minority" | "timed";
export type ComboNetTurn = {
  /** 会話の頭8字＋番の時刻（ISO） */
  conv: string; at: string;
  matched: boolean; brain: string | null; takeuchi: string | null;
  /** 手の通が全部 端末の記録で竹内さん本人 */
  device: boolean;
  /** 竹内さんの最初の AIX の種類（無ければ null） */
  firstAixKind?: string | null;
  /** 外の印（決定で改めた番・割れ・少数側）。時刻で送る物は firstAixKind から決める */
  mark?: ComboNetMark | null;
};
export type ComboNet = {
  n: number; same: number; rate: number | null;
  twoStageFirst: number;
  excluded: { writer: number; decided: number; split: number; minority: number; timed: number };
  real: Array<{ conv: string; at: string; brain: string | null; takeuchi: string | null; kind?: ComboRealKind }>;
  /** 2026-11-24 作業員A（統括役の頼み）: 本当の外れの分け（並び・組の形・数え方の誤り） */
  realKinds?: Record<ComboRealKind, number>;
};
export type ComboRealKind = "order" | "shape" | "counting";
export const COMBO_REAL_KIND_JA: Record<ComboRealKind, string> = { order: "並び（同じ物の順が違う）", shape: "組の形（AIX の有る無し・数が違う）", counting: "数え方の誤り（同じ形を時間の窓・記録の欠けで別に数えた）" };
/** 組の中身: 返信と AIX の数と、どちらが先か（promise_then_aix_later と reply_then_aix_quick は同じ「返信が先・AIX が後」） */
const COMBO_PARTS: Record<string, { reply: number; aix: number; first: "reply" | "aix" }> = {
  reply_only: { reply: 1, aix: 0, first: "reply" }, aix_only: { reply: 0, aix: 1, first: "aix" }, aix_then_reply: { reply: 1, aix: 1, first: "aix" },
  reply_then_aix_quick: { reply: 1, aix: 1, first: "reply" }, promise_then_aix_later: { reply: 1, aix: 1, first: "reply" }, aix_then_aix: { reply: 0, aix: 2, first: "aix" },
};
/** 本当の外れ1つを分ける（純関数）: 片方が読めない／同じ形（時間の窓の違いだけ）＝数え方・同じ数で順が違う＝並び・数が違う＝組の形 */
export function comboRealKindOf(brain: string | null, takeuchi: string | null): ComboRealKind {
  const b = brain ? COMBO_PARTS[brain] : undefined, t = takeuchi ? COMBO_PARTS[takeuchi] : undefined;
  if (!b || !t) return "counting";
  if (b.reply === t.reply && b.aix === t.aix) return b.first === t.first ? "counting" : "order";
  return "shape";
}
export const TIMED_FIRST_AIX = new Set(["greeting_viewing"]);

export function comboNetOf(turns: ReadonlyArray<ComboNetTurn>): ComboNet {
  const out: ComboNet = { n: 0, same: 0, rate: null, twoStageFirst: 0, excluded: { writer: 0, decided: 0, split: 0, minority: 0, timed: 0 }, real: [], realKinds: { order: 0, shape: 0, counting: 0 } };
  for (const t of turns) {
    if (!t.device) { out.excluded.writer++; continue; }
    const twoStage = !t.matched && t.brain === "promise_then_aix_later" && t.takeuchi === "reply_only";
    if (t.matched || twoStage) { out.n++; out.same++; if (twoStage) out.twoStageFirst++; continue; }
    const kind = String(t.firstAixKind ?? "").split("/")[0];
    if (TIMED_FIRST_AIX.has(kind)) { out.excluded.timed++; continue; }
    if (t.mark) { out.excluded[t.mark]++; continue; }
    out.n++;
    const rk = comboRealKindOf(t.brain, t.takeuchi);
    out.real.push({ conv: t.conv, at: t.at, brain: t.brain, takeuchi: t.takeuchi, kind: rk });
    out.realKinds![rk]++;
  }
  out.rate = out.n ? Math.round((out.same / out.n) * 1000) / 10 : null;
  return out;
}

/** 外の印を番に当てる（純関数）: 決定で改めた番は試験の問題（why か tags に「竹内さんの決定」）と会話（頭8字）・時刻 ±2分、
 *  割れ・少数側は P の地図の番の印（{conv, at, side}・夜の地図で書いた物）と会話・時刻 ±2分で突き合わせる */
export function comboNetMarkOf(
  t: { conv: string; at: string },
  spec: ReadonlyArray<{ conv?: string; at?: string; why?: string; tags?: unknown }>,
  sides: ReadonlyArray<{ conv: string; at: string; side: string }> = [],
): ComboNetMark | null {
  const ms = Date.parse(t.at);
  const near = (c: string | undefined, a: string | undefined) => !!c && !!a && c.slice(0, 8) === t.conv.slice(0, 8) && Math.abs(Date.parse(a.length <= 16 ? `${a}:00Z` : a) - ms) <= 120_000;
  if (spec.some((p) => near(p.conv, p.at) && /竹内さんの決定/.test(`${p.why ?? ""} ${JSON.stringify(p.tags ?? [])}`))) return "decided";
  const s = sides.find((x) => near(x.conv, x.at) && (x.side === "split" || x.side === "minority"));
  return s ? (s.side as ComboNetMark) : null;
}
