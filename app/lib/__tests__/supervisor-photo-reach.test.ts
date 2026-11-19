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
import { photoReachFromBundle } from "../learn-supervisor-pro";
import { buildVisionProLink } from "../vision-pro-link";
import { shotGapsFromCounts } from "../shot-gaps-db";

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

console.log("\n■ 束に学べ済みが載り、統括Pro が flash未実行と誤判定しない（2026-11-19）");
{
  const rows = [
    { site: "realpro", mode: "normal", shot_key: "a1", shot_taken: true, shot_w: 1920, shot_learn: { fields: [{ name: "検索", kind: "button" }] } },
    { site: "realpro", mode: "normal", shot_key: "a2", shot_taken: true, shot_w: 1920, shot_learn: { fields: [{ name: "賃料", kind: "select" }] } },
    { site: "realpro", mode: "normal", shot_key: "a3", shot_taken: true, shot_w: 1920 },
    { site: "realpro", mode: "auto", shot_key: "a4", shot_taken: true, shot_w: 1920, shot_learn: { fields: [{ name: "検索", kind: "button" }] } },
  ];
  const b = compactBundle(buildHumanLearnBundle(rows as never)) as unknown as Record<string, unknown>;
  const gn = b.shot_gaps_normal as { learnedOk?: number; todo?: number } | undefined;
  const g = b.shot_gaps as { learnedOk?: number } | undefined;
  ok("束に shot_gaps_normal（通常だけ 学べ2・未読1）", gn?.learnedOk === 2 && gn?.todo === 1, gn);
  ok("束に shot_gaps（全モード 学べ3）", g?.learnedOk === 3, g);
  const pr = photoReachFromBundle(b);
  ok("photoReachFromBundle が学べ済みを読む（0にしない）", pr.learnedOk === 2, pr);
  const vpl = buildVisionProLink({ photoInStorage: pr.photoReach, learnedOk: pr.learnedOk, todo: pr.todo });
  ok("段2 flashで読む✓", vpl.steps[1]?.ok === true, vpl.steps[1]);
}

console.log("\n■ DB の件数から抜けを作る（束に無い時の補い）");
{
  const g = shotGapsFromCounts({ total: 3778, learned: 3467, learnedWithFields: 3460, unlearnedBig: 311 });
  ok("学べた3460・欄0が7・未学習(大)311・todo318", g?.learnedOk === 3460 && g?.learnedButEmpty === 7 && g?.unlearnedBig === 311 && g?.unlearnedSmall === 0 && g?.todo === 318, g);
  ok("写真0枚なら null", shotGapsFromCounts({ total: 0, learned: 0, learnedWithFields: 0, unlearnedBig: 0 }) === null);
  const pr = photoReachFromBundle({ shot_gaps_normal: g, shots: { in_storage: 3778 } });
  ok("補った数で photoReach が学べ済みを読む", pr.learnedOk === 3460, pr);
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
