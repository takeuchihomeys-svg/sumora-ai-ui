/**
 * Phase 3 修正の検証:
 *   1. human-learn.js の mergeAggregate が opens / open_kinds を捨てずに合算すること
 *   2. noteBeforeClick / noteOpened が連続クリックでも競合せず、<select> を options と判定すること
 *   3. learnOpens が shot_ops[].opened（none 以外）からも実測回収できること
 *   4. sceneOfOp が ITANDI の実在欄名を正しく分類し other に落とさないこと
 * 実行: npx tsx app/lib/__tests__/learn-opens-and-itandi-flow.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { learnOpens } from "../human-learn-brain";
import { sceneOfOp } from "../learn-flow-steps";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail === undefined ? "" : "\n      " + JSON.stringify(detail))); }
}

console.log("■ 1. human-learn.js の mergeAggregate が opens / open_kinds を引き継ぐ");
{
  const hlCode = fs.readFileSync(path.join(process.cwd(), "chrome-extension", "human-learn.js"), "utf8");
  const sandbox: Record<string, unknown> = {
    window: undefined,
    document: undefined,
    console,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(hlCode, sandbox);
  const L = (sandbox.window as { AxlxHumanLearn: {
    mergeAggregate: (a: Record<string, unknown>, b: Record<string, unknown>) => Record<string, unknown>;
    create: (opts?: Record<string, unknown>) => {
      noteBeforeClick: (el: unknown) => void;
      noteOpened: (el: unknown) => void;
      detail: () => { opens: Array<{ f: string; o: string; s: string; n: number }> };
    };
  } }).AxlxHumanLearn;

  const prev = {
    v: 1, n: 2, sessions: 1, kinds: { click: 2 }, gaps: [500], fields: ["rental_cost2"], order: ["rental_cost2"],
    opens: {
      rental_cost2: { opens: "options", n: 1, stage: "form", all: { options: 1 } },
      "左の所在地絞り込み＋｜span": { opens: "modal", n: 2, stage: "form", all: { modal: 2 } },
    },
    open_kinds: { options: 1, modal: 2 },
  };
  const add = {
    v: 1, n: 3, kinds: { click: 3 }, gaps: [600], fields: ["update_date"], order: ["update_date"],
    opens: {
      rental_cost2: { opens: "options", n: 2, stage: "form", all: { options: 2 } },
      update_date: { opens: "options", n: 1, stage: "form", all: { options: 1 } },
    },
    open_kinds: { options: 3 },
  };
  const merged = L.mergeAggregate(prev, add) as {
    opens: Record<string, { opens: string; n: number; all: Record<string, number> }>;
    open_kinds: Record<string, number>;
  };
  ok("rental_cost2 の opens 回数が合算される (1+2=3)", merged.opens?.rental_cost2?.n === 3 && merged.opens?.rental_cost2?.opens === "options", merged.opens);
  ok("前セッションの所在地ボタンの opens も残る", merged.opens?.["左の所在地絞り込み＋｜span"]?.n === 2, merged.opens);
  ok("新セッションの update_date も追加される", merged.opens?.update_date?.opens === "options", merged.opens);
  ok("open_kinds が合算される (options=4, modal=2)", merged.open_kinds?.options === 4 && merged.open_kinds?.modal === 2, merged.open_kinds);

  // <select> 連続クリックでも取りこぼさず options として記録されるか
  const selA = { tagName: "SELECT", getAttribute: (k: string) => (k === "name" ? "rental_cost2" : null) };
  const selB = { tagName: "SELECT", getAttribute: (k: string) => (k === "name" ? "update_date" : null) };
  const btnC = { tagName: "SPAN", getAttribute: () => null, textContent: "検索" };
  const fakeDoc = {
    querySelectorAll: () => [],
    body: { textContent: "" },
    location: { href: "https://example.test/form" },
  };
  const rec = L.create({ doc: fakeDoc, win: {} });
  rec.noteBeforeClick(selA);
  rec.noteBeforeClick(selB);
  rec.noteBeforeClick(btnC);
  rec.noteOpened(selA);
  rec.noteOpened(selB);
  rec.noteOpened(btnC);
  const opsOpens = rec.detail().opens;
  ok(
    "連続クリックでも 3件全部の opens が消えずに残り <select> は options になる",
    opsOpens.length === 3
      && opsOpens[0].f === "rental_cost2" && opsOpens[0].o === "options"
      && opsOpens[1].f === "update_date" && opsOpens[1].o === "options"
      && opsOpens[2].o === "none",
    opsOpens,
  );
}

console.log("■ 2. learnOpens が row.opens 無し行の shot_ops[].opened も実測回収する");
{
  const out = learnOpens([
    {
      // opens 列が空（mergeAggregate バグ時代の DB 行）
      shot_ops: [
        { k: "click", f: "左の路線・駅で絞り込み", opened: "modal" },
        { k: "click", f: "rental_cost2", opened: "options" },
        { k: "click", f: "rental_cost2", opened: "none" },
        { k: "click", f: "検索", opened: "none" },
      ],
    },
    {
      // row.opens がある時は row.opens を優先して重複計上しない
      opens: { rental_cost2: { opens: "options", n: 2 } },
      shot_ops: [{ k: "click", f: "rental_cost2", opened: "options" }],
    },
  ]);
  ok("shot_ops[].opened=modal を回収", out["左の路線・駅で絞り込み"]?.opens === "modal" && out["左の路線・駅で絞り込み"]?.n === 1, out);
  ok("shot_ops(1) + row.opens(2) = 3（row.opens がある行は二重計上しない）", out.rental_cost2?.opens === "options" && out.rental_cost2?.n === 3, out);
  ok("opened=none のみは拾わない", !out["検索"], out);
}

console.log("■ 3. sceneOfOp が ITANDI の実在欄を正しく場面分類する");
{
  const cases: Array<[string, string]> = [
    ["click:リスト検索", "search"],
    ["click:左のリスト検索｜button", "search"],
    ["click:路線・駅選択", "station"],
    ["click:都道府県・駅選択", "station"],
    ["click:左の路線・駅で絞り込み", "station"],
    ["click:左の所在地で絞り込み", "area"],
    ["click:小窓の確定", "area"],
    ["change:rent:lteq", "cond"],
    ["change:rent:gteq", "cond"],
    ["change:building_name:match", "cond"],
    ["change:keyword", "cond"],
    ["change:floor_area_amount:gteq", "cond"],
    ["change:building_age:lteq", "cond"],
    ["change:structure_type:in", "cond"],
    ["change:option_id:all_in", "cond"],
    ["change:offer_conditions_updated_at:gteq", "cond"],
    ["click:敷金なし", "cond"],
    ["click:礼金なし", "cond"],
    ["click:物件資料", "list"],
    ["click:募集中物確不要", "list"],
    ["click:BaseGridListRow", "list"],
    ["click:DetailContainer", "list"],
  ];
  for (const [op, want] of cases) {
    const got = sceneOfOp(op);
    ok(`${op} -> ${want} (実際: ${got})`, got === want, { op, got, want });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
