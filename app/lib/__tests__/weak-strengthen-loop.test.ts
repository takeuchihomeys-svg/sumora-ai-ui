/**
 * 弱い部分強化ループの純テスト
 * 実行: npx tsx app/lib/__tests__/weak-strengthen-loop.test.ts
 */
import { buildWeakStrengthenPlan } from "../weak-strengthen-loop";

let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log("  ✓", name);
  else {
    failed++;
    console.log("  ✗", name, detail ?? "");
  }
}

console.log("\n■ 1つずつ: 欄ごとに photo_learn");
{
  const p = buildWeakStrengthenPlan({
    weakFields: ["route_id[]", "required_time"],
    challengeFields: ["rental_cost2", "required_time", "確定してリストへ"],
    atoms: ["point_pct", "field:route_id"],
    unreadNormal: 40,
    bottleneck_n: 5,
    pointPct: 34,
    round: 1,
    oneByOne: true,
  });
  const photos = p.cycle.filter((t) => t.kind === "photo_learn");
  ok("photo_learn が複数（1つずつ）", photos.length >= 3, photos.map((t) => t.fields));
  ok("各 photo は fields 1個", photos.every((t) => (t.fields || []).length === 1), photos.map((t) => t.fields));
  ok("what に1つ理解", photos.every((t) => /1つ理解/.test(t.what)));
  ok("one_by_one フラグ", p.one_by_one === true);
  ok("学んだら強化: reflect がある", p.cycle.some((t) => t.kind === "reflect_auto"));
  ok("学んだら強化: 自動1回がある", p.cycle.some((t) => t.kind === "need_auto_run"));
  ok("line に1つずつ", /1つずつ/.test(p.line), p.line);
}

console.log("\n■ まとめてモード");
{
  const p = buildWeakStrengthenPlan({
    weakFields: ["required_time", "rental_cost2"],
    unreadNormal: 20,
    bottleneck_n: 4,
    oneByOne: false,
  });
  const photos = p.cycle.filter((t) => t.kind === "photo_learn");
  ok("まとめては photo 1回", photos.length === 1);
  ok("fields に複数", (photos[0]?.fields || []).length >= 2);
}

console.log("\n■ 未学習0・段階5 → 自動1回");
{
  const p = buildWeakStrengthenPlan({
    weakFields: [],
    challengeFields: [],
    unreadNormal: 0,
    bottleneck_n: 5,
    round: 2,
  });
  ok("自動1回がある", p.cycle.some((t) => t.kind === "need_auto_run"));
}

console.log("\n■ 土台: 台帳外ゴミを落とす");
{
  const p = buildWeakStrengthenPlan({
    weakFields: ["1DK", "大阪市北区", "大阪市高速軌道御堂筋線"],
    challengeFields: ["確定してリストへ", "ゴミフィールドXYZ"],
    unreadNormal: 40,
    bottleneck_n: 4,
    oneByOne: true,
    site: "realpro",
  });
  const photos = p.cycle.filter((t) => t.kind === "photo_learn");
  const fields = photos.flatMap((t) => t.fields || []);
  ok("1DKは間取り欄に写る", fields.includes("room_layout_id[]"), fields);
  ok("区名はcityに写る", fields.includes("city_code[]"), fields);
  ok("路線名はrouteに写る", fields.includes("route_id[]"), fields);
  ok("ゴミは無い", !fields.some((f) => /ゴミ|XYZ|御堂筋線|大阪市北区|1DK/.test(f)), fields);
  ok("whatがリアプロ", photos.every((t) => /リアプロ/.test(t.what)));
}

console.log("\n■ ITANDIサイト");
{
  const p = buildWeakStrengthenPlan({
    weakFields: ["rent:lteq", "room_layout:in"],
    unreadNormal: 20,
    oneByOne: true,
    site: "itandi",
  });
  const photos = p.cycle.filter((t) => t.kind === "photo_learn");
  ok("ITANDI表記", photos.some((t) => /ITANDI/.test(t.what)), photos.map((t) => t.what));
}

if (failed) {
  console.log("\n失敗:", failed);
  process.exit(1);
}
console.log("\n全部 OK");
