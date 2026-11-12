// 材料の上限を「今の番に要る物」で決める（app/lib/material-turn-must.ts）のテスト
// 実行: npx tsx app/lib/__tests__/material-turn-must.test.ts
import { turnMustKeys, selectNewestWithMust, rowHitsKeys, materialTurnMustOn } from "../material-turn-must";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };

ok("既定 off", materialTurnMustOn({}) === false && materialTurnMustOn({ MATERIAL_TURN_MUST: "on" }) === true);
{
  const names = ["グラン寝屋川 101号室", "ALEGRIA枚方公園Ⅱ", "ジャンシアーヌ Ⅱ", "メゾン"];
  const k = turnMustKeys("前に送ってくれたALEGRIA枚方公園Ⅱってまだ空いてますか？", names);
  ok("お客様が名前で呼んだ物件の鍵", k.size === 1, JSON.stringify([...k]));
  ok("短すぎる名前（3字未満の鍵）は使わない", !turnMustKeys("メゾンがいい", ["メゾ"]).size);
  ok("名前が無い番は空", turnMustKeys("ありがとうございます", names).size === 0);
}
{
  const rows = Array.from({ length: 30 }, (_, i) => ({ name: i === 25 ? "ALEGRIA枚方公園Ⅱ" : `物件${i}` }));
  const keys = turnMustKeys("ALEGRIA枚方公園Ⅱの初期費用は？", rows.map((r) => r.name));
  const r = selectNewestWithMust(rows, 20, (x) => rowHitsKeys(x.name, keys));
  ok("新しい20件＋件数の外の今の番の物件1件", r.rows.length === 21 && r.beyondLimit === 1 && r.rows[20].name === "ALEGRIA枚方公園Ⅱ", JSON.stringify(r).slice(0, 200));
  const r0 = selectNewestWithMust(rows, 20, () => false);
  ok("今の番の物件が無ければ今と同じ（新しい20件）", r0.rows.length === 20 && r0.rows[19].name === "物件19");
}
ok("AIX の property_names の配列でも当たる", rowHitsKeys(["グラン寝屋川 101号室", "x"], turnMustKeys("グラン寝屋川はどうですか", ["グラン寝屋川"])));
console.log(`material-turn-must: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
