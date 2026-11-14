// 学習の仕組み・ゴミデータ・統括の整理（2026-11-14）
//
// 竹内さん「学習の仕組みはどうなっているのか／ちゃんと動き理解した学習になっているのか／
//   ゴミデータが入らないようになっているか／学習は統括の部分が管轄して整理もできているのか／強化していく」
//
// 実測で見つけた事:
//   ・`by_mode` に AIX（自動）が0件 → **shouldLearn が自動モードで false** を返していた
//   ・`point_fields` 由来の学びに `div`/`img`/`td`/`svg`/`#axlx-bar` が **13件**混ざっていた
//   ・`next`（押す順番）に `div` と `img` が **2件**混ざっていた
//   ・交互クリック24件・同じ日の同じ並び64件（これらは既に除外/畳み済み）
//   ・統括に「ゴミをどうするか」の判断が無かった
//
// 実行: npx tsx app/lib/__tests__/learn-garbage-cleanup.test.ts
import { isLearnableName, planLearnFromWeak, learnSequenceFromShots } from "../shot-learn";
import { buildHumanLearnBundle, compactBundle, sequencesOf } from "../human-learn-brain";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(c: boolean, label: string) { if (!c) throw new Error(label); }

console.log("=== ① 押す対象でない入れ物を学習しない");
{
  for (const n of ["div", "img", "td", "span", "svg", "tr", "th", "table", "a", "li", "p", "#axlx-bar", "div.building_tr", "td.st_td"]) {
    it(`除く: ${n}`, () => eq(isLearnableName(n), false));
  }
  for (const n of ["rental_cost1", "required_time", "確定してリストへ｜span", "左の1K｜label", "左の検索｜span", "印刷用PDF｜span", "room_layout_id[]", "大阪市北区｜label.one_city"]) {
    it(`学習する: ${n}`, () => eq(isLearnableName(n), true));
  }
  it("空文字は学習しない", () => eq(isLearnableName(""), false));
  it("1文字は学習しない", () => eq(isLearnableName("x"), false));
  it("class に button があれば入れ物でも学習する", () => eq(isLearnableName("div.btn_search"), true));
}

console.log("=== ② 並び（sequencesOf）から入れ物が消える");
{
  const row = {
    created_at: new Date().toISOString(), site: "realpro", mode: "normal",
    shot_ops: [
      { f: "div", k: "click" }, { f: "rental_cost1", k: "click" }, { f: "img", k: "click" },
      { f: "rental_cost2", k: "click" }, { f: "td", k: "click" }, { f: "確定してリストへ｜span", k: "click" },
    ],
    point_fields: {},
  };
  const seqs = sequencesOf(row as never);
  it("並びが作れる", () => ok(seqs.length === 1, "seqs"));
  it("入れ物が消えている", () => eq(seqs[0].map((x) => x.f), ["rental_cost1", "rental_cost2", "確定してリストへ｜span"]));
}

console.log("=== ③ field_order（写真なし）からも入れ物が消える");
{
  const row = {
    created_at: new Date().toISOString(), site: "realpro", mode: "aix",
    field_order: ["div", "required_time", "img", "rental_cost2", "span"],
    point_fields: {},
  };
  const seqs = sequencesOf(row as never);
  it("順番が作れる", () => ok(seqs.length === 1, "seqs"));
  it("入れ物が消えている", () => eq(seqs[0].map((x) => x.f), ["required_time", "rental_cost2"]));
}

console.log("=== ④ 一連の動きの型からも入れ物が消える");
{
  const seqs = [
    [{ f: "div" }, { f: "required_time" }, { f: "img" }, { f: "rental_cost2" }, { f: "rental_cost1" }],
    [{ f: "div" }, { f: "required_time" }, { f: "img" }, { f: "rental_cost2" }, { f: "rental_cost1" }],
  ];
  const r = learnSequenceFromShots(seqs as never, { min: 2 });
  eq(r.sequence, ["required_time", "rental_cost2", "rental_cost1"]);
  ok(!r.sequence.includes("div") && !r.sequence.includes("img"), "入れ物が残っている");
}

