// app/lib/__tests__/fill-done-match.test.ts
// Chrome 拡張の「fill-done は今待っている顧客のものか」の判定（chrome-extension/fill-done-match.js）。
// 2026-09-18 竹内「一括検索する際に情報ずれて、違うお客さんの条件で送られてしまっているバグ」の回帰テスト。
// 実行: npx tsx app/lib/__tests__/fill-done-match.test.ts
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
type Waiter = { site?: string | null; customerId?: string | null };
type Signal = { site?: string | null; customerId?: string | null };
const M = require_("../../../chrome-extension/fill-done-match.js") as {
  matchesWaiter(w: Waiter, s: Signal): boolean;
  selectWaiters(waiters: Waiter[], signal: Signal, abandoned?: Set<string>): { resolve: Waiter[]; reason: string };
};

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

const A: Waiter = { site: "realnetpro", customerId: "A" };
const B: Waiter = { site: "realnetpro", customerId: "B" };

console.log("── 同じ顧客のシグナルだけ通す");
{
  t("A の待ちは A のシグナルで解決", M.matchesWaiter(A, { site: "realnetpro", customerId: "A" }));
  t("A の待ちは B のシグナルで解決しない", !M.matchesWaiter(A, { site: "realnetpro", customerId: "B" }));
  t("サイトが違えば解決しない", !M.matchesWaiter(A, { site: "itandi", customerId: "A" }));
}

console.log("── 【本体のバグ】ID 無しのシグナルで別顧客の待ちを解決しない");
{
  // 旧実装はここで「最古の1件」を解決していた → 違うお客さんの条件で送られる
  t("ID 付きの待ちは、ID 無しのシグナルでは解決しない", !M.matchesWaiter(A, { site: "realnetpro" }));
  const r = M.selectWaiters([A, B], { site: "realnetpro" });
  t("ID 無しのシグナルは ID 付きの待ちを1つも解決しない", r.resolve.length === 0, JSON.stringify(r));
}

console.log("── 【本体のバグ】ID があっても素通りしない");
{
  // 旧実装: cidMatch = (w.customerId && customerId) ? 厳密 : true ＝片方 null で素通り
  const noIdWaiter: Waiter = { site: "reins", customerId: null };
  t("ID を持たない待ちは ID 無しのシグナルで解決してよい（旧経路・reins）",
    M.matchesWaiter(noIdWaiter, { site: "reins" }));
  t("ID を持たない待ちは ID 付きのシグナルでは解決しない（誰の分か分からないため）",
    !M.matchesWaiter(noIdWaiter, { site: "reins", customerId: "A" }));
}

console.log("── 【本体のバグ】タイムアウトで捨てた顧客の遅延シグナル");
{
  // 顧客Aの待ちがタイムアウト → 次の顧客Bを待っている所へ、Aの fill-done が遅れて届く
  const abandoned = new Set(["A"]);
  const r = M.selectWaiters([B], { site: "realnetpro", customerId: "A" }, abandoned);
  t("捨てた顧客のシグナルは何も解決しない", r.resolve.length === 0 && r.reason === "abandoned", JSON.stringify(r));

  const r2 = M.selectWaiters([B], { site: "realnetpro", customerId: "B" }, abandoned);
  t("捨てていない顧客のシグナルは通る", r2.resolve.length === 1 && r2.resolve[0] === B);
}

console.log("── 一括検索の並び（1人ずつ待つ）");
{
  const r = M.selectWaiters([A], { site: "realnetpro", customerId: "A" });
  t("待っている本人のシグナルで解決", r.resolve.length === 1 && r.reason === "matched");
  const r2 = M.selectWaiters([], { site: "realnetpro", customerId: "A" });
  t("誰も待っていなければ何もしない", r2.resolve.length === 0 && r2.reason === "no-match");
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
