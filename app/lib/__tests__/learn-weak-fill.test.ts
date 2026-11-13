// 弱い所を「名前から埋める」＋「統括が次の学習を決める」の試験（2026-11-13）
//
// 竹内さん「ちゃんと写真から学習できるように今弱い部分学習する。今のデータから学習する。
//   学習の統括が強化されるように、その点も徹底する」
//
// 実測: 弱い所 **40件がすべて kind_unknown**（押した記録に種類が無い・旧版の記録）。
//   写真が無いので今まで埋められなかった。
//
// 実行: npx tsx app/lib/__tests__/learn-weak-fill.test.ts
import { guessKindFromName, planLearnFromWeak, findWeakPoints } from "../shot-learn";
import { buildHumanLearnBundle, compactBundle } from "../human-learn-brain";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(c: boolean, label: string) { if (!c) throw new Error(label); }

console.log("=== ① 名前から種類を推す（実測の40件の名前で）");
{
  const want: Array<[string, string]> = [
    // 実測の弱い所に実際に出ていた名前
    ["左の大阪市北区｜label.one_city", "checkbox"],
    ["大阪市大正区｜label.one_city", "checkbox"],
    ["左の大阪市住吉区｜label.one_city", "checkbox"],
    ["city_code[]", "checkbox"],
    ["room_layout_id[]", "checkbox"],
    ["左の3K｜label", "checkbox"],
    ["左の4K｜label", "checkbox"],
    ["印刷用PDF🧠88通す｜td", "button"],
    ["印刷用PDF｜span.hover_comment", "button"],
    ["左の所在地絞り込み＋沿線・駅｜div.search_menu", "button"],
    // 実測の他の欄
    ["rental_cost1", "select"],
    ["rental_cost2", "select"],
    ["square_meter_l", "select"],
    ["update_date", "select"],
    ["structured_date", "select"],
    ["required_time", "text"],
    ["確定してリストへ｜span", "button"],
    ["左の検索｜span", "button"],
    ["img", "other"],
  ];
  for (const [name, k] of want) {
    it(`${name} → ${k}`, () => {
      const g = guessKindFromName(name);
      ok(!!g, "推せなかった");
      eq(g!.kind, k, name);
      ok(typeof g!.conf === "number" && g!.conf > 0 && g!.conf <= 1, "確かさが変");
    });
  }
  it("分からない名前は null（推測で埋めない）", () => eq(guessKindFromName("謎の名前xyz"), null));
  it("空文字は null", () => eq(guessKindFromName(""), null));
  it("確かさはクラス名が分かる物の方が高い", () => {
    const a = guessKindFromName("左の大阪市北区｜label.one_city")!;
    const b = guessKindFromName("rental_cost1")!;
    ok(a.conf > b.conf, `${a.conf} > ${b.conf}`);
  });
}

console.log("=== ② 統括が「次に何を学ぶか」を決める");
{
  it("優先度の順に並ぶ（写真と記録のズレが最優先）", () => {
    const p = planLearnFromWeak([
      { kind: "kind_unknown", name: "x1" },
      { kind: "pressed_disabled", name: "x2" },
      { kind: "photo_vs_record", name: "x3" },
      { kind: "kind_conflict_in_photo", name: "x4" },
    ]);
    eq(p.items.map((x) => x.kind), ["photo_vs_record", "kind_conflict_in_photo", "pressed_disabled", "kind_unknown"]);
  });
  it("やる事が書いてある", () => {
    const p = planLearnFromWeak([{ kind: "kind_unknown", name: "x" }]);
    ok(p.items[0].action.includes("名前から推して"), p.items[0].action);
  });
  it("同じ名前は1つにまとめる", () => {
    const p = planLearnFromWeak([
      { kind: "kind_unknown", name: "same" },
      { kind: "kind_unknown", name: "same" },
    ]);
    /**
     * ⚠ 重複を畳む前に数える（`counts` は**のべ件数**）。
     *   やる事（items）は1つにまとめる＝同じ所を何度も出さない。
     */
    eq(p.items.length, 1);
    eq(p.counts.kind_unknown, 1, "counts は畳んだ後の件数（やる事と同じ）");
  });
  it("名前から埋めた物は「やる事」から外す（件数には残す）", () => {
    const p = planLearnFromWeak(
      [{ kind: "kind_unknown", name: "filled1" }, { kind: "kind_unknown", name: "left1" }],
      [{ name: "filled1", kind: "checkbox", conf: 0.9 }],
    );
    eq(p.items.map((x) => x.name), ["left1"]);
    eq(p.filled, 1);
    eq(p.counts.kind_unknown, 2);
  });
  it("全部埋まったら「なし」", () => {
    const p = planLearnFromWeak(
      [{ kind: "kind_unknown", name: "a" }, { kind: "kind_unknown", name: "b" }],
      [{ name: "a", kind: "checkbox", conf: 0.9 }, { name: "b", kind: "select", conf: 0.7 }],
    );
    eq(p.items.length, 0);
    ok(p.summary.includes("なし"), p.summary);
  });
  it("空でも落ちない", () => {
    const p = planLearnFromWeak([]);
    eq(p.items.length, 0);
  });
}

