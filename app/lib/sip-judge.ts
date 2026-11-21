// app/lib/sip-judge.ts — 売上サポ（AIX ツール）を通らずに送った物件を、画像の読み（sent_image_properties.facts）から判定に通す（純関数・LLM なし・既定 off）
//
// 2026-11-21 作業員K2（台帳 #511・#479 の子・統括役の了承）: 直近7日の物件オススメ 35件のうち 24件は売上サポに同じ建物の行が無かった
//   （AIX の画面に貼った画像を Vision で読んだ 9・トークに貼った画像 6・ピックアップで送ったが行が無い 2・共有 1・記録なし 6）。
//   画像の読み（facts）はほぼ全部埋まっている（vision/pickup 57/57・staff_image 37/37）のに、判定（推す点・合う点・合わない点の札）に通していなかった。
//   作業員K の見積書の道（estimate-sent-image-appeal: summaryFromSipFacts → judgeProperty）と同じ形で、物件オススメの2通目の締め・ブレインの「選んだ理由」・数えに通す。
// ■ スイッチ SIP_JUDGE: 既定 off／on（呼ぶ側が使う）
// テスト: app/lib/__tests__/sip-judge.test.ts
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, type CustomerLike } from "./property-brain";
import { summaryFromSipFacts } from "./estimate-sent-image-appeal";

type Env = Record<string, string | undefined>;
export function sipJudgeOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.SIP_JUDGE ?? "").trim().toLowerCase() === "on";
}

export type SipLike = { property_name: string | null; room_no?: string | null; facts: Record<string, unknown> | null; created_at?: string | null };
export type SipJudgment = { property_name: string; room_no: string | null; verdict: string; score: number; reason_codes: string[] };

/** 1つの読み → 判定（読めない時は null） */
export function judgeSip(row: SipLike, customer: CustomerLike | null): SipJudgment | null {
  if (!customer || !row.facts || !(row.property_name ?? "").trim()) return null;
  try {
    const j = judgeProperty(parsePropertyFacts(summaryFromSipFacts(String(row.property_name), row.facts)), buildCustomerProfile(customer));
    return { property_name: String(row.property_name), room_no: (row.room_no ?? (row.facts.room_no as string | undefined) ?? null) || null, verdict: j.verdict, score: j.score, reason_codes: j.reasonCodes };
  } catch { return null; }
}

/** 同じ部屋（建物＋号室）の読みは新しい1つだけにして判定（最大 max 件） */
export function judgeSips(rows: ReadonlyArray<SipLike>, customer: CustomerLike | null, max = 5): SipJudgment[] {
  const k = (r: SipLike) => `${String(r.property_name ?? "").normalize("NFKC").replace(/[\s　]/g, "")}#${String(r.room_no ?? r.facts?.room_no ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "")}`;
  const seen = new Set<string>(); const out: SipJudgment[] = [];
  for (const r of [...rows].sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))) {
    if (seen.has(k(r))) continue; seen.add(k(r));
    const j = judgeSip(r, customer); if (j) out.push(j);
    if (out.length >= max) break;
  }
  return out;
}
