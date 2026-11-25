// build_v9: 手順書の検索把握・area確定・extra_guides がコードに残っているか（配線）
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../..");
const pb = fs.readFileSync(path.join(root, "app/lib/action-playbook.ts"), "utf8");
const loop = fs.readFileSync(path.join(root, "app/lib/ext-test-improve-loop.ts"), "utf8");

function ok(name, cond, detail) {
  if (!cond) {
    console.error("✗", name, detail || "");
    process.exitCode = 1;
  } else console.log("✓", name);
}

console.log("■ build_v9 手順書配線");
{
  const m = pb.match(/export const PLAYBOOK_BUILD_V = (\d+)/);
  const v = m ? Number(m[1]) : 0;
  ok("PLAYBOOK_BUILD_V ≥ 9", v >= 9, "v=" + v);
}
ok("PLAYBOOK_SEARCH_GRASP_STEPS", /PLAYBOOK_SEARCH_GRASP_STEPS/.test(pb) && /①条件が揃ったら検索/.test(pb));
ok("PLAYBOOK_AREA_CONFIRM_STEPS", /PLAYBOOK_AREA_CONFIRM_STEPS/.test(pb) && /確定してリストへ/.test(pb));
ok("PLAYBOOK_EXTRA_GUIDES", /PLAYBOOK_EXTRA_GUIDES/.test(pb) && /id: "clear"/.test(pb) && /id: "switch"/.test(pb) && /id: "pet"/.test(pb));
ok("pager FIELD_JA", /"最初前1234次最後"/.test(pb));
ok("F58 suite に playbook_search_extra_guides", /playbook_search_extra_guides/.test(loop));
ok("F58 suite に action_playbook", /id: "action_playbook"/.test(loop));

if (process.exitCode) process.exit(1);
console.log("playbook-build-v9-wiring.test OK");
