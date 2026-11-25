// 2.8.182: 手順書の一連の流れ（flow_series）を把握する
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../..");
const page = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
const audit = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
const pb = fs.readFileSync(path.join(root, "app/lib/action-playbook.ts"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));

function ok(name, cond, detail) {
  if (!cond) {
    console.error("✗", name, detail || "");
    process.exitCode = 1;
  } else console.log("✓", name);
}
function verGe(a, b) {
  const pa = String(a).split(".").map(Number);
  const pbv = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pbv[i] || 0)) return true;
    if ((pa[i] || 0) < (pbv[i] || 0)) return false;
  }
  return true;
}

console.log("■ 2.8.182 一連の流れ flow_series");
ok("manifest ≥2.8.182", verGe(man.version, "2.8.182"), man.version);
ok("page-script に _noteFlowSeriesAt", /function _noteFlowSeriesAt/.test(page) && /flow_series_at/.test(page));
ok("RULES に flow_series_grasp", /flow_series_grasp/.test(page) && /flow_series_grasp/.test(rules));
{
  const m = pb.match(/export const PLAYBOOK_BUILD_V = (\d+)/);
  const v = m ? Number(m[1]) : 0;
  ok("PLAYBOOK_BUILD_V≥7 / FLOW_SERIES", v >= 7 && /PLAYBOOK_FLOW_SERIES/.test(pb), "v=" + v);
}
ok("search-audit が flow_series_ を残す", /flow_series_/.test(audit));
{
  const m = rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/);
  ok("reviewed ≥2.8.182", m && verGe(m[1], "2.8.182"), m && m[1]);
}
