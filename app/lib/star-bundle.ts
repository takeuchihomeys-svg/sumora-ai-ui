// app/lib/star-bundle.ts（純関数・DB/LLM なし）
// 🌟（AIX 物件オススメ）が「新着1件」か「束（ピックアップで何件も送った中）の🌟」かを見分け、その時の束の候補を記録に残す形にする。
//
// 2026-10-06 竹内さん「なおす」（質問2: 「新着1件」とされた🌟の記録の 57%＝297/523 は実は束の中の🌟で、候補が記録されていない）:
//   原因（scripts/audit-star-bundle-link.ts で記録を目で読んだ）:
//     ・🌟の記録の候補は「お客様に届いた送付の記録（sent_properties の delivery=customer）」だけから作っている
//     ・束はスタッフが ★物件出し★グループに届いた画像（拡張→グループ＝sent_properties の delivery=shared・channel=extension_group）を
//       LINE の画面から手で転送していて、その画像は物件に読み直されない（送付の記録に残らない）＝🌟の画像1枚だけが候補になる
//     ・売上サポの行（property_pickups）は status=pending のまま（送ったかの印が付かない）
//   → 🌟の記録に「束の見分け（star_kind）」と「その時の束の候補（売上サポの行の id・グループに届いた行）」を別の列に残す。
//     候補（candidates）の作り方は変えない（学習・監査の物差しを黙って変えない）。新着1件の見分け（hooked-arrival-learning.isNewArrivalSnapshot）は
//     star_kind がある行だけそれを使う（無い過去の行は今まで通り・過去の分は監査スクリプトで結ぶ）
//
// ■ 決め方（starBundleOf）
//   束（bundle）: 🌟の前 20分〜後 5分にスタッフの画像が 3枚以上（🌟の画像を含む・new-arrival-hook.HOOK_V2_RULE と同じ線）／
//                 お客様に届いた候補が 2時間以内に 2件以上／🌟の本文・前後のスタッフの文が「お送りさせて頂いたお部屋の中でも」「全てピックアップ」
//   新着1件（single）: 上のどれでもなく、スタッフの画像が 2枚以下
//   分からない（unknown）: 会話の文が読めない時
//   束の候補: 🌟の 72時間前〜1分後の売上サポの行のうち、🌟の部屋を含む一番新しい回（batch）→ 無ければ一番新しい回。
//             同じまとめ（complete_group_id）の行をまとめて残す（まとめが無ければ同じお客様の 6時間以内の回）。何時間前の回かも残す（pickup_lag_h）
//             グループに届いた行（delivery=shared）は 🌟の 72時間前〜🌟まで（送った時刻付き）
//   ※ 束はグループの画像を前の日に転送する事もある（#2277: グループ 30時間前・🌟の部屋は束の回に無い）ので窓は 72時間
import { HOOK_V2_RULE } from "./new-arrival-hook";
import { bestBuildingMatch } from "./candidate-facts";

export type StarKind = "bundle" | "single" | "unknown";

export type StarBundleMsg = { sender?: string | null; image_url?: string | null; text?: string | null; created_at: string };
export type StarBundlePickup = { id: number; batch_id: string; created_at: string; property_name?: string | null; room_no?: string | null; status?: string | null; complete_group_id?: string | null };
export type StarBundleShared = { property_name?: string | null; room_no?: string | null; sent_at: string; pickup_id?: number | null };

export type StarBundle = {
  kind: StarKind;
  /** 決めた理由（images>=3・customer_sends>=2・bundle_text・few_images・no_messages） */
  why: string[];
  /** 🌟の前 20分〜後 5分のスタッフの画像の数（🌟の画像を含む） */
  staff_images: number;
  /** お客様に届いた候補で🌟の 2時間以内に送った物の数（🌟を含む） */
  customer_sends_2h: number;
  /** 束の売上サポの回（property_pickups.batch_id）と、同じまとめ（complete_group_id・無ければ同じお客様の 6時間以内の回）の行の id・🌟の行の id */
  pickup_batch_id: string | null;
  pickup_group_id: string | null;
  /** 束の回が🌟の何時間前か（古い回ほど別の探し物の可能性・使う側で線を引く） */
  pickup_lag_h: number | null;
  pickup_ids: number[];
  star_pickup_id: number | null;
  /** ★物件出し★グループに届いた行（🌟の 24時間前〜）。名前・号室・売上サポの行の id */
  group_rows: Array<{ name: string; room: string | null; pickup_id: number | null; sent_at: string }>;
  v: number;
};

export const STAR_BUNDLE_RULE = {
  images: HOOK_V2_RULE.bundleImages,
  beforeMin: HOOK_V2_RULE.bundleBeforeMin,
  afterMin: 5,
  sessionHours: 2,
  pickupHours: 72,
  pickupFallbackHours: 72,
  /** まとめが無い回は、同じお客様の 6時間以内の回を1つの束とみなす（pickup-best の窓と同じ） */
  roundHours: 6,
  groupHours: 72,
  maxGroupRows: 40,
};
export const STAR_BUNDLE_V = 1;

