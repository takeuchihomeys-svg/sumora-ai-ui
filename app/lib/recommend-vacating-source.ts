// app/lib/recommend-vacating-source.ts（純関数・DB なし）
// AIX【物件オススメ】の✨2通目の「退去予定」の材料の出どころを足す（2026-10-15 小さな直し）。
//   今の✨（aix-template-generate）は property_pickups の行（資料の現況 terms.moveIn）だけを見ていた。
//   出どころの数え（scripts/audit-recommend-vacating-source.ts）で、竹内さんが2通目に退去予定を書いた番の材料は
//   送った資料の画像の読み（sent_image_properties.facts.status＝move_out_planned・vacancy_date）にある事が多かった。
//   ここは「その会話の、1通目の物件に当たる送った資料の読み」を1つ選んで、退去予定か・退去予定日を返すだけ。書くかどうかはブレインと生成が決める。
import { pickupForFirstMessage, type PickupLookupRow } from "./recommend-cta";
import { readPropertyStateFromText } from "./property-send-state";
import { VACATING_NO_DATE_LINE, type RecommendViewable } from "./recommend-viewable";

/** 戻す: RECOMMEND_VACATING_SENT_IMAGE=off（✨2通目が送った資料の読みを見ない＝旧） */
export function recommendVacatingSentImageOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.RECOMMEND_VACATING_SENT_IMAGE ?? "").trim().toLowerCase() !== "off";
}

const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const roomKey = (s: string) => s.normalize("NFKC").replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/** property_pickups を号室の形をそろえて引く（DB の room_no が「0201」「201号室」でも当たる）。pickupForFirstMessage と同じ当て方 */
export function pickupForHeadLoose<T extends PickupLookupRow>(rows: ReadonlyArray<T>, head: { name: string; room: string } | null): T | null {
  return pickupForFirstMessage(rows, head) as T | null;
}

export type SipRow = { property_name?: string | null; room_no?: string | null; created_at?: string | null; facts?: Record<string, unknown> | null };
export type SipVacating = { status: string; notViewable: boolean; vacancyDate: string | null };

/**
 * 送った資料の画像の読み（sent_image_properties）から、1通目の物件（号室が一致・建物名の頭6字が互いに含まれる）の現況を読む。
 * 新しい行を優先。現況が読めない行（status なし）は飛ばす。当たらなければ null。
 *   move_out_planned・occupied → まだご内覧頂けない（vacancy_date があれば日付）／open → 空室／under_construction 等 → null
 */
export function sipVacating(rows: ReadonlyArray<SipRow>, head: { name: string; room: string } | null): SipVacating | null {
  if (!head) return null;
  const hn = norm(head.name).slice(0, 6), hr = roomKey(head.room);
  if (!hn || !hr) return null;
  const hits = rows.filter((r) => {
    const rn = norm(String(r.property_name ?? ""));
    const rr = roomKey(String(r.room_no ?? (r.facts?.room_no as string | undefined) ?? ""));
    return rn && rr === hr && (rn.includes(hn) || norm(head.name).includes(rn.slice(0, 6))) && typeof r.facts?.status === "string";
  }).sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""));
  for (const r of hits) {
    const st = String(r.facts?.status);
    const vd = typeof r.facts?.vacancy_date === "string" && /^\d{1,2}月(?:\d{1,2}日|末|上旬|中旬|下旬)$/.test(String(r.facts.vacancy_date)) ? String(r.facts.vacancy_date) : null;
    if (st === "move_out_planned" || st === "occupied") return { status: st, notViewable: true, vacancyDate: vd };
    if (st === "open") return { status: st, notViewable: false, vacancyDate: null };
  }
  return null;
}

/**
 * 送った資料の読みから、✨2通目の「今ご内覧頂けるか」を作る（resolveRecommendViewable が本文・売上サポの行で決められず、ブレインに倒れる時だけ使う）。
 *   退去予定と読めた時だけ返す（空室と読めた時は返さない＝ブレインのまま。読みの「空室」で退去予定を消さない: 竹内さんが退去予定と書いた番に open の読みが 3/66 あった）。
 *   退去予定日があり今日より後 → 「◯月◯日退去予定のため、◯月◯日以降ご内覧可能となります！！」（売上サポの行と同じ形）
 *   退去予定日が過ぎていた → null（もう見られる・決めない）／日付なし → 「退去予定のお部屋となります！！」
 *   出口で一文を足す（ensureVacatingLine）のは売上サポの行の時だけ。ここは材料に渡すだけ（書くかは生成が決める）
 */
export function sentImageViewable(sip: SipVacating | null, nowMs: number = Date.now()): RecommendViewable | null {
  if (!sip || !sip.notViewable) return null;
  if (sip.vacancyDate) {
    const st = readPropertyStateFromText(`${sip.vacancyDate}退去予定`, nowMs);
    if (st.vacancyDate && st.viewableFrom) {
      if (!st.notViewable) return null;
      return { notViewable: true, viewableFrom: st.viewableFrom, line: `${st.vacancyDate}退去予定のため、${st.viewableFrom}以降ご内覧可能となります！！`, source: "sent_image" };
    }
  }
  return { notViewable: true, viewableFrom: null, line: VACATING_NO_DATE_LINE, source: "sent_image" };
}
