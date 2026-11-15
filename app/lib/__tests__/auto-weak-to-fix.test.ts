// app/lib/__tests__/auto-weak-to-fix.test.ts
//
// 2026-11-15 竹内さん「自動モードの弱い部分も録画などから必要な時見つけ出して
//   通常モードの学習から改善して実装するようにする そして強化していく」
//
// ★ この道具の流れ（1本にする）
//   ① 自動モードの弱点を見つける（録画の実測から）
//   ② 通常モードの手本と比べる（人がどうやっているか＝正解）
//   ③ 直し方を1つに決める（費用・効く事・目標つき）
//
// ★ 実測（3日・通常800枚/自動297枚）
//   通常: カーソル94%・押した位置74%
//   自動: カーソル75%・押した位置 **12%**
//
// 実行: npx tsx app/lib/__tests__/auto-weak-to-fix.test.ts
import { findAutoWeaks, orderWeaks, type DiagRow } from "../auto-weak-to-fix";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

// 実測の形を作る
const human: DiagRow[] = Array.from({ length: 100 }, (_, i) => ({
  created_at: `2026-11-15T10:00:${String(i % 60).padStart(2, "0")}Z`,
  moves_n: i < 94 ? 20 : 0,
  point_fields: i < 74 ? { rental_cost2: { n: 2, x: 0.1, y: 0.2 } } : null,
  shot_ops: [
    { t: 1000 + i, k: "click", f: "rental_cost2" },
    { t: 1200 + i, k: "change", f: "rental_cost2" },
    { t: 2000 + i, k: "click", f: "div.building_tr" },
    { t: 3000 + i, k: "click", f: "左の検索｜span" },
  ],
}));
const auto: DiagRow[] = Array.from({ length: 100 }, (_, i) => ({
  created_at: `2026-11-15T11:00:${String(i % 60).padStart(2, "0")}Z`,
  moves_n: i < 75 ? 5 : 0,
  point_fields: i < 12 ? { rental_cost2: { n: 1, x: 0.5, y: 0.5 } } : null,
  shot_ops: [
    // 押さずに値が変わる（change だけ）
    { t: 1000 + i, k: "change", f: "rental_cost2" },
    { t: 2000 + i, k: "click", f: "左の検索｜span" },
  ],
}));

console.log("■ ① 自動モードの弱点を録画から見つける");
{
  const w = findAutoWeaks(auto, human);
  ok("弱点が出る", w.length >= 2, w.map((x) => x.kind));
  /**
   * ⚠ 実測に基づく期待値:
   *   カーソル 94% → 75% = **差19**（30未満なので指摘しない・誤報しない）
   *   押した位置 74% → 12% = **差62**（出る）
   *   押さずに値が変わった（出る）
   */
  ok("⚠ 差19のカーソルは指摘しない（30未満）", !w.some((x) => x.kind === "no_cursor"), w.map((x) => x.kind));
  ok("押した位置が足りない（差62）", w.some((x) => x.kind === "no_point"), w.map((x) => x.kind));
  ok("押さずに値が変わった", w.some((x) => x.kind === "changed_without_click"), w.map((x) => x.kind));
  // カーソルの差が大きい時は出る
  const badCursor = auto.map((r) => ({ ...r, moves_n: 0 }));
  ok("カーソルの差が大きければ出す", findAutoWeaks(badCursor, human).some((x) => x.kind === "no_cursor"));
}

console.log("\n■ ② 通常モードの手本を必ず添える（正解は人にある）");
{
  const w = findAutoWeaks(auto, human);
  for (const x of w) {
    ok(`「${x.kind}」に手本がある`, typeof x.human === "string" && x.human.length > 0);
    ok(`「${x.kind}」に費用がある`, typeof x.cost === "string" && x.cost.length > 0);
    ok(`「${x.kind}」に目標がある`, x.target.includes("%") || x.target.includes("件"), x.target);
  }
}

console.log("\n■ ③ 数字を実測で出す（推測しない）");
{
  const w = findAutoWeaks(auto, human);
  const point = w.find((x) => x.kind === "no_point");
  ok("押した位置に 74% と 12% が入る", !!point?.why.includes("74%") && !!point?.why.includes("12%"), point?.why);
  const badCursor = auto.map((r) => ({ ...r, moves_n: 0 }));
  const cursor = findAutoWeaks(badCursor, human).find((x) => x.kind === "no_cursor");
  ok("カーソルに 94% と 0% が入る", !!cursor?.why.includes("94%") && !!cursor?.why.includes("0%"), cursor?.why);
}

console.log("\n■ ④ やる順（危険な物が先）");
{
  const w = findAutoWeaks(auto, human);
  const ord = orderWeaks(w);
  ok("最初は「押さずに値が変わった」（別のお客さんの条件で検索する危険）", ord[0].kind === "changed_without_click", ord.map((x) => x.kind));
  ok("押した位置が2番目", ord[1].kind === "no_point", ord.map((x) => x.kind));
}

console.log("\n■ ⑤ 差が小さい時は指摘しない（誤報しない）");
{
  // 通常と自動が同じ状態
  const w = findAutoWeaks(human, human);
  ok("差が無ければカーソル・位置を指摘しない", !w.some((x) => x.kind === "no_cursor" || x.kind === "no_point"), w.map((x) => x.kind));
}

console.log("\n■ ⑥ 拡張自身の部品は数えない");
{
  const autoWithOwn = auto.map((r) => ({
    ...r,
    shot_ops: [...(r.shot_ops ?? []), { t: 9999, k: "click" as const, f: "AIXLINX｜div" }],
  }));
  const w = findAutoWeaks(autoWithOwn, human);
  const miss = w.find((x) => x.kind === "missing_field");
  ok("⚠ 拡張自身の部品で「人が押す欄」を増やさない", !miss || !miss.why.includes("AIXLINX"), miss?.why);
}

console.log("\n■ ⑦ 壊れた入力でも落ちない");
{
  ok("空でも落ちない", findAutoWeaks([], []).length === 0);
  ok("null でも落ちない", findAutoWeaks(null as never, null as never).length === 0);
  ok("自動が空なら何も出さない（比べられない）", findAutoWeaks([], human).length === 0);
  ok("通常が空でも落ちない", findAutoWeaks(auto, []).length >= 0);
  ok("orderWeaks が空でも落ちない", orderWeaks([]).length === 0);
  ok("orderWeaks が null でも落ちない", orderWeaks(null as never).length === 0);
}

console.log("\n■ ⑧ なぜ「通常モードの手本」から作るかをコードに残している");
{
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../auto-weak-to-fix.ts"), "utf8");
  ok("正解は人にあると書いてある", /正解は\*\*人/.test(src) || /正解は人/.test(src));
  ok("自動だけ見ても正解が分からないと書いてある", /自動モードの録画だけ見ても/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
