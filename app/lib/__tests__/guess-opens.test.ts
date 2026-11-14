// 「押したら何が開くか」を名前から推す（2026-11-14）
//   opens 列は v2.7.32 以降の記録にしか入らない。それ以前の記録でも
//   名前から分かる物は使えるようにする（実測がある欄は実測を優先）。
// 実行: npx tsx app/lib/__tests__/guess-opens.test.ts
import { guessOpensFromName, withGuessedOpens } from "../human-learn-brain";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 本番DBに実際に入っている名前で当たる");
{
  ok("「左の所在地絞り込み＋｜span」→ 小窓が開く", guessOpensFromName("左の所在地絞り込み＋｜span") === "modal", guessOpensFromName("左の所在地絞り込み＋｜span"));
  ok("「左の沿線・駅絞り込み＋｜span」→ 小窓が開く", guessOpensFromName("左の沿線・駅絞り込み＋｜span") === "modal");
  ok("「確定してリストへ｜span」→ 小窓が閉じる", guessOpensFromName("確定してリストへ｜span") === "modal_close");
  ok("「左の検索｜span」→ 結果に変わる", guessOpensFromName("左の検索｜span") === "result", guessOpensFromName("左の検索｜span"));
  ok("「rental_cost2」→ 一覧が開く", guessOpensFromName("rental_cost2") === "options");
  ok("「square_meter_l」→ 一覧が開く", guessOpensFromName("square_meter_l") === "options");
  ok("「駅の設定へ進む｜span」→ 中の画面が変わる", guessOpensFromName("駅の設定へ進む｜span") === "form");
}

console.log("\n■ ② 学んではいけない物は推さない");
{
  ok("自分のUI（AIXLINX）は推さない", guessOpensFromName("左のAIXLINX｜div") === null);
  ok("自分のUI（#aixlinx-mini-btn）は推さない", guessOpensFromName("#aixlinx-mini-btn") === null);
  ok("入れ物（div）は推さない", guessOpensFromName("div") === null);
  ok("空は推さない", guessOpensFromName("") === null);
  ok("関係ない名前は推さない", guessOpensFromName("左の3K｜label") === null);
}

console.log("\n■ ③ 実測があれば推測で上書きしない");
{
  const learned = { "左の検索｜span": { opens: "modal", n: 5, stage: "form" } };
  const out = withGuessedOpens(learned, ["左の検索｜span", "rental_cost2"]);
  ok("実測を残す（推測しない）", out["左の検索｜span"].opens === "modal" && out["左の検索｜span"].n === 5);
  ok("  実測には guessed を付けない", !out["左の検索｜span"].guessed);
  ok("実測が無い欄だけ推測する", out["rental_cost2"].opens === "options" && out["rental_cost2"].guessed === true);
  ok("  推測は n=0（実測ではないと分かる）", out["rental_cost2"].n === 0);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
