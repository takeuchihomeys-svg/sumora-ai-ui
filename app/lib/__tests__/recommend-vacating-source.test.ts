// 実行: npx tsx app/lib/__tests__/recommend-vacating-source.test.ts
// 2026-10-15 ✨2通目の退去予定の材料に、送った資料の画像の読み（sent_image_properties）を足す
import { sipVacating, sentImageViewable, recommendVacatingSentImageOn } from "../recommend-vacating-source";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`✗ ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};
const NOW = Date.parse("2026-09-10T03:00:00Z"); // JST 9/10 12:00
const head = { name: "H maison東住吉Ⅱ", room: "204" };
const rows = [
  { property_name: "H maison東住吉Ⅱ", room_no: "0204", created_at: "2026-09-10T02:00:00Z", facts: { status: "move_out_planned", vacancy_date: "9月30日" } },
  { property_name: "別の物件", room_no: "204", created_at: "2026-09-10T02:30:00Z", facts: { status: "open" } },
];

// 当て方: 号室の先頭の0・建物名の頭
eq("号室0付き・名前一致", sipVacating(rows, head), { status: "move_out_planned", notViewable: true, vacancyDate: "9月30日" });
eq("別の建物は当てない", sipVacating([rows[1]], head), null);
eq("見出しなし", sipVacating(rows, null), null);
eq("現況なしの行は飛ばす", sipVacating([{ ...rows[0], facts: { rent: 1 } }], head), null);
eq("新しい行が先（空室）", sipVacating([rows[0], { ...rows[0], created_at: "2026-09-10T02:50:00Z", facts: { status: "open" } }], head)?.status, "open");
eq("occupied も退去予定扱い", sipVacating([{ ...rows[0], facts: { status: "occupied" } }], head), { status: "occupied", notViewable: true, vacancyDate: null });
eq("日付の形でない vacancy_date は捨てる", sipVacating([{ ...rows[0], facts: { status: "move_out_planned", vacancy_date: "未定" } }], head)?.vacancyDate, null);

// 2026-10-15 確かめる人: 頭6字の一致でシリーズ名の別の建物に当たらない（second-material-saved-read と同じ当て方）
{
  const mv = { status: "move_out_planned", vacancy_date: "10月31日" };
  const sr = [
    { property_name: "スプランディッド本町グラン", room_no: "1309", created_at: "2026-09-10T02:00:00Z", facts: mv },
    { property_name: "エステムコート難波サウスプレイズⅥ", room_no: "607", created_at: "2026-09-10T02:00:00Z", facts: mv },
    { property_name: "アドバンス大阪セレーノ", room_no: "906", created_at: "2026-09-10T02:00:00Z", facts: mv },
    { property_name: "村上ハイツ301", room_no: "301", created_at: "2026-09-10T02:00:00Z", facts: mv },
  ];
  eq("シリーズ名が同じ別の建物には当てない", sipVacating(sr, { name: "スプランディッド堀江", room: "1309" }), null);
  eq("Ⅴ と Ⅵ（別の棟）には当てない", sipVacating(sr, { name: "エステムコート難波サウスプレイスⅤ", room: "607" }), null);
  eq("1字だけの読み違いは当てる", sipVacating(sr, { name: "アドバンス大阪セレーネ", room: "906" })?.status, "move_out_planned");
  eq("読みの名前に号室が付いた形は当てる", sipVacating(sr, { name: "村上ハイツ", room: "301" })?.status, "move_out_planned");
}

// 一文
eq("日付あり", sentImageViewable({ status: "move_out_planned", notViewable: true, vacancyDate: "9月30日" }, NOW),
  { notViewable: true, viewableFrom: "10月1日", line: "9月30日退去予定のため、10月1日以降ご内覧可能となります！！", source: "sent_image" });
eq("月末", sentImageViewable({ status: "move_out_planned", notViewable: true, vacancyDate: "9月末" }, NOW)?.line, "9月末退去予定のため、10月1日以降ご内覧可能となります！！");
eq("日付なし", sentImageViewable({ status: "occupied", notViewable: true, vacancyDate: null }, NOW)?.line, "退去予定のお部屋となります！！");
eq("退去日が過ぎた→決めない", sentImageViewable({ status: "move_out_planned", notViewable: true, vacancyDate: "9月5日" }, NOW), null);
eq("空室の読み→決めない（ブレインのまま）", sentImageViewable({ status: "open", notViewable: false, vacancyDate: null }, NOW), null);
eq("null", sentImageViewable(null, NOW), null);

eq("既定 on", recommendVacatingSentImageOn({}), true);
eq("off で旧", recommendVacatingSentImageOn({ RECOMMEND_VACATING_SENT_IMAGE: "off" }), false);

console.log(`recommend-vacating-source: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
