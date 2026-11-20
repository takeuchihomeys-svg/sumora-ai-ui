/**
 * 実行: npx tsx app/lib/__tests__/field-name-aliases.test.ts
 */
import {
  mergeAliasPositions,
  fieldHasPosition,
  aliasesOf,
  expandAliasPoints,
  expandAliasLearnedFields,
  applyBundleAliasExpansion,
  ROOM_LAYOUT_VISION_NAMES,
  isOpenerName,
} from "../field-name-aliases";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : " → " + JSON.stringify(extra).slice(0, 200))); }
};

console.log("■ 別名");
ok("transportation_id → 駅からの移動手段", aliasesOf("transportation_id").includes("駅からの移動手段"));
ok("駅からの移動手段 → transportation_id", aliasesOf("駅からの移動手段").includes("transportation_id"));

console.log("\n■ 位置の移し");
{
  const merged = mergeAliasPositions([
    { name: "transportation_id", n: 108 },
    { name: "駅からの移動手段", n: 235, x: 0.15, y: 0.40 },
    { name: "update_date", n: 50 },
    { name: "更新日", n: 247, x: 0.2, y: 0.3 },
  ]);
  const tr = merged.find((f) => f.name === "transportation_id");
  const up = merged.find((f) => f.name === "update_date");
  ok("transportation_id に x/y が付く", typeof tr?.x === "number" && typeof tr?.y === "number", tr);
  ok("update_date に x/y が付く", typeof up?.x === "number" && up?.y === 0.3, up);
  ok("日本語欄は残る", merged.some((f) => f.name === "駅からの移動手段" && f.x === 0.15));
}

console.log("\n■ 課題が束にあるか");
{
  const have = new Set(["駅からの移動手段", "更新日", "賃料上限"]);
  ok("transportation_id は別名で有り", fieldHasPosition("transportation_id", have));
  ok("required_time は無し", !fieldHasPosition("required_time", have));
}

console.log("\n■ 沿線を選ぶ（仕組み㉑）");
{
  ok("沿線を選ぶ → 沿線・駅絞り込み＋", aliasesOf("沿線を選ぶ").includes("沿線・駅絞り込み＋"));
  ok("route_id[] → 沿線を選ぶ", aliasesOf("route_id[]").includes("沿線を選ぶ"));
  const have = new Set(["沿線・駅絞り込み＋", "route_id[]"]);
  ok("課題「沿線を選ぶ」は束の別名で有り", fieldHasPosition("沿線を選ぶ", have));
}

console.log("\n■ 別名位置の複製（自動強化）");
{
  const exp = expandAliasPoints({
    "route_id[]": { x: 0.2, y: 0.3, n: 10 },
    transportation_id: { x: 0.4, y: 0.5, n: 5 },
  });
  ok("沿線を選ぶに複製", typeof exp["沿線を選ぶ"]?.x === "number" && exp["沿線を選ぶ"].x === 0.2);
  ok("駅からの移動手段に複製", typeof exp["駅からの移動手段"]?.x === "number");
  const learned = expandAliasLearnedFields([
    { name: "route_id[]", kind: "checkbox", n: 8, x: 0.22, y: 0.33 },
  ]);
  ok("learned に沿線を選ぶ行", learned.some((f) => f.name === "沿線を選ぶ" && f.x === 0.22));
}

console.log("\n■ inherit 後の束");
{
  const b: Record<string, unknown> = {
    points: { "route_id[]": { x: 0.2, y: 0.3, n: 10 } },
    shots: {
      learned: {
        form: [{ name: "route_id[]", kind: "checkbox", n: 8, x: 0.22, y: 0.33 }],
      },
    },
  };
  applyBundleAliasExpansion(b);
  const pts = b.points as Record<string, { x?: number }>;
  ok("points 沿線を選ぶ", typeof pts["沿線を選ぶ"]?.x === "number");
  const lf = (b.shots as { learned?: Record<string, Array<{ name: string }>> }).learned?.form || [];
  ok("learned 沿線を選ぶ", lf.some((f) => f.name === "沿線を選ぶ"));
}

console.log("\n■ 間取り・駅（2026-11-18）");
{
  ok("room_layout_id[] ↔ 1LDK 別名", aliasesOf("room_layout_id[]").includes("1LDK"));
  const haveLayout = new Set(["1LDK", "2DK", "賃料上限"]);
  ok("room_layout_id[] は個別間取りのxyで有り", fieldHasPosition("room_layout_id[]", haveLayout));
  ok("1LDK の xy を room_layout_id[] に複製しない", (() => {
    const merged = mergeAliasPositions([
      { name: "room_layout_id[]", n: 50 },
      { name: "1LDK", n: 200, x: 0.11, y: 0.22 },
    ]);
    const rl = merged.find((f) => f.name === "room_layout_id[]");
    return typeof rl?.x !== "number";
  })());
  ok("間取りラベルは x/y を複製できる", (() => {
    const merged = mergeAliasPositions([
      { name: "room_layout_id[]", n: 50 },
      { name: "間取り", n: 80, x: 0.15, y: 0.25 },
    ]);
    const rl = merged.find((f) => f.name === "room_layout_id[]");
    return typeof rl?.x === "number" && rl.x === 0.15;
  })());
  ok("station_id[] は駅を選ぶで有り", fieldHasPosition("station_id[]", new Set(["駅を選ぶ", "賃料"])));
  void ROOM_LAYOUT_VISION_NAMES;
}