console.log("=== ⑤ 統括が「ゴミをどうするか」を判断する（cleanup）");
{
  it("交互クリックは『除いています』", () => {
    const p = planLearnFromWeak([], [], {}, [{ kind: "交互クリック（トグル跡）", n: 24 }]);
    ok(p.cleanup.length === 1, "cleanup");
    ok(p.cleanup[0].verdict.includes("除いています"), p.cleanup[0].verdict);
  });
  it("入れ物は『除きました（v2.7.28）』", () => {
    const p = planLearnFromWeak([], [], {}, [{ kind: "押す対象でない入れ物", n: 13 }]);
    ok(p.cleanup[0].verdict.includes("除きました"), p.cleanup[0].verdict);
  });
  it("水増しは『畳んでいます』", () => {
    const p = planLearnFromWeak([], [], {}, [{ kind: "同じ日の同じ並び（水増し）", n: 64 }]);
    ok(p.cleanup[0].verdict.includes("畳んでいます"), p.cleanup[0].verdict);
  });
  it("知らないゴミは『要確認』", () => {
    const p = planLearnFromWeak([], [], {}, [{ kind: "謎のゴミ", n: 1 }]);
    eq(p.cleanup[0].verdict, "要確認");
  });
  it("件数の多い順に並ぶ", () => {
    const p = planLearnFromWeak([], [], {}, [{ kind: "謎のゴミ", n: 1 }, { kind: "交互クリック（トグル跡）", n: 24 }]);
    eq(p.cleanup[0].n, 24);
  });
  it("まとめに整理の件数が入る", () => {
    const p = planLearnFromWeak([], [], {}, [{ kind: "交互クリック（トグル跡）", n: 24 }]);
    ok(p.summary.includes("整理:"), p.summary);
  });
  it("ゴミが無ければ cleanup は空", () => {
    const p = planLearnFromWeak([], [], {}, []);
    eq(p.cleanup.length, 0);
  });
}

console.log("=== ⑥ 学習の束に cleanup が入り、人が読める行になる");
{
  const mk = (dayOffset: number) => ({
    created_at: new Date(Date.now() - dayOffset * 86400_000).toISOString(),
    site: "realpro", mode: "normal",
    shot_ops: [
      { f: "div", k: "click" }, { f: "rental_cost1", k: "click" }, { f: "img", k: "click" },
      { f: "rental_cost2", k: "click" }, { f: "determine", k: "click" },
    ],
    point_fields: {
      div: { x: 0.5, y: 0.5, n: 2, w: "other" },
      rental_cost1: { x: 0.5, y: 0.5, n: 2, w: "select" },
      img: { x: 0.5, y: 0.5, n: 2, w: "other" },
    },
  });
  const b = compactBundle(buildHumanLearnBundle([mk(0), mk(1), mk(2)] as never));
  it("学んだ欄に入れ物が無い", () => {
    const pt = b.points as Record<string, unknown>;
    ok(!("div" in pt) && !("img" in pt), Object.keys(pt).join(","));
  });
  it("押す順番に入れ物が無い", () => {
    ok(!("div" in b.next) && !("img" in b.next), Object.keys(b.next).join(","));
  });
  it("cleanup が統括に入る", () => {
    ok(!!b.learn_plan, "learn_plan が無い");
    ok(Array.isArray(b.learn_plan!.cleanup), "cleanup が無い");
  });
  it("人が読める行に「ゴミの整理」が出る", () => {
    const s = b.lines.join("\n");
    ok(/▼ ゴミの整理/.test(s), "見出しが無い");
  });
}

console.log(`\n結果: 合格 ${passed} / 不合格 ${failed}`);
if (failed) { for (const f of failures) console.log("  ✗ " + f); process.exit(1); }
