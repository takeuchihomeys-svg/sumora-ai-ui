/**
 * 2.8.297 竹内さん「なんで手順書ちゃんと反映されないこと多いのか／連動して反映されるように／抜けている部分強化する」
 *   実測（2026-11-25）:
 *     ① 本番（古い main）が束を作り直すたび、手順書が 91件→23件へ戻った（拡張は「版が違う」とだけ見て取り直し続けた）
 *     ② 監査 #1654: 同じ待ちの段（dl:sort_gate_wait_rows 等・各49回）が120段を埋め、最後の手段で begin・bulk_pos・page_ver・playbook_seen が
 *        先頭から落ち、check-playbook-reflect が「反映されていない」と誤って読んだ
 *   ・点検の段: 繰り返す待ちは n 回にまとめる／守る段は最後の手段でも落とさない／押した記録（reset_press）はまとめない
 *   ・見える化: 手順書と拡張の版ずれは playbook_behind／本番が古い印は server_behind
 */
"use strict";
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const APP = path.join(__dirname, "..", "..", "app");
const audit = require(path.join(EXT, "search-audit.js"));
const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
const ps = fs.readFileSync(path.join(EXT, "page-script.js"), "utf8");
const auditSrc = fs.readFileSync(path.join(EXT, "search-audit.js"), "utf8");
const rules = fs.readFileSync(path.join(APP, "lib", "auto-procedure-rules.ts"), "utf8");
const route = fs.readFileSync(path.join(APP, "api", "human-learn-profile", "route.ts"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
}
const keys = (steps) => steps.map((s) => s.k);

console.log("■ ① 繰り返す待ちは n 回にまとめる（交互に並んでも）");
{
  const s = [];
  for (let i = 0; i < 60; i++) {
    audit.pushStep(s, "dl:sort_gate_wait_rows", "rows=0", 1000 + i);
    audit.pushStep(s, "dl:flow_atom_gap_after_search_rows", "rows=0", 1000 + i);
  }
  ok("120回押しても 2段（A・B）", s.length === 2, keys(s));
  ok("回数 n=60・最後の時刻 to を持つ", s[0].n === 60 && s[0].to === 1059 && s[1].n === 60, s);
  const s2 = [];
  audit.pushStep(s2, "dl:sort_gate_wait_rows", "rows=0", 1);
  audit.pushStep(s2, "dl:sort_gate_wait_rows", "rows=3", 2);
  audit.pushStep(s2, "dl:sort_gate_wait_rows", "rows=3", 3);
  ok("中身が違えば別の段（rows=0 → rows=3）・同じ中身は続けてまとめる", s2.length === 2 && s2[1].n === 2, s2);
  const s3 = [];
  for (let i = 0; i < 4; i++) audit.pushStep(s3, "reset_press", "ok", i);
  ok("押した記録（reset_press）は数を残す＝まとめない", s3.length === 4, s3.length);
  const s4 = [];
  for (let i = 0; i < 3; i++) audit.pushStep(s4, "page:playbook_seen", "v=abc", i);
  ok("守る段（playbook_seen）は1回ずつ時刻を残す", s4.length === 3, s4.length);
}

console.log("■ ② 守る段は上限を超えても落とさない（実測 #1654 の再現）");
{
  const s = [];
  audit.pushStep(s, "begin", "bulk_manual", 1);
  audit.pushStep(s, "bulk_pos", "1/3 cid=aaaa", 2);
  audit.pushStep(s, "page:page_ver", "2.8.297", 3);
  audit.pushStep(s, "page:playbook_seen", "v=abc rv=def", 4);
  // 待ちが交互ではなく「中身が毎回違う」＝まとめられない最悪ケース。残す段（KEEP）だけで 300 段積む
  for (let i = 0; i < 300; i++) audit.pushStep(s, "dl:sort_gate_wait_rows", "rows=" + i, 10 + i);
  const ks = keys(s);
  ok("上限（120）を守る", s.length <= 120, s.length);
  ok("begin が残る", ks.includes("begin"), ks.slice(0, 5));
  ok("bulk_pos が残る", ks.includes("bulk_pos"));
  ok("page:page_ver が残る", ks.includes("page:page_ver"));
  ok("page:playbook_seen が残る（check-playbook-reflect が読める）", ks.includes("page:playbook_seen"));
  ok("新しい段（末尾）は残る", s[s.length - 1].d === "rows=299", s[s.length - 1]);
  // 回の終わり
  audit.pushStep(s, "fill_done", "ok", 99999);
  for (let i = 0; i < 200; i++) audit.pushStep(s, "dl:sort_gate_wait_rows", "r2=" + i, 100000 + i);
  ok("fill_done も残る", keys(s).includes("fill_done"));
  ok("始まりの4つは先頭側に残ったまま", ["begin", "bulk_pos"].every((k) => keys(s).includes(k)));
}
console.log("■ ②b 従来の落とす順（普通の段 → 決まりの重複 → 残す段以外）は変えていない");
{
  const s = [];
  audit.pushStep(s, "begin", "x", 1);
  for (let i = 0; i < 119; i++) audit.pushStep(s, "unknown_step_" + i, "d", 2 + i); // 普通の段
  audit.pushStep(s, "page:playbook_seen", "keep", 500);
  audit.pushStep(s, "unknown_last", "d", 501);
  ok("普通の段から先に落ちる（begin・playbook_seen は残る）", keys(s).includes("begin") && keys(s).includes("page:playbook_seen") && !keys(s).includes("unknown_step_0"), keys(s).slice(0, 4));
}

console.log("■ ③ 点検が playbook_behind・server_behind を残す");
{
  const keep = eval(auditSrc.match(/var KEEP_STEP = (\/.*\/);/)[1]);
  const rule = eval(auditSrc.match(/var RULE_STEP = (\/.*\/);/)[1]);
  ok("RULE_STEP は page:playbook_behind を通す", rule.test("page:playbook_behind") && rule.test("page:playbook_seen"));
  ok("KEEP_STEP / RULE_STEP は server_behind を通す", keep.test("server_behind") && rule.test("server_behind"));
  ok("前後の段（customer_think・post_send_clear）も従来どおり", keep.test("customer_think") && keep.test("post_send_clear") && rule.test("post_send_clear"));
  ok("page-script が playbook_behind を足す（side・up・ext・両方向の差）", /_auditStepP\(\s*"playbook_behind",[\s\S]{0,400}side=[\s\S]{0,300}up=[\s\S]{0,200}ext=[\s\S]{0,200}手順書に無い=[\s\S]{0,100}拡張に無い=/.test(ps));
  ok("手順書の決まり playbook_read は playbook_behind が出たら守れていない", /id: "playbook_read"[\s\S]{0,900}mustNot: \["page:playbook_none", "page:playbook_behind"\]/.test(rules));
}

console.log("■ ④ 背景: 本番が古い印を覚えて、次の客の記録に残す");
{
  ok("learn 版確認で server_rules_up_to / playbook_rules_up_to を読む", /hj\.server_rules_up_to[\s\S]{0,300}hj\.playbook_rules_up_to/.test(bg));
  ok("axlx_server_state に保存（behind・server_behind・playbook_behind）", /axlx_server_state: \{\s*behind:[\s\S]{0,200}server_behind:[\s\S]{0,100}playbook_behind:/.test(bg));
  ok("一括ループの客ごとに server_behind を1段残す（bulk_pos の後）", bg.indexOf('"server_behind"') > bg.indexOf('_auditStep(_bulkAudit.runId, "bulk_pos"'));
  // _cmpExtVer を本物の関数のまま取り出して動かす
  const src = bg.match(/function _cmpExtVer\(a, b\) \{[\s\S]*?\n\}/)[0];
  const cmp = new Function(src + "; return _cmpExtVer;")();
  ok("_cmpExtVer: 2.8.297 > 2.8.296・2.8.1000 > 2.8.297・同じは0・空は古い", cmp("2.8.297", "2.8.296") > 0 && cmp("2.8.1000", "2.8.297") > 0 && cmp("2.8.297", "2.8.297") === 0 && cmp("", "2.8.1") < 0);
}

console.log("■ ⑤ API: 軽い版確認に、手順書を作った版と本番コードの版を載せる");
{
  ok("light の列に playbook_rules_up_to", /playbook_rules_up_to:bundle->playbook->>rules_up_to/.test(route));
  ok("応答に server_rules_up_to / server_rules_v / server_build_v / playbook_rules_up_to", /playbook_rules_up_to: playbookRulesUpTo,[\s\S]{0,400}server_rules_v: autoRulesVersion\(\),[\s\S]{0,100}server_rules_up_to: AUTO_RULES_REVIEWED_UP_TO,[\s\S]{0,100}server_build_v: PLAYBOOK_BUILD_V/.test(route));
}

console.log("■ ⑥ 版の結び（manifest == page-script == 手順書の見直し）");
{
  ok("2.8.298 で揃っている（2.8.297 の時点の版は下の比較で見る）", mf.version === "2.8.298" && /_AXLX_PAGE_VER = "2\.8\.298"/.test(ps) && /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.298"/.test(rules));
}

console.log("\n" + pass + " pass / " + fail + " fail");
process.exit(fail ? 1 : 0);
