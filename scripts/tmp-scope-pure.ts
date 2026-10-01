import { resolveConditionChangeScope } from "../app/lib/condition-change-scope";
import * as ccs from "../app/lib/condition-change-scope";
import { buildTemporaryOverride } from "../app/lib/condition-scope-override";
const reg: any = { rent_max: 90000, floor_plan: "1K、1LDK", desired_area: "大阪市北区、大阪市福島区", walk_minutes: 10, building_age: 25, preferences: "バストイレ別、2階以上", area_mode: "ward" };
console.log(Object.keys(ccs).join(","));
for (const t of ["今回だけ1階も見たいです", "一旦家賃12万で見てもらえますか", "これからは駅10分以内でお願いします", "やっぱり1Kに変えてください"]) {
  for (const b of [undefined, "temporary", "permanent"]) console.log(t, "| brain=", b, "→", JSON.stringify(resolveConditionChangeScope({ text: t, brainScope: b as any })));
  console.log("   override:", JSON.stringify(buildTemporaryOverride(t, reg)));
}
