/**
 * 写真→統括到達: shot_bytes 無しでも通常抜けがあれば段1を誤報しない
 * 実行: npx tsx app/lib/__tests__/supervisor-photo-reach.test.ts
 */
import { superviseLearn } from "../learn-supervisor";
import {
  buildHumanLearnBundle,
  compactBundle,
  shotBytesFromRows,
  photoKindsFromScreens,
  imageMatchFromRows,
} from "../human-learn-brain";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail ?? ""); }
}

console.log("■ shot_bytes 未配線でも通常抜けで段1✓");
{
  const adv = superviseLearn({
    rows: 100,
    next: 5,
    points: 10,
    opens: 3,
    screens: 2,
    sequence: 2,
    gap_ms: 500,
    weak: [],
    mode_counts: { normal: 80 },
    site_counts: { realpro: 100 },
    with_ops: 50,
    // わざと shot_bytes を渡さない（サイト別の旧穴を再現）
    shot_gaps_normal: {
      total: 3545,
      unlearnedBig: 1000,
      unlearnedSmall: 746,
      learnedButEmpty: 0,
      learnedOk: 1799,
      todo: 1746,
    },
    photo_kinds: { button: 10, select: 5 },
    image_match: {
      imageFields: 8,
      pressedFields: 6,
      matched: 3,
      withScreenPos: 5,
      say: [{ what: "突合あり", why: "両方", next: "維持" }],
      line: "両方3",
    },
  } as Parameters<typeof superviseLearn>[0]);
  const vpl = adv.meeting?.vision_pro_link;
  ok("vision がある", !!vpl);
  ok("段1 写真保存✓", vpl?.steps[0]?.ok === true);
  ok("photo_in_storage > 0", (vpl?.counts.photo_in_storage || 0) > 0);
  ok("段3 材料✓", vpl?.steps[2]?.ok === true);
  ok("段4 突合✓", vpl?.steps[3]?.ok === true);
}

console.log("\n■ ヘルパ: shotBytes / photoKinds / imageMatch");
{
  const rows = [
    {
      mode: "normal",
      site: "realpro",
      shot_key: "k1",
      shot_taken: true,
      shot_w: 1200,
      shot_learn: {
        fields: [
          { name: "賃料", kind: "select", x: 0.1, y: 0.2 },
          { name: "検索", kind: "button", x: 0.2, y: 0.3 },
        ],
      },
      point_fields: { "検索": { n: 1, x: 0.21, y: 0.31 } },
    },
    {
      mode: "auto",
      site: "realpro",
      shot_key: "k2",
      shot_taken: true,
    },
  ];
  const sb = shotBytesFromRows(rows as never);
  ok("in_storage=2", sb.in_storage === 2);
  ok("large≥1", sb.large >= 1);
  const kinds = photoKindsFromScreens({
    form: { fields: [{ kind: "select", n: 2 }, { kind: "button", n: 1 }] },
  });
  ok("kinds select/button", !!kinds && kinds.select === 2 && kinds.button === 1);
  const im = imageMatchFromRows(rows as never);
  ok("imageMatch 通常だけ", !!im && (im.imageFields || 0) >= 1);
  ok("withScreenPos≥1", !!im && (im.withScreenPos || 0) >= 1);
}

console.log("\n■ 束 shots: screen 無しでも in_storage / kinds");
{
  const rows = [
    { site: "realpro", mode: "normal", shot_key: "s1", shot_taken: true },
    { site: "realpro", mode: "normal", shot_key: "s2", shot_taken: true },
  ];
  const b = compactBundle(buildHumanLearnBundle(rows as never));
  ok("shots がある", !!b.shots);
  ok("in_storage=2", Number(b.shots?.in_storage) === 2);
  ok("kinds は object", !!b.shots?.kinds && typeof b.shots.kinds === "object");
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
