// app/lib/estimate-sent-image-appeal.ts — 見積書のお部屋が採点の表（property_pickups）に無い時、お客様が送ってきた物件の読み（sent_image_properties.facts）を
//   judgeProperty に通して刺さり具合を作る（純関数・DB/LLM なし）。読むのは呼ぶ側（aix-template-generate）。
//
// 2026-11-18 作業員K（統括役の決め・竹内さん 11/18「そのような細かい部分も改善していくように」）。
//   見積書の2通目の締めの決め（estimate-second-message.resolveEstimateClosing）と竹内さんの実送信（60通・書き手は全部竹内さん）の一致は 23/60。
//   外れの原因は「材料が届いていない」: 60通のうち 49通は見積書のお部屋が採点の表に無い（33通は会話に採点の行そのものが無い＝お客様が送ってきた物件）。
//   お客様が送ってきた物件の読みを判定に通すと（読めた 23通）、刺さらない 20通は竹内さんが ご査収 12・内覧 5・申込 3、刺さる 3通は 3通とも内覧。
//   今の決め（頼まれた見積→内覧）はこの 20通を全部「内覧」にしていた → 刺さり具合を「頼まれた見積」より先に見る（ESTIMATE_SIP_APPEAL・既定 off）。
//   部屋の見分けは送った資料の現況の読み（recommend-vacating-source.sipVacating）と同じ線（号室の一致＋建物の鍵 sameBuildingTier）。退去予定・今見られるかは
//   sipVacating／resolveRecommendViewable のまま（二重に作らない・作業員L の SECOND_VACATING_ALL_AIX と同じ読み）。
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, type CustomerLike } from "./property-brain";
import { appealFromPickup } from "./recommend-cta";
import { sameBuildingTier } from "./recommend-vacating-source";
import type { SipRow } from "./recommend-vacating-source";

export function estimateSipAppealOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.ESTIMATE_SIP_APPEAL ?? "").trim().toLowerCase() === "on";
}

const roomKey = (s: string) => s.normalize("NFKC").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
const yen = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? `${n.toLocaleString("ja-JP")}円` : "");

/** 読みの事実 → 判定が読む物件の文（売上サポの行の文と同じ並び）。読めない欄は書かない */
export function summaryFromSipFacts(name: string, f: Record<string, unknown>): string {
  const num = (k: string) => (typeof f[k] === "number" ? (f[k] as number) : null);
  return [
    `【1】${name} ${String(f.room_no ?? "")}`.trim(),
    num("rent") != null ? `賃料 ${yen(num("rent"))}` : "",
    num("admin_fee_yen") != null ? `管理費 ${yen(num("admin_fee_yen"))}` : "",
    num("deposit_months") != null ? `敷金 ${num("deposit_months")}ヶ月` : "",
    num("key_money_months") != null ? `礼金 ${num("key_money_months")}ヶ月` : "",
    [typeof f.floor_plan === "string" ? f.floor_plan : "", num("area_sqm") != null ? `${num("area_sqm")}㎡` : ""].filter(Boolean).join(" "),
    typeof f.station === "string" && num("walk_minutes") != null ? `${f.station}駅 徒歩${num("walk_minutes")}分` : "",
    typeof f.built_ym === "string" ? `築年月 ${f.built_ym}` : "",
  ].filter(Boolean).join("\n");
}

/** 見積書のお部屋（見出し）に当たる読みの行（号室が一致・建物の鍵が一致・同じ鍵の中で新しい行） */
export function sipRowFor(rows: ReadonlyArray<SipRow>, head: { name: string; room: string }): SipRow | null {
  const hr = roomKey(head.room);
  if (!hr) return null;
  return rows.map((r) => ({ r, t: roomKey(String(r.room_no ?? (r.facts?.room_no as string | undefined) ?? "")) === hr && r.facts ? sameBuildingTier(r.property_name, head.name, head.room) : 0 }))
    .filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t || Date.parse(b.r.created_at ?? "") - Date.parse(a.r.created_at ?? ""))[0]?.r ?? null;
}

/** 見積書のお部屋ごとに、読みを判定に通した刺さり具合。1つでも刺されば strong・読めた物が全部刺さらなければ weak・読めなければ null */
export function estimateSipAppeal(rows: ReadonlyArray<SipRow>, heads: ReadonlyArray<{ name: string; room: string }>, customer: CustomerLike | null): { appeal: "strong" | "weak" | null; found: number } {
  if (!customer) return { appeal: null, found: 0 };
  const profile = buildCustomerProfile(customer);
  const per = heads.map((h) => {
    const row = sipRowFor(rows, h);
    if (!row?.facts) return null;
    const j = judgeProperty(parsePropertyFacts(summaryFromSipFacts(String(row.property_name ?? h.name), row.facts)), profile);
    return appealFromPickup({ verdict: j.verdict, reason_codes: j.reasonCodes })?.appeal ?? null;
  }).filter((a): a is "strong" | "weak" => a != null);
  if (!per.length) return { appeal: null, found: 0 };
  return { appeal: per.includes("strong") ? "strong" : "weak", found: per.length };
}