console.log("=== ③ 今のデータ（40件相当）が名前で埋まる");
{
  // 実測の弱い所40件と同じ形
  const names = [
    "city_code[]", "印刷用PDF🧠88通す｜td", "印刷用PDF｜span.hover_comment",
    "大阪市大正区｜label.one_city", "大阪市天王寺区｜label.one_city",
    "左の3K｜label", "左の4K｜label", "左の2DK｜label",
    "大阪市西成区｜label.one_city", "大阪市東住吉区｜label.one_city",
    "左の大阪市住吉区｜label.one_city", "左の大阪市旭区｜label.one_city",
    "左の大阪市城東区｜label.one_city", "左の大阪市平野区｜label.one_city",
    "左の所在地絞り込み＋沿線・駅｜div.search_menu", "左の大阪市港区｜label.one_city",
    "左の大阪市此花区｜label.one_city", "左の大阪市生野区｜label.one_city",
    "左の大阪市福島区｜label.one_city", "左の大阪市都島区｜label.one_city",
  ];
  const guessed = names.map((n) => guessKindFromName(n)).filter(Boolean) as Array<{ kind: string; conf: number }>;
  eq(guessed.length, names.length, "推せた数");
  const p = planLearnFromWeak(names.map((name) => ({ kind: "kind_unknown", name })), names.map((name) => ({ name, ...guessKindFromName(name)! })));
  eq(p.items.length, 0, "残ったやる事");
  eq(p.filled, names.length, "埋めた数");
  it(`実測の20件すべて名前から埋まる（残り0）`, () => eq(p.items.length, 0));
}

console.log("=== ④ 学習の束に入り、人が読める行になる");
{
  const mk = (ops: string[]) => ({
    created_at: new Date().toISOString(), site: "realpro",
    shot_ops: ops.map((f) => ({ f, k: "click" })), shot_taken: true,
    /**
     * ⚠ `points` は `point_fields`（押した位置の記録）から作られる。
     *   これが無いと種類を学ぶ対象が無い（実データでは必ず入っている）。
     */
    point_fields: Object.fromEntries(ops.map((f) => [f, { x: 0.5, y: 0.5, n: 2 }])),
  });
  it("learn_plan が入る", () => {
    // 名前から推せない欄を含む記録 → やる事が残る
    const b = compactBundle(buildHumanLearnBundle([mk(["謎の欄xyz", "rental_cost1"])] as never));
    ok(!!b.learn_plan, "learn_plan が無い");
  });
  it("人が読める行に「学習の統括」が出る", () => {
    const b = compactBundle(buildHumanLearnBundle([mk(["謎の欄xyz", "rental_cost1"])] as never));
    const s = b.lines.join("\n");
    ok(/学習の統括: 次にやる事/.test(s), "見出しが無い");
  });
  it("推定した種類は w_src=name で区別できる", () => {
    const b = compactBundle(buildHumanLearnBundle([mk(["rental_cost1", "required_time"])] as never));
    const pt = b.points as Record<string, { w?: string; w_src?: string }>;
    const found = Object.values(pt).filter((v) => v.w_src === "name");
    ok(found.length > 0, "w_src=name が無い");
  });
}

console.log(`\n結果: 合格 ${passed} / 不合格 ${failed}`);
if (failed) { for (const f of failures) console.log("  ✗ " + f); process.exit(1); }
