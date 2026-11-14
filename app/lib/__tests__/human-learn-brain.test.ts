// 実行: npx tsx app/lib/__tests__/human-learn-brain.test.ts
// 2026-11-13 竹内さん「ちゃんと学習担当のブレインをつくってより効率的に学習できるようにする。
//   データベースを有効活用する」
//
// 「学習担当のブレイン」（app/lib/human-learn-brain.ts）が
//   ① 押す順番  ② 押す場所  ③ 動きの速さ  ④ 大事なボタン  ⑤ サイトごとの手順
// を、溜まった記録から**1つの束**にまとめられることを固定する。
import {
  buildHumanLearnBundle, learnNextPress, learnPoints, learnMotion, sequencesOf,
  compactBundle, describeBundle, type MotionRow,
} from "../human-learn-brain";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}

const NOW = Date.parse("2026-11-13T15:00:00+09:00");
const iso = (d: number) => new Date(NOW - d * 3600_000).toISOString();

// 実物の形（本番の point_fields と同じ形）
const row = (o: Partial<MotionRow>): MotionRow => ({
  created_at: iso(1), site: "realpro", mode: "normal", ext_version: "2.7.10",
  ops: 120, moves_n: 40, move_speed_px_s: 900, move_curve: 1.2, move_ms: 520, move_dist: 300,
  points_n: 30, point_x: 0.42, point_y: 0.43,
  point_fields: { "rental_cost2": { n: 6, x: 0.10, y: 0.14 }, "確定してリストへ｜span": { n: 3, x: 0.40, y: 0.50 } },
  scrolls_n: 0, scroll_dy: null,
  ...o,
});

console.log("■ ① 押す順番（写真の操作の並びから）");
{
  const seq = [
    { t: 1, k: "click", f: "左の所在地絞り込み＋｜span" },
    { t: 2, k: "click", f: "左の大阪市港区｜label.one_city" },
    { t: 3, k: "click", f: "確定してリストへ｜span" },
  ];
  const m = learnNextPress([seq, seq, seq]);
  t("「所在地絞り込み＋」の次は「大阪市港区」", m["左の所在地絞り込み＋｜span"]?.next === "左の大阪市港区｜label.one_city", m);
  t("回数を数える（3回）", m["左の所在地絞り込み＋｜span"]?.n === 3);
  t("2段目も学ぶ（港区 → 確定）", m["左の大阪市港区｜label.one_city"]?.next === "確定してリストへ｜span");
  t("1回だけは学ばない", Object.keys(learnNextPress([seq])).length === 0);
  t("2回あれば学ぶ", Object.keys(learnNextPress([seq, seq])).length > 0);
  t("同じ欄の続き（値の入力中）は数えない", Object.keys(learnNextPress([[{ f: "A" }, { f: "A" }], [{ f: "A" }, { f: "A" }]])).length === 0);
  t("多い方の行き先を選ぶ（2対1）", learnNextPress([[{ f: "A" }, { f: "B" }], [{ f: "A" }, { f: "B" }], [{ f: "A" }, { f: "C" }]]).A?.next === "B");
  t("空・壊れた入力で落ちない", Object.keys(learnNextPress(null as never)).length === 0 && Object.keys(learnNextPress([[]] as never)).length === 0);
}

console.log("\n■ ② 押す場所（要素ごと・回数の多い実測に寄せる）");
{
  const pts = learnPoints([
    row({ point_fields: { rental_cost2: { n: 4, x: 0.1, y: 0.2 } } }),
    row({ point_fields: { rental_cost2: { n: 9, x: 0.3, y: 0.4 } } }),
    row({ point_fields: { rental_cost2: { n: 2, x: 0.9, y: 0.9 } } }),
  ]);
  t("回数が多い実測を採る（9回の物）", pts.rental_cost2.x === 0.3 && pts.rental_cost2.y === 0.4 && pts.rental_cost2.n === 9, pts.rental_cost2);
  /**
   * 2026-11-14: `x` は**1文字なので学習対象外**（`isLearnableName` が弾く・正しい動作）。
   *   ここで試したいのは「0〜1に丸める」ことなので、実際にあり得る欄の名前で試す。
   */
  t("おかしな値は 0〜1 に丸める", learnPoints([row({ point_fields: { rental_cost2: { n: 2, x: 9, y: -3 } } })]).rental_cost2.x === 1);
  t("n が 0 以下は捨てる", Object.keys(learnPoints([row({ point_fields: { z: { n: 0, x: 0.5, y: 0.5 } } })])).length === 0);
  t("欄が無ければ空", Object.keys(learnPoints([row({ point_fields: null })])).length === 0);
}

