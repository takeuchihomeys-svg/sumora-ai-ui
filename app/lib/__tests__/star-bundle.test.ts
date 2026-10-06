// 2026-10-06 竹内さん「なおす」: 🌟が新着1件か束の中の🌟かを見分け、その時の束の候補を記録に残す（star-bundle.ts）のテスト
// 実行: npx tsx app/lib/__tests__/star-bundle.test.ts
// 形は本番の記録（#2268 SUNREGIS NAMBA: 🌟の前にスタッフの画像3枚・★物件出し★グループに8分前に届いた行・売上サポの回）。お客様の情報は無い
import { starBundleOf, STAR_BUNDLE_RULE } from "../star-bundle";
import { isNewArrivalSnapshot } from "../hooked-arrival-learning";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}
const T = "2026-09-28T04:36:43Z";
const at = (min: number) => new Date(Date.parse(T) + min * 60_000).toISOString();

console.log("■ 束（スタッフの画像が3枚以上）");
{
  const b = starBundleOf({
    sentAt: T, starName: "SUNREGIS NAMBA", starRoom: "201", starText: "🌟SUNREGIS NAMBA 201号室\n2LDK…",
    msgs: [
      { sender: "staff", text: "❤︎さん お世話になっております。", created_at: at(-10) },
      { sender: "staff", image_url: "https://x/1.jpg", created_at: at(-2) },
      { sender: "staff", image_url: "https://x/2.jpg", created_at: at(-2) },
      { sender: "staff", text: "浪速区・中央区全域から広めのリビングで…", created_at: at(-2) },
      { sender: "staff", image_url: "https://x/3.jpg", created_at: at(0) },
    ],
    customerSentAt: [T],
    pickups: [
      { id: 11, batch_id: "物件まとめ_A", created_at: at(-60 * 3), property_name: "ラクラス長堀橋", room_no: "501", complete_group_id: "G1" },
      { id: 12, batch_id: "物件まとめ_A", created_at: at(-60 * 3), property_name: "SUNREGIS NAMBA", room_no: "201", complete_group_id: "G1" },
      { id: 13, batch_id: "物件まとめ_B", created_at: at(-60 * 2), property_name: "Dimus北浜", room_no: "302", complete_group_id: "G1" },
      { id: 9, batch_id: "物件まとめ_OLD", created_at: at(-60 * 80), property_name: "古い回", room_no: "101", complete_group_id: "G0" },
    ],
    shared: [
      { property_name: "コンフォリア・リヴ博労町一丁目Q", room_no: "1001", sent_at: at(-8), pickup_id: null },
      { property_name: "スプランディッド本町グラン", room_no: "803", sent_at: at(-8), pickup_id: 13 },
      { property_name: "4日前の行", room_no: null, sent_at: at(-60 * 24 * 4), pickup_id: null },
    ],
  });
  t("束", b.kind === "bundle" && b.why.includes(`images>=${STAR_BUNDLE_RULE.images}`), b);
  t("スタッフの画像 3枚", b.staff_images === 3);
  t("束の回は🌟の部屋を含む回・同じまとめの行（72時間より前の回は入れない）", b.pickup_batch_id === "物件まとめ_A" && b.pickup_group_id === "G1" && JSON.stringify(b.pickup_ids) === "[11,12,13]" && b.star_pickup_id === 12, b);
  t("何時間前の回か", b.pickup_lag_h === 3);
  t("グループに届いた行（72時間以内・新しい順・売上サポの行の id 付き）", b.group_rows.length === 2 && b.group_rows.some((g) => g.pickup_id === 13) && !b.group_rows.some((g) => g.name === "4日前の行"), b.group_rows);
}

console.log("■ 新着1件");
{
  const b = starBundleOf({
    sentAt: T, starName: "ルーセントオーデン難波", starRoom: "206", starText: "🌟ルーセントオーデン難波 206号室\nワンルーム…",
    msgs: [{ sender: "staff", image_url: "https://x/9.jpg", created_at: at(0) }, { sender: "staff", text: "（室内イメージ） https://www.homes.co.jp/", created_at: at(0) }],
    customerSentAt: [at(-1)], pickups: [], shared: [],
  });
  t("画像1枚・候補1件 → 新着1件", b.kind === "single" && b.why[0] === "few_images" && b.pickup_batch_id === null && b.group_rows.length === 0, b);
}

console.log("■ 文で束（画像は前の時間に送っている）");
{
  const b = starBundleOf({
    sentAt: T, starName: "都ハイツ", starText: "🌟都ハイツ\nお送りさせて頂きましたお部屋の中でも特に…",
    msgs: [{ sender: "staff", image_url: "https://x/9.jpg", created_at: at(0) }], customerSentAt: [], pickups: [], shared: [],
  });
  t("「お送りさせて頂きましたお部屋の中でも」→ 束", b.kind === "bundle" && b.why.includes("bundle_text"), b);
}

console.log("■ お客様に届いた候補が2時間以内に2件以上 → 束");
{
  const b = starBundleOf({ sentAt: T, starName: "A", msgs: [], customerSentAt: [at(-30), at(-5), T], pickups: [], shared: [] });
  t("束（customer_sends>=2）", b.kind === "bundle" && b.customer_sends_2h === 3);
}

console.log("■ 会話が読めない → 分からない");
{
  const b = starBundleOf({ sentAt: T, starName: "A", msgs: null, customerSentAt: [T], pickups: [], shared: [] });
  t("unknown", b.kind === "unknown" && b.why.includes("no_messages"));
}

console.log("■ まとめが無い回は 6時間以内の回を同じ束に");
{
  const b = starBundleOf({ sentAt: T, starName: "Z", msgs: [], customerSentAt: [T], shared: [],
    pickups: [
      { id: 1, batch_id: "b1", created_at: at(-60), property_name: "X" },
      { id: 2, batch_id: "b0", created_at: at(-60 * 4), property_name: "Y" },
      { id: 3, batch_id: "bz", created_at: at(-60 * 20), property_name: "W" },
    ] });
  t("🌟が無い時は一番新しい回 → 6時間以内の回も", b.pickup_batch_id === "b1" && JSON.stringify(b.pickup_ids) === "[1,2]" && b.star_pickup_id === null, b);
}

console.log("■ 新着1件の見分け（isNewArrivalSnapshot）が star_kind を使う");
{
  t("star_kind=bundle は候補1件でも新着1件でない", !isNewArrivalSnapshot({ star_name: "A", candidate_count: 1, star_kind: "bundle" }));
  t("star_kind=single は新着1件", isNewArrivalSnapshot({ star_name: "A", candidate_count: 5, star_kind: "single", star_text: "🌟A\n今回お送りした中でも" }));
  t("star_kind が無い過去の行は今まで通り", isNewArrivalSnapshot({ star_name: "A", candidate_count: 1 }) && !isNewArrivalSnapshot({ star_name: "A", candidate_count: 5, star_text: "🌟A\nx" }));
}

console.log(`\n${passed} OK / ${failed} NG`);
if (failed) process.exit(1);
