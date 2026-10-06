// 実行: node tests/chrome-extension/child-profile-v2578.test.js
// 2026-10-06 v2.5.78（⑯）1人のお客様の2つ目の探し物（子の行・ゆいと（物置）: profile_label=物置・parent_customer_id=親・会話と line_user_id なし）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const pp = read("popup.js"), bg = read("background.js");
ok("一覧: 子は別のお客様として出る（API の is_linked が親の会話で true・名前は「ゆいと（物置）」・子の条件で検索）", /is_linked: convMap\.has\(c\.id\) \|\| \(!!c\.parent_customer_id && convMap\.has\(c\.parent_customer_id\)\)/.test(fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "property-customers", "route.ts"), "utf8")));
ok("今のお客様は子の id のまま（current_customer_id）・子の時だけ親の会話を current_conversation_id に", /current_customer_id: customer\.id \|\| null,/.test(pp) && /current_conversation_id: \(customer\.parent_customer_id && customer\.linked_conversation && customer\.linked_conversation\.id\) \? String\(customer\.linked_conversation\.id\) : null,/.test(pp));
ok("送る時（callMergeApi）: 送る相手が今の子なら親の会話を付ける（他のお客様には付けない）", /String\(_cc\.current_customer_id\) === String\(payload\.property_customer_id\)\) payload = \{ \.\.\.payload, conversation_id: String\(_cc\.current_conversation_id\) \}/.test(bg));
ok("拡張は line_user_id でお客様を引かない（子は line_user_id が空＝取り違えない）", !/line_user_id/.test(pp + bg + read("bulk-dl.js") + read("itandi-bulk-dl.js") + read("realpro-guide.js")));
ok("案内の送付済み・建物の印は今のお客様（子）の id で聞く＝サーバーが子＋親で答える", /type: "axlx-guide-sent-rooms", customerId: session\.customerId/.test(read("realpro-guide.js")) && /type: "axlx-guide-sent-check", customerId: session\.customerId/.test(read("realpro-guide.js")));
const mf = JSON.parse(read("manifest.json"));
ok("manifest の版 2.5.78", mf.version === "2.5.78");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
