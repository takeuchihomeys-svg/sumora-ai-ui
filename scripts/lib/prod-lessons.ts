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
      why: t.staffHeadMasked ? `竹内さんの返信の要点（伏せ済み）: ${t.staffHeadMasked.slice(0, 120)}` : null,
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