console.log("\n■ ③ 動きの速さ・曲がり・狙う位置");
{
  const m = learnMotion([
    row({ moves_n: 10, move_speed_px_s: 800, move_curve: 1.1, points_n: 5, point_x: 0.4, point_y: 0.4 }),
    row({ moves_n: 10, move_speed_px_s: 1000, move_curve: 1.3, points_n: 5, point_x: 0.5, point_y: 0.5 }),
  ]);
  t("速さは中央値（900）", m.speed_px_s === 900, m.speed_px_s);
  t("曲がりは中央値（1.2）", m.curve === 1.2, m.curve);
  t("狙う位置は中央値（0.4と0.5 → 0.45）", m.aim?.x === 0.45 && m.aim?.y === 0.45, m.aim);
  t("回数を数える（動き20回・押した所10回）", m.moves === 20 && m.points === 10, m);
  t("速さは 100〜4000 に丸める", learnMotion([row({ move_speed_px_s: 99999 })]).speed_px_s === 4000);
  t("材料が無ければ null（今まで通りの動き）", learnMotion([row({ moves_n: 0 })]).speed_px_s === null);
}

console.log("\n■ ④ 束にまとめる（拡張が読む形）");
{
  /**
   * 2026-11-14: 欄の名前は**1文字だと学習対象外**（`isLearnableName` が弾く＝正しい動作）。
   *   ここで試したいのは「束に順番・サイト手順が入るか」なので、実際にあり得る名前で試す。
   */
  const seqA = [{ t: 1, k: "click", f: "左の所在地絞り込み＋｜span" }, { t: 2, k: "click", f: "city_code[]" }];
  const seqB = [{ t: 1, k: "click", f: "左の所在地絞り込み＋｜span" }, { t: 2, k: "click", f: "city_code[]" }];
  const b = buildHumanLearnBundle([
    /**
     * 2026-11-14: **同じ日の同じ並びは1回に畳む**（録画は数秒ごとに撮るので水増しを防ぐ・意図した動作）。
     *   ⚠ 旧は3件とも同じ日だったので、畳まれて `next` が空になっていた（テストの材料の誤り）。
     *   → 別の日に分ける（人が3日かけて同じ操作をした形）。
     */
    row({ site: "realpro", shot_ops: seqA, created_at: iso(72) }),
    row({ site: "realpro", shot_ops: seqB, created_at: iso(48) }),
    row({ site: "itandi", shot_ops: seqB, created_at: iso(1) }),
  ], NOW);
  t("版を持つ（v:1）", b.v === 1);
  t("生成時刻を持つ", b.generated_at === new Date(NOW).toISOString());
  t("元にした記録の数", b.source.rows === 3);
  t("元にした期間（いちばん古い〜新しい）", b.source.from === iso(72) && b.source.to === iso(1), b.source);
  t("サイトの一覧", b.source.sites.includes("realpro") && b.source.sites.includes("itandi"), b.source.sites);
  t("押す順番が入っている", Object.keys(b.next).length > 0);
  t("押す場所が入っている", Object.keys(b.points).length > 0);
  t("大事なボタン（回数の多い順）", b.buttons.length > 0 && b.buttons[0].n >= b.buttons[b.buttons.length - 1].n);
  t("サイトごとの手順が入っている", Array.isArray(b.site_flow.realpro) && b.site_flow.realpro.length > 0, b.site_flow);
  t("人が読む1行ずつがある", Array.isArray(b.lines) && b.lines.length > 0);
  t("「押す順番」と「押す場所」が言葉に出る", b.lines.join("\n").includes("押す順番") && b.lines.join("\n").includes("押す場所"));
}

console.log("\n■ ⑤ 小さくする（拡張が読む時に重くしない）");
{
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 300; i++) many["f" + i] = { n: i + 1, x: 0.5, y: 0.5 };
  const b = buildHumanLearnBundle([row({ point_fields: many })], NOW);
  const c = compactBundle(b);
  t("押す場所は 120件まで", Object.keys(c.points).length <= 120, Object.keys(c.points).length);
  t("回数の多い物から残す", (c.points["f299"]?.n ?? 0) > 0);
  t("元の束は変えない（純関数）", Object.keys(b.points).length === 300);
  t("describeBundle が読める形", describeBundle(c).length > 0);
}

console.log("\n■ ⑥ 中身（入力した文字）は入れない");
{
  const b = buildHumanLearnBundle([row({ shot_ops: [{ t: 1, k: "click", f: "A", v: "山田太郎" }, { t: 2, k: "click", f: "B" }] } as never)], NOW);
  const s = JSON.stringify(b);
  t("操作の並びに value を持ち込まない", !s.includes("山田太郎"));
  t("欄の名前だけを使う（押した場所は入る）", s.includes("rental_cost2"), s.slice(0, 120));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
