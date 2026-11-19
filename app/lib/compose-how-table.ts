// app/lib/compose-how-table.ts — 場面×誘導先 → 竹内さんの「要点の押さえ方」「信頼の作り方」の多い型（静的な表・本番の LLM 費用 0）
//
// 2026-11-12 作業員10（統括役の案B・KB P1 c3673fba・1f5bd301・80586f34）。元: 作業員5 の夜の読み
//   exam-cache/anatomy-seven/seven-all198.json（竹内さんの返信 198通×DeepSeek・takeuchi-seven-read の point_how・trust_how・lead）。
//   キーは「場面（reply-scene の値）」と「場面|誘導先（lead）」。組が5通以上の物だけ・その組で半分以上の通に出た型を多い順に2つまで。
//   使い方: 文の統括の設計図（compose-sentence-plan）の「どうやって」が番の材料で空の時だけ、この表で埋める（番ごとの中身＝何を・訴求・潜在は埋めない）。
//   作り直し: 198通の読みを更新したら同じ数え方で表を書き直す（数えた値はコメントの %）。
import type { PointMethod, TrustMethod } from "./takeuchi-seven-read";

export type HowRow = { n: number; key: PointMethod[]; trust: TrustMethod[] };
export const TAKEUCHI_HOW_TABLE: Readonly<Record<string, HowRow>> = {
  "ack": { n: 22, key: ["conclusion_first","accept_first"], trust: ["support"] }, // 押 conclusion_first 64・accept_first 50／信 support 50
  "ack|answer_only": { n: 6, key: ["echo_words","accept_first"], trust: ["support"] }, // 押 echo_words 83・accept_first 67／信 support 67
  "ack|keep": { n: 7, key: ["conclusion_first","echo_words"], trust: ["kept_promise","support"] }, // 押 conclusion_first 71・echo_words 57／信 kept_promise 86・support 57
  "ack|viewing": { n: 6, key: ["conclusion_first","name_property"], trust: ["their_side","kept_promise"] }, // 押 conclusion_first 83・name_property 67／信 their_side 50・kept_promise 50
  "apply": { n: 22, key: ["conclusion_first"], trust: ["their_side","preempt"] }, // 押 conclusion_first 73／信 their_side 77・preempt 59
  "apply|apply": { n: 11, key: ["conclusion_first","name_property"], trust: ["their_side","preempt"] }, // 押 conclusion_first 91・name_property 55／信 their_side 82・preempt 64
  "apply|viewing": { n: 5, key: ["accept_first","assert"], trust: ["their_side","support"] }, // 押 accept_first 60・assert 60／信 their_side 100・support 60
  "conditions": { n: 22, key: ["echo_words","conclusion_first"], trust: ["support","effort"] }, // 押 echo_words 86・conclusion_first 77／信 support 82・effort 59
  "conditions|keep": { n: 20, key: ["echo_words","conclusion_first"], trust: ["support","effort"] }, // 押 echo_words 85・conclusion_first 80／信 support 90・effort 65
  "considering": { n: 22, key: ["accept_first","echo_words"], trust: ["their_side","support"] }, // 押 accept_first 91・echo_words 68／信 their_side 86・support 82
  "considering|answer_only": { n: 6, key: ["accept_first","echo_words"], trust: ["their_side","support"] }, // 押 accept_first 83・echo_words 67／信 their_side 83・support 50
  "considering|keep": { n: 7, key: ["accept_first","echo_words"], trust: ["support","their_side"] }, // 押 accept_first 86・echo_words 86／信 support 100・their_side 71
  "considering|viewing": { n: 6, key: ["accept_first","echo_words"], trust: ["support","their_side"] }, // 押 accept_first 100・echo_words 67／信 support 100・their_side 100
  "cost": { n: 22, key: ["conclusion_first","echo_words"], trust: ["their_side","support"] }, // 押 conclusion_first 64・echo_words 64／信 their_side 73・support 59
  "cost|answer_only": { n: 5, key: ["conclusion_first","reason_fact"], trust: ["fact","preempt"] }, // 押 conclusion_first 80・reason_fact 80／信 fact 100・preempt 60
  "cost|keep": { n: 9, key: ["accept_first","echo_words"], trust: ["support","their_side"] }, // 押 accept_first 89・echo_words 89／信 support 78・their_side 78
  "other": { n: 22, key: ["accept_first","echo_words"], trust: ["support","their_side"] }, // 押 accept_first 64・echo_words 64／信 support 73・their_side 73
  "other|keep": { n: 11, key: ["echo_words","accept_first"], trust: ["their_side","support"] }, // 押 echo_words 91・accept_first 73／信 their_side 73・support 64
  "other|viewing": { n: 5, key: ["conclusion_first"], trust: ["their_side","support"] }, // 押 conclusion_first 80／信 their_side 80・support 80
  "property_share": { n: 22, key: ["accept_first","conclusion_first"], trust: ["support","effort"] }, // 押 accept_first 64・conclusion_first 64／信 support 59・effort 55
  "property_share|estimate": { n: 8, key: ["accept_first","conclusion_first"], trust: ["effort","support"] }, // 押 accept_first 75・conclusion_first 75／信 effort 100・support 75
  "property_share|keep": { n: 10, key: ["echo_words","accept_first"], trust: ["support","kept_promise"] }, // 押 echo_words 80・accept_first 70／信 support 70・kept_promise 60
  "question": { n: 22, key: ["conclusion_first"], trust: ["support","their_side"] }, // 押 conclusion_first 73／信 support 64・their_side 55
  "question|keep": { n: 11, key: ["conclusion_first","accept_first"], trust: ["support","their_side"] }, // 押 conclusion_first 82・accept_first 55／信 support 82・their_side 64
  "viewing": { n: 22, key: ["accept_first","conclusion_first"], trust: ["their_side","support"] }, // 押 accept_first 68・conclusion_first 64／信 their_side 68・support 59
  "viewing|viewing": { n: 11, key: ["echo_words","accept_first"], trust: ["their_side","support"] }, // 押 echo_words 73・accept_first 64／信 their_side 73・support 64
};

/** 場面×誘導先の行（無ければ場面の行・それも無ければ null） */
export function takeuchiHowFor(scene: string | null | undefined, lead: string | null | undefined): (HowRow & { keyUsed: string }) | null {
  if (!scene) return null;
  const k1 = lead ? `${scene}|${lead}` : null;
  if (k1 && TAKEUCHI_HOW_TABLE[k1]) return { ...TAKEUCHI_HOW_TABLE[k1], keyUsed: k1 };
  return TAKEUCHI_HOW_TABLE[scene] ? { ...TAKEUCHI_HOW_TABLE[scene], keyUsed: scene } : null;
}