console.log("\n■ 開くボタンにチェック欄の位置を写さない（2026-11-20 本番の束 2532 の形）");
{
  ok("開くボタンの名前", isOpenerName("左の所在地絞り込み＋｜span") && isOpenerName("所在地絞り込み") && isOpenerName("沿線・駅絞り込み＋") && isOpenerName("所在地を絞り込み"));
  ok("チェック欄・課題名は開くボタンではない", !isOpenerName("city_code[]") && !isOpenerName("沿線を選ぶ") && !isOpenerName("区を選ぶ"));
  const fresh = expandAliasPoints({
    "city_code[]": { n: 1238, w: "checkbox", x: 0.5, y: 0.5 },
    "左の所在地絞り込み＋｜span": { n: 6, w: "button", x: 0.55, y: 0.6 },
  });
  ok("測ったボタンの位置を票の多いチェック欄で上書きしない", fresh["左の所在地絞り込み＋｜span"]?.x === 0.55 && fresh["左の所在地絞り込み＋｜span"]?.w === "button", fresh["左の所在地絞り込み＋｜span"]);
  ok("ボタン名（所在地絞り込み）にはボタンで測った位置が写る（チェック欄の位置ではない）", fresh["所在地絞り込み"]?.w === "button" && fresh["所在地絞り込み"]?.x === 0.55, fresh["所在地絞り込み"]);
  const onlyChk = expandAliasPoints({ "city_code[]": { n: 1238, w: "checkbox", x: 0.5, y: 0.5 } });
  ok("ボタンの測りが無ければ、ボタン名へチェック欄の位置を写さない", onlyChk["所在地絞り込み"] === undefined && onlyChk["左の所在地絞り込み＋｜span"] === undefined, Object.keys(onlyChk));
  ok("課題名（区を選ぶ）へは今まで通り写す", fresh["区を選ぶ"]?.x === 0.5);
  const copy = { n: 1238, w: "checkbox", x: 0.5, y: 0.5 };
  const healed = expandAliasPoints({
    "city_code[]": copy, "所在地絞り込み": copy, "所在地を絞り込み": copy, "左の所在地絞り込み＋｜span": copy,
    "左の所在地絞り込み＋｜div.one_slide_searc": { n: 1, w: "button", x: 0.42, y: 0.18 },
  });
  ok("既に写った開くボタンの名前は外す（3件）", !("所在地絞り込み" in healed) && !("所在地を絞り込み" in healed) && !("左の所在地絞り込み＋｜span" in healed), Object.keys(healed));
  ok("測ったボタンとチェック欄は残す", healed["左の所在地絞り込み＋｜div.one_slide_searc"]?.x === 0.42 && healed["city_code[]"]?.n === 1238);
  const real = expandAliasPoints({ "所在地絞り込み": { n: 3, w: "checkbox", x: 0.3, y: 0.3 }, "city_code[]": copy });
  ok("値が違う（写しでない）物は外さない", real["所在地絞り込み"]?.x === 0.3);
  const b: Record<string, unknown> = {
    points: {},
    shots: { learned: { form: [
      { name: "city_code[]", kind: "checkbox", n: 9, x: 0.5, y: 0.5 },
      { name: "所在地絞り込み", kind: "checkbox", n: 9, x: 0.5, y: 0.5 },
    ] } },
  };
  applyBundleAliasExpansion(b);
  const lf = (b.shots as { learned: Record<string, Array<{ name: string }>> }).learned.form;
  ok("画面の欄一覧でも開くボタンの写しを外し、足し直さない", !lf.some((f) => f.name === "所在地絞り込み" || f.name === "所在地を絞り込み"), lf.map((f) => f.name));
  ok("画面の欄一覧の課題名には写す", lf.some((f) => f.name === "区を選ぶ"));
  const r = expandAliasPoints({ "route_id[]": { n: 516, w: "checkbox", x: 0.5, y: 0.5 }, "沿線を選ぶ": { n: 2, w: "button", x: 0.4, y: 0.4 } });
  ok("種類の違う測った値は上書きしない（沿線を選ぶ button）", r["沿線を選ぶ"]?.w === "button" && r["沿線を選ぶ"]?.x === 0.4);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
