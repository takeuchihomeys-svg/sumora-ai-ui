// 実行: node tests/chrome-extension/aix-same-fix-v2691.test.js
// 2026-11-11 竹内さん「AIXもーどもなっているかな」
//
//   AIXモードの検索は **手で押すのと同じ道**を通る（autofill-btn の onclick → postMessage → page-script.js の fillRealpro）。
//   → 「探し方・展開・止まったら検索を押す・検索ボタン2か所の区別」は全部 AIX にも効く。
//   ここでは「AIX が同じ道を通ること」と「その道に修正が入っていること」を固定する。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const pp = read("popup.js"), ps = read("page-script.js"), ct = read("content.js"), bd = read("bulk-dl.js");

console.log("■ ① AIX は「手で押すのと同じ道」を通る");
{
  // 2.8.155 以降: AIX は条件画面でボタン待ち（_maybeAiCustomerAutoSearch は押さずに案内だけ）。
  //   押されたら autofill-btn の同じ onclick に ai_customer の印を付けて同じ道へ入る
  ok("AIX は autofill-btn の同じ onclick に ai_customer の印を付けて入る（ボタン待ち・2.8.155）",
    /if \(_aiCustomerModeOn && !isAutomated\) \{\s*try \{ autofillBtn\.dataset\.ai_customer = "1"; \} catch/.test(pp)
    && /function _maybeAiCustomerAutoSearch\(btn, customer, site\)/.test(pp));
  ok("その道は autofill-btn.onclick → postMessage（autofill）", /from: "aixlinx-underbar",\s*action: "autofill"/.test(pp));
  ok("postMessage を content.js が page-script へ渡す", /from: "aixlinx-fill", conditions/.test(ct));
  ok("page-script が fillRealpro で受ける", /function fillRealpro\(cond\)/.test(ps));
}

console.log("\n■ ② AIX でも自動押下（1件ずつ）が開く");
{
  ok("AIX（aiMode）でも自動押下を開く", /chosen && \(!!s\.aixMode \|\| !!s\.aiMode\)/.test(bd));
  ok("AIX も読み直しの対象", /"aixMode", "autoModeAt", "aiMode"/.test(bd));
  ok("AIX は案内を OFF にする（光らせず自動で押す）", /aiMode/.test(read("realpro-guide.js")));
}

console.log("\n■ ③ その道に今回の修正が入っている（AIX も恩恵を受ける）");
{
  ok("探し方: 文字のノードからたどる（_textMatches）", /function _textMatches\(texts, sel\)/.test(ps));
  ok("展開: 閉じた欄を開く（_ensureFieldVisible）", /function _ensureFieldVisible\(el, name, maxMs\)/.test(ps));
  // 旧 stall_recover_search は「完走優先」（統括仕組み⑫）で stall_complete_search に置き換わった（止まったら検索を押す動きは残っている）
  ok("止まったら検索を押す（stall_complete_search → clickSearch）", /_auditStepP\('stall_complete_search'[^\n]*\n\s*try \{ clickSearch\(\); \}/.test(ps));
  ok("検索ボタン2か所の区別（which）", /which: _inModal\(btn\)/.test(ps));
  // 旧 gate_stop_area は gate_stop_basic（場所・間取り・敷礼の関所）に統合された。場所は hard 扱いのまま
  ok("場所が未完了なら止める（gate_stop_basic・場所は hard 扱い）", /s\.indexOf\('場所'\) === 0[^\n]*\n\s*\}\);\s*if \(_hardGate\)[\s\S]{0,2500}_auditStepP\('gate_stop_basic'/.test(ps));
  ok("区はコードで探す（ward_by_code）", /_auditStepP\('ward_by_code'/.test(ps));
}

console.log("\n■ ④ AIX でも「止まらない」ように見張りが効く");
{
  ok("AIX も同じ fillRealpro の中で見張りが動く", /_watchdogTimer = setTimeout/.test(ps));
  ok("無進捗の見張りも同じ", /window\.__axStallWatch = setInterval/.test(ps));
  ok("AIX も点検（searchAudit）を送る＝原因を追える", /searchAudit: b \|\| aiMode/.test(read("mode-core.js")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
