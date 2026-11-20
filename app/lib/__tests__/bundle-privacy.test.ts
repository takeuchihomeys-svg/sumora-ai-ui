// 2026-11-20: 束からお客様の名前らしい文字列を外す（純関数）。DB も LLM も使わない。
// 実行: npx tsx app/lib/__tests__/bundle-privacy.test.ts
import { stripCustomerNameText, stripCustomerNames } from "../bundle-privacy";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

console.log("■ 文字列から名前を外す（段階名は残す）");
{
  ok("今の客:fill_start 平田敏也 → 今の客:fill_start", stripCustomerNameText("今の客:fill_start 平田敏也") === "今の客:fill_start");
  ok("段階名だけの物は変えない", stripCustomerNameText("今の客:fill_done_gap") === "今の客:fill_done_gap");
  ok("名前が無い普通の欄名は変えない", stripCustomerNameText("city_code[]") === "city_code[]" && stripCustomerNameText("大阪市西区") === "大阪市西区");
}

console.log("■ 束の形（キーと値の両方・件数は足す）");
{
  const bundle = {
    next: {
      "今の客:fill_start 平田敏也": { n: 7, next: "今の客:fill_start 平田敏也", total: 24 },
      "今の客:fill_start 田中一郎": { n: 3, next: "今の客:fill_start 田中一郎", total: 5 },
      id: { n: 2, next: "pass", total: 2 },
    },
    scene_flows: [{ scene: "area", runs: 6, steps: ["所在地絞り込み＋", "city_code[]"] }],
  };
  const r = stripCustomerNames(bundle);
  const keys = Object.keys(r.value.next);
  ok("名前の違うキーは同じ段階名に畳まれる", keys.length === 2 && keys.includes("今の客:fill_start") && keys.includes("id"), keys.join(","));
  const merged = (r.value.next as Record<string, { n: number; total: number; next: string }>)["今の客:fill_start"];
  ok("畳んだ件数は足す（学びを減らさない）", merged.n === 10 && merged.total === 29, JSON.stringify(merged));
  ok("値の中の名前も外れる", merged.next === "今の客:fill_start", merged.next);
  ok("名前を外したと分かる（changed）", r.changed === true);
  ok("名前の無い部分（scene_flows）は変えない", JSON.stringify(r.value.scene_flows) === JSON.stringify(bundle.scene_flows));
  ok("入力の束は書き換えない（純関数）", Object.keys(bundle.next).includes("今の客:fill_start 平田敏也"));
}

console.log("■ 名前が無いと changed は false");
{
  const r = stripCustomerNames({ next: { pass: { n: 2 } }, x: 1 });
  ok("名前が無ければ changed=false・値はそのまま", r.changed === false && JSON.stringify(r.value) === JSON.stringify({ next: { pass: { n: 2 } }, x: 1 }));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
