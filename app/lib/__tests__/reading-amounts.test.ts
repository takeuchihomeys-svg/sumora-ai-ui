// 2026-10-14 竹内さん「金額の読み取りを実データで測る…取り違えを直す」— reading-amounts.ts（敷金・礼金の「万」の読み違い）
// 実行: npx tsx app/lib/__tests__/reading-amounts.test.ts
import { checkReadAmounts, compareReadAmounts } from "../reading-amounts";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}
console.log("■ 実例（送った画像の読み取り × 売上サポの資料）");
const a = checkReadAmounts({ rent: 66000, key_money_yen: 20 }, {});
t("礼金 20 → 200,000（パレーシャル難波・資料 200,000）", a.facts.key_money_yen === 200000, a);
const b = checkReadAmounts({ rent: 60000, key_money_months: 5.5 }, {});
t("礼金 5.5（ヶ月）→ 55,000円（プレミアム新福島・資料 55,000）", b.facts.key_money_yen === 55000 && b.facts.key_money_months === undefined, b);
const c = checkReadAmounts({ rent: 60000, deposit_months: 2 }, {});
t("2（ヶ月）は触らない（2ヶ月と2万円を見分けられない）", c.facts.deposit_months === 2 && !c.changes.length, c);
const d = checkReadAmounts({ rent: 60000, deposit_months: 1, key_money_months: 1 }, {});
t("普通の月数はそのまま", !d.changes.length);
const e = checkReadAmounts({ key_money_yen: 20 }, {});
t("賃料が無ければ触らない", e.facts.key_money_yen === 20 && !e.changes.length);
const f = checkReadAmounts({ rent: 50000, key_money_yen: 900 }, {});
t("直すと賃料の6倍を超える（900万）は触らない", f.facts.key_money_yen === 900, f);
t("戻す READ_AMOUNT_GUARD=off", checkReadAmounts({ rent: 66000, key_money_yen: 20 }, { READ_AMOUNT_GUARD: "off" }).facts.key_money_yen === 20);
console.log("■ 見張りの比べ方");
const cmp = compareReadAmounts({ rent: 75000, admin_fee_yen: 4000, deposit_months: 1, key_money_yen: 150000 }, { rent: 78000, admin: 4000, depM: 1, keyM: 1, depY: null, keyY: null });
t("賃料の誤り・管理費 正・敷金 正・礼金（円→月数）", cmp.rent === "bad" && cmp.admin === "ok" && cmp.deposit === "ok" && cmp.key === "bad", cmp);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
