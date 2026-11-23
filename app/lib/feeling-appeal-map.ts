// app/lib/feeling-appeal-map.ts — 土台「気持ち」「訴求」の場面ごとの物差し（純関数・DB/LLM なし・作業員P・2026-11-23・前の作業員K2 の残りを P に付け替え）
//
// 今日の型（台帳 #610 の地図）に揃える: 竹内さん本人の番だけ（端末の記録）・竹内さんの手打ちの返信と、その番の AI の下書き（line_watch_turns.draft_last）を同じ網で比べる・
//   本当の外れ・原因の4つ・地図の木の根（feeling:by_scene・appeal:by_scene）。
//   網は作業員K2 の scripts/audit-scene-feeling-appeal.ts の FEEL_RE・APPEAL_RE・INVITE_RE と同じ（竹内さん本人の実送信の形を数えた網）。
//   気持ち … 受けた（共感・気持ちの語）／受けていない。 訴求 … 内覧へ誘った > 推した > どちらも無い（強い方を1つ）。
//   外れの型: 気持ち＝feel_missed（竹内さんは受けた・AI は受けない）／feel_extra（AI だけ受けた）、
//            訴求＝appeal_missed（竹内さんは推した・誘った・AI は無い）／appeal_extra（AI だけ推した・誘った）／appeal_other（どちらもあるが 推す と 誘う が違う）。
//   原因（仮の決め方）: その番のブレインの材料の塊（materials.brain.blocks.empty）に関わる塊の空があれば「材料が届いていない」、ほかは「読み違い」。
//   本文は出さない（印を見るだけ）。

export const FEEL_RE = /ですよね|お気持ち|ご不安|ご心配|不安な|心配な|分かります|わかります|嬉しい|うれしい|良かった|よかった|安心|残念|お辛い|大変でしたね|お忙しい中/;
export const APPEAL_RE = /オススメ|おすすめ|お勧め|お得|初期費用(?:を|も)?抑え|審査(?:通過|が通り)|人気|すぐに?埋まり|早め|お早め|🌟|一押し|特に/;
export const INVITE_RE = /ご案内させて|ご内覧|内覧(?:頂|いただ|のご案内)|お気に召され/;

export type AppealKind = "invite" | "appeal" | "none";
export function feelingOf(text: string): boolean { return FEEL_RE.test(String(text ?? "").normalize("NFKC")); }
export function appealOf(text: string): AppealKind {
  const t = String(text ?? "").normalize("NFKC");
  return INVITE_RE.test(t) ? "invite" : APPEAL_RE.test(t) ? "appeal" : "none";
}
/** 気持ちの外れの型（純関数） */
export function feelingMissOf(takeuchi: boolean, ai: boolean): "ok" | "feel_missed" | "feel_extra" {
  return takeuchi === ai ? "ok" : takeuchi ? "feel_missed" : "feel_extra";
}
/** 訴求の外れの型（純関数） */
export function appealMissOf(takeuchi: AppealKind, ai: AppealKind): "ok" | "appeal_missed" | "appeal_extra" | "appeal_other" {
  if (takeuchi === ai) return "ok";
  if (ai === "none") return "appeal_missed";
  if (takeuchi === "none") return "appeal_extra";
  return "appeal_other";
}
/** 原因に見る材料の塊（ブレインの材料の塊の名前・materials.brain.blocks.empty に出る名前） */
// 塊の名前は本番の materials.brain.blocks.empty に出る物（11/23 の見張りの行で見た名前）: お客様のまとめ（aiSummary）・お客様の像（profile）
export const FEELING_BLOCKS = ["aiSummary", "profile"];
export const APPEAL_BLOCKS = ["appealTiming", "sentProps", "seeMore", "applyReadiness", "propertySearch"];
export function causeOf(miss: string, emptyBlocks: readonly string[] | null | undefined, which: "feeling" | "appeal"): "material" | "misread" | null {
  if (miss === "ok") return null;
  const want = which === "feeling" ? FEELING_BLOCKS : APPEAL_BLOCKS;
  return (emptyBlocks ?? []).some((b) => want.some((w) => b.toLowerCase().includes(w.toLowerCase()))) ? "material" : "misread";
}

/** 監査の1行（scripts/audit-feeling-appeal-takeuchi.ts の json） */
export type FeelingAppealRow = { id: number; conv: string; at: string; scene: string; tkFeel: boolean; aiFeel: boolean; tkAppeal: AppealKind; aiAppeal: AppealKind; empty: string[] };
/** 地図の木の番に（純関数）。種類の段は使わず 場面 → 外れの型 → 原因 */
export function feelingAppealTurnsOf(rows: readonly FeelingAppealRow[], which: "feeling" | "appeal") {
  return rows.map((r) => {
    const miss = which === "feeling" ? feelingMissOf(r.tkFeel, r.aiFeel) : appealMissOf(r.tkAppeal, r.aiAppeal);
    return { id: r.id, kind: "", scene: r.scene || "other", miss, cause: causeOf(miss, r.empty, which) };
  });
}
/** 場面ごとの数え（純関数・毎朝の1枚と監査の表） */
export function feelingAppealSummaryOf(rows: readonly FeelingAppealRow[]) {
  const by: Record<string, { n: number; feelOk: number; appealOk: number; feelMissed: number; feelExtra: number; appealMissed: number; appealExtra: number; appealOther: number }> = {};
  for (const r of rows) {
    const s = (by[r.scene] ??= { n: 0, feelOk: 0, appealOk: 0, feelMissed: 0, feelExtra: 0, appealMissed: 0, appealExtra: 0, appealOther: 0 });
    s.n++;
    const f = feelingMissOf(r.tkFeel, r.aiFeel), a = appealMissOf(r.tkAppeal, r.aiAppeal);
    if (f === "ok") s.feelOk++; else if (f === "feel_missed") s.feelMissed++; else s.feelExtra++;
    if (a === "ok") s.appealOk++; else if (a === "appeal_missed") s.appealMissed++; else if (a === "appeal_extra") s.appealExtra++; else s.appealOther++;
  }
  return by;
}
