// 6分の閉じ処理が「合図が届かず閉じた」と印を付けて閉じること（2026-11-19 平田さん 15:25 の回の再発防止）
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../../chrome-extension/background.js"), "utf8");

let fail = 0;
function ok(name, cond, detail) {
  if (cond) console.log("ok  ", name);
  else { fail++; console.log("FAIL", name, detail !== undefined ? detail : ""); }
}

ok("閉じ処理の印を返す関数がある", /function AUDIT_IDLE_CLOSE_EXTRA\(\)/.test(src));
ok("印は error_kind:idle_close", /error_kind:\s*"idle_close"/.test(src));
ok("印の文に『fill-done』が入る", /idle_close:[^"]*fill-done/.test(src));

// 閉じ処理の2か所が印を使い、error:null の閉じ方が残っていないこと
const closeCalls = src.match(/_auditFinish\(_rid, \{ error: null \}\)/g) || [];
ok("error:null で閉じる呼び出しが残っていない（6分の閉じ処理）", closeCalls.length === 0, closeCalls.length);
const extraCalls = src.match(/_auditFinish\(_rid, AUDIT_IDLE_CLOSE_EXTRA\(\)\)/g) || [];
ok("6分の閉じ処理2か所が印を使う", extraCalls.length === 2, extraCalls.length);

// 印の値をそのまま評価して形を確かめる
const m = src.match(/function AUDIT_IDLE_CLOSE_EXTRA\(\) \{\s*return (\{[^}]*\});\s*\}/);
if (m) {
  const obj = Function("return " + m[1])();
  ok("印の値: error は文字列・error_kind は idle_close", typeof obj.error === "string" && obj.error_kind === "idle_close", obj);
} else {
  ok("印の値を読める", false);
}

// サーバー側の分類: idle_close が ERROR_IDLE_CLOSE になり、「完走」にならない（error_kind が最優先）
const check = fs.readFileSync(path.join(__dirname, "../../app/lib/search-audit-check.ts"), "utf8");
ok("点検は error_kind を最優先で読む", /const kind = a\.error_kind \|\| classifyError\(a\.error\);/.test(check));

console.log(fail ? `\n${fail} 件失敗` : "\nすべて OK");
process.exit(fail ? 1 : 0);
