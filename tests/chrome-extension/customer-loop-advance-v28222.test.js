// 実行: node tests/chrome-extension/customer-loop-advance-v28222.test.js
// v2.8.222: ループ完了→次客（loop_advance）・一括/キュー連携・台帳細原子
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");
const ledger = fs.readFileSync(path.join(__dirname, "../../app/lib/handoff-loop-ledger.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 140) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.222", /^2\.8\.(22[2-9]|2[3-9]\d|[3-9]\d{2})$/.test(mf.version), mf.version);
// 2026-11-26: 版が 2.8.310 まで進んだため、完全一致（2.8.222〜229）を「以上」の判定に直した
ok("page-script ≥2.8.222", /_AXLX_PAGE_VER = "2\.8\.(22[2-9]|2[3-9]\d|[3-9]\d{2})"/.test(ps));
ok("AUTO_RULES_REVIEWED_UP_TO ≥2.8.222", /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.(22[2-9]|2[3-9]\d|[3-9]\d{2})"/.test(rules));

console.log("\n■ 台帳");
ok("who_grasp / loop_advance 細原子", /"who_grasp"/.test(ledger) && /"loop_advance"/.test(ledger));
ok("formatLoopAdvance がある", /export function formatLoopAdvance\(/.test(ledger));

console.log("\n■ BG 一括・キュー");
ok("scrape に loopMeta 引数", /async function _scrapeAndSendRealpro\([\s\S]{0,200}loopMeta/.test(bg));
ok("series_done 後に loop_advance", /_auditStep\(_runId, "loop_advance"/.test(bg));
ok("一括開始 nextMove 明示", /_g0\.nextMove = _bi === 0/.test(bg));
ok("一括完了後 publish nextMove=外す", /nextMove: _bulkNextNm \? "リセットで空にして次のお客さんへ"/.test(bg));
ok("キュー _axlxQueueLoopMeta", /_axlxQueueLoopMeta/.test(bg));
ok("キュー scrape に loopMeta 渡し", /self\._axlxQueueLoopMeta \|\| null/.test(bg));

console.log("\n■ page / audit 通し");
ok("ready_next で loop_advance 印", /_auditStepP\(\s*"loop_advance"/.test(ps));
ok("PIN に loop_advance", /loop_who_grasp\|loop_advance\|cond_one_/.test(ps) || /loop_advance\|cond_one_/.test(ps));
ok("RULE_STEP に loop_advance", /RULE_STEP[\s\S]{0,1400}loop_advance/.test(sa));
ok("KEEP_STEP に loop_advance", /KEEP_STEP[\s\S]{0,1400}loop_advance/.test(sa));

console.log("\n■ 決まり");
ok("customer_loop_one_by_one since 2.8.222", /id: "customer_loop_one_by_one"[\s\S]{0,400}since: "2\.8\.222"/.test(rules));
ok("verify に page:loop_advance", /"page:loop_advance"/.test(rules));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
