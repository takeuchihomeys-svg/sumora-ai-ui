// scripts/lib/prod-lessons.ts — 本番の外れ（自己改善の芯④ check-conductor）から統括の学び（conductor_lessons の1行）の下書きを作る（純関数・LLM も DB も使わない）
//
// 2026-11-22 作業員L（台帳 #433 の案 B・統括役の決め・KB 56691196「試験と連動して統括を鍛える」）:
//   試験の外れの下書き（scripts/lib/exam-lessons.ts・作業員H）と同じ形（LessonDraft）にそろえ、統括役が両方を見て書く（E）。
//   ⚠ 正解は竹内さん本人の番だけ（check-conductor が verdict_detail.staff_writer=takeuchi の番だけを返す・ここでも確かめる）
//   ⚠ 申込の門: 呼ぶ側が申込以降の番を外す（turn-application-gate）。お客様の文は呼ぶ側が伏せてから渡す（maskExamText）
//   ⚠ 漏れの線: source_conv に本番の会話を入れる（読む側が今の会話・試験の問題の会話を外す）
import type { LessonDraft } from "./exam-lessons";
import type { MissCause } from "./exam-miss-stage";
import { turnSituationText } from "../../app/lib/conductor-turn-vectors";

export type ProdMissType = "reply_not_aix" | "aix_not_reply" | "aix_kind" | "reply_content";
export type ProdCause = "aix_turn_as_reply" | "misread" | "material";
export type ProdMissTurn = {
  watchId: number; conv: string; at: string;
  type: ProdMissType; cause: ProdCause;
  staffWriter: string | null;
  staffAix: string[]; brainMode: string | null; brainAction: string | null;
  stage: string | null; scene: string | null; mood: string | null;
  /** 伏せ済みのお客様の文（申込の門を通った番だけ） */
  customerMasked: string;
  /** 竹内さんの返信の要点（伏せ済み・短く・無ければ null） */
  staffHeadMasked: string | null;
  /** こちらの下書きの要点（line_watch_turns.draft_last・伏せ済み・無ければ null）2026-11-22 統括役の頼み② */
  draftHeadMasked?: string | null;
};

const CAUSE_JA: Record<ProdCause, MissCause> = { aix_turn_as_reply: "AIX の番を返信にした", misread: "場面・決まりの読み違い", material: "材料が届いていない" };
const MISS_KIND: Record<ProdCause, LessonDraft["miss_kind"]> = { aix_turn_as_reply: "reply_vs_aix", misread: "scene_misread", material: "material_missing" };
const actOf = (aix: ReadonlyArray<string>, fallback = "返信") => (aix[0] ? `AIX:${aix[0]}` : fallback);

/** 本番の外れ1番 → 学びの下書き（竹内さん本人の番でなければ null） */
export function prodLessonDraft(t: ProdMissTurn): LessonDraft | null {
  if (t.staffWriter !== "takeuchi") return null;
  const expected = actOf(t.staffAix);
  const got = t.brainMode === "aix" ? `AIX:${t.brainAction ?? "?"}` : "返信";
  if (t.type !== "reply_content" && expected === got) return null; // 道が同じなら外れではない
  return {
    source: `prod:watch${t.watchId}`,
    source_conv: t.conv,
    dedupe_key: [t.conv, t.scene ?? "-", expected, got].join("|"),
    scene: t.scene, stage: t.stage, mood: t.mood,
    expected_act: expected, got_act: got,
    changed_stage: null,
    miss_kind: MISS_KIND[t.cause],
    check_order: null,
    situation_text: turnSituationText({ scene: t.scene, stage: t.stage, customerMasked: t.customerMasked, lastStaffKind: null }),
    seed: {
      type: t.type,
      why: [t.staffHeadMasked ? `竹内さんの返信（伏せ済み）: ${t.staffHeadMasked.slice(0, 120)}` : null, t.draftHeadMasked ? `こちらの下書き（伏せ済み）: ${t.draftHeadMasked.slice(0, 120)}` : null].filter(Boolean).join("／") || null,
      cause: CAUSE_JA[t.cause],
      stageNote: `本番の見張りの番 ${t.watchId}（${t.type}）`,
    },
  };
}

/** 同じ会話・同じ一手の組を1つにまとめる（新しい方を残す） */
export function dedupeDrafts(ds: ReadonlyArray<LessonDraft>): LessonDraft[] {
  const m = new Map<string, LessonDraft>();
  for (const d of ds) m.set(d.dedupe_key, d);
  return [...m.values()];
}

/** DeepSeek を呼んでよい時間か（夜 JST 22時〜翌8時・竹内さんの決まりの試験の時間と同じ） */
export function isNightJst(nowMs = Date.now()): boolean {
  const h = (new Date(nowMs).getUTCHours() + 9) % 24;
  return h >= 22 || h < 8;
}

/**
 * 本番の外れの lesson の問い（2026-11-22 統括役の頼み: ①場面を渡す ②竹内さんの返信とこちらの下書きの要点を両方渡し「何が違ったか」を書かせる）。
 *   11/22 夜の初版（exam-lessons.lessonPrompt をそのまま使った）は場面が「不明」で、16件中12件が空の一般論・意味の通らない物だった。
 *   文はどちらも伏せ済み・120字まで。名前・物件名・金額は書かせない
 */
export function prodLessonPrompt(d: LessonDraft, o: { sceneJa: string | null; staffHead: string | null; draftHead: string | null }): string {
  return [
    "あなたは不動産仲介の LINE 返信の統括を鍛える係です。本番で、竹内さん（正解）とこちら（AI）の一手が食い違った1番があります。",
    "次に同じ場面で統括が読むべき『型となぜ』を、日本語80字以内の1行で書いてください。形は『〜の場面で〜の時は〜（なぜ: 〜）』。",
    "お客様やスタッフの名前・物件名・金額は書かない。場面が分からない一般論（「不明な場面では確認を」等）は書かない。差が読めない時は『差が読めない』とだけ返す。1行だけを返す。",
    `場面: ${o.sceneJa ?? "（記録なし）"}・申込までの駅: ${d.stage ?? "不明"}`,
    `竹内さんの一手: ${d.expected_act}・こちらの一手: ${d.got_act ?? "不明"}・原因の見立て: ${d.seed.cause}`,
    `竹内さんの返信（伏せ済み）: ${(o.staffHead ?? "（なし＝返信を送っていない）").slice(0, 120)}`,
    `こちらの下書き（伏せ済み）: ${(o.draftHead ?? "（なし）").slice(0, 120)}`,
    "まず両方の違い（何を言った・言わなかった・どちらで送った）を読み、その違いを生んだ型を書く。",
  ].join("\n");
}
/** 返ってきた1行の確かめ: 「差が読めない」・場面の無い一般論は捨てる */
export function keepProdLesson(s: string | null): string | null {
  if (!s) return null;
  if (/差が読めない|不明な場面|場面が不明/.test(s)) return null;
  return s;
}
