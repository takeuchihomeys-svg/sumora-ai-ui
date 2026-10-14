// app/lib/recommend-vacating-source.ts（純関数・DB なし）
// AIX【物件オススメ】の✨2通目の「退去予定」の材料の出どころを足す（2026-10-15 小さな直し）。
//   今の✨（aix-template-generate）は property_pickups の行（資料の現況 terms.moveIn）だけを見ていた。
//   出どころの数え（scripts/audit-recommend-vacating-source.ts）で、竹内さんが2通目に退去予定を書いた番の材料は
//   送った資料の画像の読み（sent_image_properties.facts.status＝move_out_planned・vacancy_date）にある事が多かった。
//   ここは「その会話の、1通目の物件に当たる送った資料の読み」を1つ選んで、退去予定か・退去予定日を返すだけ。書くかどうかはブレインと生成が決める。
import { pickupForFirstMessage, type PickupLookupRow } from "./recommend-cta";
import { readPropertyStateFromText } from "./property-send-state";
import { VACATING_NO_DATE_LINE, type RecommendViewable } from "./recommend-viewable";
import { normalizePropertyName } from "./property-name-match";

/** 戻す: RECOMMEND_VACATING_SENT_IMAGE=off（✨2通目が送った資料の読みを見ない＝旧） */
export function recommendVacatingSentImageOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.RECOMMEND_VACATING_SENT_IMAGE ?? "").trim().toLowerCase() !== "off";
}

const roomKey = (s: string) => s.normalize("NFKC").replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/** property_pickups を号室の形をそろえて引く（DB の room_no が「0201」「201号室」でも当たる）。pickupForFirstMessage と同じ当て方 */
export function pickupForHeadLoose<T extends PickupLookupRow>(rows: ReadonlyArray<T>, head: { name: string; room: string } | null): T | null {
  return pickupForFirstMessage(rows, head) as T | null;
}

export type SipRow = { property_name?: string | null; room_no?: string | null; created_at?: string | null; facts?: Record<string, unknown> | null };
export type SipVacating = { status: string; notViewable: boolean; vacancyDate: string | null };

// 2026-10-15 確かめる人: 建物の当て方を「頭6字が互いに含まれる」から建物の鍵の一致に（second-material-saved-read.ts の bfc16049 と同じ形）。
//   頭6字だとシリーズ名の別の建物（「スプランディッド堀江 1309」→「スプランディッド本町グラン 1309」）に当たり、別の部屋の退去予定を渡す。
//   両方が main に入ったら1つの関数にまとめる
const bkey = (s: string | null | undefined) => normalizePropertyName(String(s ?? "").normalize("NFKC").replace(/[〜~～]/g, ""));
const fold = (s: string) => s.normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");
/** 同じ長さで1字だけ違う（読み取りの取り違え「セレーネ/セレーノ」） */
const oneCharOff = (a: string, b: string) => {
  if (a.length !== b.length || a.length < 4) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
  return d === 1;
};
/** 2＝同じ建物（濁点違い・読みの名前に号室が付いた形・先頭の飾りを含む）／1＝同じ長さで1字だけの読み違い／0＝別の建物 */
export function sameBuildingTier(readName: string | null | undefined, headName: string, room: string): number {
  const k = bkey(readName), hk = bkey(headName), rk = roomKey(room);
  if (k.length < 2 || hk.length < 2) return 0;
  if (k === hk || fold(k) === fold(hk) || (rk !== "" && (k === hk + rk || hk === k + rk))
    || (Math.min(k.length, hk.length) >= 5 && (k.endsWith(hk) || hk.endsWith(k)))) return 2;
  return oneCharOff(k, hk) ? 1 : 0;
}

/**
 * 送った資料の画像の読み（sent_image_properties）から、1通目の物件（号室が一致・建物の鍵が一致）の現況を読む。
 * 同じ鍵の物を先に・その中で新しい行を優先。現況が読めない行（status なし）は飛ばす。当たらなければ null。
 *   move_out_planned・occupied → まだご内覧頂けない（vacancy_date があれば日付）／open → 空室／under_construction 等 → null
 *   古さの線（14日）は呼ぶ側（aix-template-generate の created_at の絞り）
 */
export function sipVacating(rows: ReadonlyArray<SipRow>, head: { name: string; room: string } | null): SipVacating | null {
  if (!head) return null;
  const hr = roomKey(head.room);
  if (bkey(head.name).length < 2 || !hr) return null;
  const hits = rows.map((r) => {
    const rr = roomKey(String(r.room_no ?? (r.facts?.room_no as string | undefined) ?? ""));
    return { r, t: rr === hr && typeof r.facts?.status === "string" ? sameBuildingTier(r.property_name, head.name, head.room) : 0 };
  }).filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t || Date.parse(b.r.created_at ?? "") - Date.parse(a.r.created_at ?? ""))
    .map((x) => x.r);
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
