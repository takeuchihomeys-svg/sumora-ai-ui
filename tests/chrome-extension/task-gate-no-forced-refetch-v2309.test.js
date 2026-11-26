// 2.8.309: タスク切替の関所が「いつも強制の重い取り直し」をしない
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8");
const popup = fs.readFileSync(path.join(root, "chrome-extension/popup.js"), "utf8");
const content = fs.readFileSync(path.join(root, "chrome-extension/content.js"), "utf8");
const page = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
const audit = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  OK " + n); } else { fail++; console.log("  NG " + n); } };

const i = bg.indexOf('msg.type === "axlx-learn-refresh"');
const h = bg.slice(i, i + 700);
ok("受け口: 強制は popup_open / boot_need の時だけ", /msg\.force === true && \(msg\.src === "popup_open" \|\| msg\.src === "boot_need"\)/.test(h));
ok("受け口: それ以外は gate 判定（_learnRefreshForAutofill）", /: _learnRefreshForAutofill\(/.test(h));
ok("受け口: 無条件の _refreshLearnedBundleQueued(true) だけの行が残っていない", !/axlx-learn-refresh"\) \{ _refreshLearnedBundleQueued\(true\)/.test(bg));
ok("popup を開いた時は src=popup_open を付ける", /force: true, src: "popup_open"/.test(popup));
ok("ページ起動の取込は src=boot_need を付ける", /force: true, src: "boot_need"/.test(content));
ok("ページ側（関所）は src を付けない＝gate 判定に回る", /type: "axlx-learn-refresh", force: !!force(?:, site: "realpro")? \}/.test(page) && !/axlx-page-learn-refresh"[^}\n]*\bsrc\s*:/.test(page));
ok("関所の結果は監査に残す（保持）", /page:task_api_refresh_res\|page:task_transition_gate/.test(audit));
ok("手順書に決まりがある（since 2.8.309・marker）", /id: "task_gate_no_forced_refetch"[\s\S]{0,2500}since: "2\.8\.309"[\s\S]{0,200}marker: 'src === "boot_need"'/.test(rules));
ok("_AXLX_RULES_DONE に載っている", /"task_gate_no_forced_refetch"/.test(page));
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);