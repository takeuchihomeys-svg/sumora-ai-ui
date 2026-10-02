// app/lib/__tests__/rent-order.test.ts — 2026-10-02 ⑫: 家賃の下限＞上限の行を作らない（実行: npx tsx app/lib/__tests__/rent-order.test.ts）
import { rentOrderFix, withRentOrder } from "../rent-raise";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
// 実物 1191b1eb: 登録 50,000〜80,000 → 「家賃2万以下とかないでしょうか？」で上限だけ 20,000
const r1 = withRentOrder({ rent_min: 50000, rent_max: 80000 }, { rent_max: 20000 });
t("上限だけ下げて下限を下回る → 下限を外す（null をはっきり入れる）", r1.updates.rent_max === 20000 && "rent_min" in r1.updates && r1.updates.rent_min === null, JSON.stringify(r1));
t("下限だけ上げて上限を上回る → 上限を外す", JSON.stringify(rentOrderFix({ rent_min: 50000, rent_max: 60000 }, { rent_min: 90000 })?.updates) === JSON.stringify({ rent_max: null }));
t("両方が逆 → 入れ替える", JSON.stringify(rentOrderFix(null, { rent_min: 90000, rent_max: 70000 })?.updates) === JSON.stringify({ rent_min: 70000, rent_max: 90000 }));
t("正しい順は触らない", rentOrderFix({ rent_min: 50000, rent_max: 80000 }, { rent_max: 70000 }) === null);
t("家賃の更新が無い時は触らない", withRentOrder({ rent_min: 50000, rent_max: 80000 }, { floor_plan: "1K" }).note === null);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
