// 2026-11-15 竹内さん「画像データベースの保存されている／そのこともちゃんと統括は把握する」
//   shot_in_db／行内b64空でも「未保存」と言わず、Storage（shot_key）を正とする。
import { superviseLearn } from "../learn-supervisor";

function ok(name: string, cond: boolean) {
  if (!cond) throw new Error("FAIL: " + name);
  console.log("  OK", name);
}

console.log("■ 統括は写真の Storage 保存を把握する");

const adv = superviseLearn({
  rows: 100,
  next: 10,
  points: 10,
  opens: 5,
  screens: 2,
  sequence: 5,
  gap_ms: 500,
  weak: [],
  mode_counts: { normal: 80 },
  site_counts: { realpro: 100 },
  with_ops: 60,
  shot_rows: 95,
  shot_bytes: {
    n: 95,
    total_bytes: 0,
    max_bytes: 0,
    in_storage: 95,
    in_row_b64: 0,
    large: 40,
  },
});

const photo = (adv.meeting?.evidence || []).find((e) => e.label === "写真");
ok("根拠に写真がある", !!photo);
ok("Storage保存と書く", !!(photo && /Storage保存/.test(photo.value)));
ok("shot_keyあり＝保存済みと書く", !!(photo && /shot_keyあり＝保存済み/.test(photo.value)));
ok("行内b64は別数", !!(photo && /行内b64 0枚/.test(photo.value)));
ok("大きい写真も出す", !!(photo && /大きい写真 40枚/.test(photo.value)));
ok("合計0MBだけで未保存に見えない", !!(photo && !/^0枚/.test(photo.value)));

console.log("\n統括の生の根拠（写真）:");
console.log("  ", photo?.value);

console.log("\nすべて合格");
