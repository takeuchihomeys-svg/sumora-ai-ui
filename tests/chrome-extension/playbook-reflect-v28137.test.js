// 2.8.137（2026-11-20）: 手順書を拡張へ渡し、自動が「読んだ印」を点検記録に残す。
//   竹内さん「改善したのは手順書にちゃんと反映されるようになっているのか」「手順書の重要度と優先度あげる」
// 実行: node tests/chrome-extension/playbook-reflect-v28137.test.js
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const src = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (detail ? "\n      " + detail : "")); } }

console.log("■ 取り込みの道（background → content → page）");
check("content.js が axlx_learn_playbook をページへ渡す", /var PUSH_KEYS = \[[\s\S]*"axlx_learn_playbook",[\s\S]*"axlx_learn_gaps",\s*\];/.test(content));
check("page-script が axlx_learn_playbook を読む（_LEARN_NEXT_KEYS）", /var _LEARN_NEXT_KEYS = \[[\s\S]*"axlx_learn_playbook",\s*"axlx_learn_gaps",\s*\];/.test(src));
check("key が来ない呼び出しでは前の手順書を残す", /hasOwnProperty\.call\(r, "axlx_learn_playbook"\)/.test(src));
check("反映の関所（取込後）で印を残す", /try \{ _auditPlaybookSeen\(\); \} catch \(_\) \{\}/.test(src));

console.log("■ 読んだ印の中身（実際の関数を動かす）");
const fnSrc = (src.match(/function _auditPlaybookSeen\(\) \{[\s\S]*?\r?\n  \}\r?\n/) || [])[0];
const doneSrc = (src.match(/var _AXLX_RULES_DONE = \[[\s\S]*?\];/) || [])[0];
check("関数と決まりの一覧がある", !!fnSrc && !!doneSrc);
function run(pb) {
  const steps = [];
  const window = { __axlxLearnPlaybook: pb };
  const _audit = { steps };
  const _auditStepP = (k, d) => steps.push({ k, d: String(d).slice(0, 120), raw: String(d) });
  const _AXLX_PAGE_VER = manifest.version;
  // eslint-disable-next-line no-new-func
  new Function("window", "_audit", "_auditStepP", "_AXLX_PAGE_VER", doneSrc + "\n" + fnSrc + "\n_auditPlaybookSeen();")(window, _audit, _auditStepP, _AXLX_PAGE_VER);
  return steps;
}
const done = [...doneSrc.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
const pbAll = {
  version: "abcdef0123456789", rules_v: "d30a6a50",
  rules: done.map((id) => ({ id })),
  scenes: [{ steps: ["a", "b"], detail: [{}, {}] }, { steps: ["c"], detail: [{}] }],
};
const s1 = run(pbAll);
check("手順書があれば playbook_seen", s1.length === 1 && s1[0].k === "playbook_seen", JSON.stringify(s1));
check("形: v=8桁 rv 決まり=全部/全部 無い=- 手順書に無い=- 場面 手", /^v=abcdef01 rv=d30a6a50 決まり=(\d+)\/\1 無い=- 手順書に無い=- 場面=2 手=3$/.test(s1[0].d), s1[0].d);
check("120文字に収まる（点検記録で切れない）", s1[0].raw.length <= 120, String(s1[0].raw.length));

const pbOld = { ...pbAll, rules: done.slice(0, 3).map((id) => ({ id })).concat([{ id: "future_rule" }]) };
const s2 = run(pbOld);
check("手順書にあって拡張に無い決まりを出す（拡張が古い）", /無い=future_rule /.test(s2[0].d), s2[0].d);
check("拡張にあって手順書に無い決まりを先頭2つ＋残りの数で出す（手順書が古い）", new RegExp("手順書に無い=" + done[3] + "," + done[4] + ",\\+" + (done.length - 5) + " ").test(s2[0].d), s2[0].d);
check("それでも120文字に収まる", s2[0].raw.length <= 120, String(s2[0].raw.length));

const s3 = run(null);
check("手順書が届いていなければ playbook_none", s3.length === 1 && s3[0].k === "playbook_none", JSON.stringify(s3));

console.log("■ 点検記録の間引きで印・決まりの段を消さない");
const pin = (src.match(/var _PIN = \/\^\(([^)]*)\)\//) || [])[1] || "";
["playbook_", "hidden_press", "clear_stage", "clear_retry_press", "sel_one_press", "search_cursor", "search_armed", "modal_confirm", "confirm_press_ok"]
  .forEach((k) => check("_PIN に " + k, pin.split("|").includes(k)));

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