const BUNDLE_TEXT_RE = /全て(?:の)?(?:お部屋)?ピックアップ|全域から|(?:物件|お部屋)?ピックアップ(?:し)?(?:させて頂きました|させていただきました|しお送り)|お送り(?:させ)?て?頂(?:い|き)?た(?:お部屋|物件)の中|お送りさせて頂きましたお部屋の中/;

/**
 * 🌟1回の束の見分けと束の候補。msgs は同じ会話のスタッフ・お客様の文（🌟の前後だけでよい）。
 *   customerSentAt はお客様に届いた候補の送った時刻（🌟の記録の candidates の sent_at）
 */
export function starBundleOf(input: {
  sentAt: string; starName: string; starRoom?: string | null; starText?: string | null;
  msgs: readonly StarBundleMsg[] | null; customerSentAt: readonly (string | null | undefined)[];
  pickups: readonly StarBundlePickup[]; shared: readonly StarBundleShared[];
}, R = STAR_BUNDLE_RULE): StarBundle {
  const t = Date.parse(input.sentAt);
  const why: string[] = [];
  const msgs = input.msgs;
  const near = (msgs ?? []).filter((m) => m.sender !== "customer" && Date.parse(m.created_at) >= t - R.beforeMin * 60_000 && Date.parse(m.created_at) <= t + R.afterMin * 60_000);
  const staffImages = near.filter((m) => !!m.image_url || /^\s*\[画像\]\s*$/.test(String(m.text ?? ""))).length;
  const sends2h = input.customerSentAt.map((s) => Date.parse(String(s ?? ""))).filter((x) => Number.isFinite(x) && Math.abs(t - x) <= R.sessionHours * 3600_000).length;
  const text = BUNDLE_TEXT_RE.test(String(input.starText ?? "")) || near.some((m) => BUNDLE_TEXT_RE.test(String(m.text ?? "")));
  if (staffImages >= R.images) why.push(`images>=${R.images}`);
  if (sends2h >= 2) why.push("customer_sends>=2");
  if (text) why.push("bundle_text");
  let kind: StarKind;
  if (why.length) kind = "bundle";
  else if (msgs == null) { kind = "unknown"; why.push("no_messages"); }
  else { kind = "single"; why.push("few_images"); }

  // 束の売上サポの回: 🌟の部屋を含む一番新しい回 → 無ければ 24時間以内の一番新しい回
  const inWin = input.pickups.filter((p) => { const d = t - Date.parse(p.created_at); return d >= -60_000 && d <= R.pickupHours * 3600_000; })
    .slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const starRow = bestBuildingMatch(input.starName, input.starRoom ?? null, inWin, (p) => p.property_name ?? "", (p) => p.room_no ?? null);
  let batch: string | null = starRow ? starRow.batch_id : null;
  if (!batch) {
    const fb = inWin.find((p) => t - Date.parse(p.created_at) <= R.pickupFallbackHours * 3600_000);
    batch = fb ? fb.batch_id : null;
  }
  const anchor = batch ? inWin.find((p) => p.batch_id === batch)! : null;
  const groupId = anchor?.complete_group_id ?? null;
  const batchRows = !anchor ? [] : groupId
    ? inWin.filter((p) => p.complete_group_id === groupId)
    : inWin.filter((p) => { const d = Date.parse(anchor.created_at) - Date.parse(p.created_at); return p.batch_id === batch || (d >= 0 && d <= R.roundHours * 3600_000); });
  const starInBatch = starRow && starRow.batch_id === batch ? starRow : bestBuildingMatch(input.starName, input.starRoom ?? null, batchRows, (p) => p.property_name ?? "", (p) => p.room_no ?? null);

  const group = input.shared
    .filter((s) => { const d = t - Date.parse(s.sent_at); return d >= 0 && d <= R.groupHours * 3600_000 && !!s.property_name; })
    .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))
    .slice(0, R.maxGroupRows)
    .map((s) => ({ name: String(s.property_name), room: s.room_no ? String(s.room_no) : null, pickup_id: s.pickup_id ?? null, sent_at: s.sent_at }));

  return {
    kind, why, staff_images: staffImages, customer_sends_2h: sends2h,
    pickup_batch_id: batch, pickup_group_id: groupId, pickup_lag_h: anchor ? Math.round(((t - Date.parse(anchor.created_at)) / 3600_000) * 10) / 10 : null, pickup_ids: batchRows.map((p) => p.id).sort((a, b) => a - b), star_pickup_id: starInBatch ? starInBatch.id : null,
    group_rows: group, v: STAR_BUNDLE_V,
  };
}
