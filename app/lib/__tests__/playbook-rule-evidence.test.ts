// 2.8.145 手順書の決まりの確かめ: 誤って「守れていない」と数えない／確かめに使う段を記録の上限で落とさない
//   実測（2026-11-20 本番 search_audits）:
//     #1551（2.8.142・120段）: 先頭が落ちて playbook_seen・cursor_one が無い → playbook_read・one_cursor を ng と数えた
//     #1546・#1547（2.8.140/141・段0）: 始まっていない回を ng と数えた
//     #1552（human_）: 人が押した検索の回を自動の決まりで ng と数えた
import * as fs from "fs";
import * as path from "path";
import {
  AUTO_RULES, AUDIT_MAX_STEPS, checkRulesInCode, judgeRulesOnAudit, verifyKeysOf, type AuditStep,
} from "../auto-procedure-rules";
import { buildPlaybook, PLAYBOOK_BUILD_V } from "../action-playbook";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("✓", name); } else { fail++; console.log("✗", name, detail === undefined ? "" : JSON.stringify(detail)); }
}
const EXT = path.join(__dirname, "../../../chrome-extension");
const read = (f: string) => fs.readFileSync(path.join(EXT, f), "utf8");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SA = require(path.join(EXT, "search-audit.js"));

const judge = (steps: AuditStep[], ver = "2.8.145") => Object.fromEntries(judgeRulesOnAudit(steps, AUTO_RULES, ver).map((j) => [j.id, j]));
const filler = (n: number, from = 1000) => Array.from({ length: n }, (_, i) => ({ k: "page:ward_pace", d: "x", at: from + i }));

console.log("■ 誤って守れていないと数えない");
{
  const empty = judge([]);
  ok("記録が空の回は全部 no_data", Object.values(empty).every((j) => j.result === "no_data"));
  // #1551 の形: 120段・begin も playbook_seen も無い
  const lost = judge([...filler(110), { k: "page:sel_one_press", d: "", at: 1 }, { k: "fill_progress", d: "n=50", at: 5000 }]);
  ok("先頭が落ちた回: playbook_read は no_data", lost.playbook_read.result === "no_data", lost.playbook_read);
  ok("先頭が落ちた回: one_cursor は no_data", lost.one_cursor.result === "no_data", lost.one_cursor);
  ok("先頭が落ちた回でも audit_keep_reason は ng（begin を落とした事そのもの）", lost.audit_keep_reason.result === "ng", lost.audit_keep_reason);
  const short = judge([{ k: "begin", d: "", at: 1 }, { k: "page:fill_start", d: "", at: 2 }]);
  ok("短い回で playbook_seen が無いのは ng のまま", short.playbook_read.result === "ng");
  ok("短い回は audit_keep_reason を確かめない", short.audit_keep_reason.result === "no_data");
}

console.log("■ 新しく確かめられる決まり");
{
  const good = judge([
    { k: "begin", d: "", at: 1 },
    { k: "page:playbook_seen", d: "v=a rv=b 決まり=20/20", at: 2 },
    { k: "page:cursor_one", d: "", at: 3 },
    { k: "page:area_all_done", d: "", at: 10 },
    { k: "page:flow_done_place", d: "", at: 11 },
    { k: "page:pet_panel_confirm", d: "", at: 15 },
    { k: "page:conditions_ready", d: "", at: 20 },
    { k: "page:flow_done_conditions", d: "", at: 21 },
    { k: "page:walk_seal_ok", d: "", at: 1000 },
    { k: "page:search_armed", d: "", at: 1500 },
    { k: "page:flow_done_search", d: "", at: 1600 },
    { k: "fill_progress", d: "n=30", at: 1700 },
  ]);
  for (const id of ["order_human", "area_before_cond", "pet_confirm", "walk_presearch", "audit_one_progress", "playbook_read", "one_cursor"]) {
    ok(`${id}: 守れた`, good[id]?.result === "ok", good[id]);
  }
  const bad = judge([
    { k: "begin", d: "", at: 1 },
    { k: "page:conditions_ready", d: "", at: 5 },
    { k: "page:area_all_done", d: "", at: 10 },
    { k: "page:flow_done_conditions", d: "", at: 11 },
    { k: "page:flow_done_place", d: "", at: 12 },
    { k: "page:pet_panel_confirm_miss", d: "", at: 15 },
    { k: "page:walk_seal_ok", d: "", at: 1000 },
    { k: "page:search_armed", d: "", at: 9000 },
    { k: "fill_progress", d: "n=10", at: 20 },
    { k: "fill_progress", d: "n=20", at: 30 },
    { k: "page:ward_btn_y_timeout", d: "", at: 40 },
    { k: "page:fallback_area", d: "", at: 60 },
  ]);
  for (const id of ["order_human", "area_before_cond", "pet_confirm", "walk_presearch", "audit_one_progress", "ward_detail_skip"]) {
    ok(`${id}: 守れていない`, bad[id]?.result === "ng", bad[id]);
  }
  const noScene = judge([{ k: "begin", d: "", at: 1 }, { k: "page:playbook_seen", d: "", at: 2 }]);
  ok("ペットの場面が無い回は pet_confirm を確かめない", noScene.pet_confirm.result === "no_data");
  ok("Y待ちが切れていない回は ward_detail_skip を確かめない", noScene.ward_detail_skip.result === "no_data");
  const skip = judge([{ k: "begin", d: "", at: 1 }, { k: "page:ward_btn_y_timeout", d: "", at: 2 }, { k: "page:ward_detail_skip", d: "", at: 3 }]);
  ok("Y待ちが切れて区で確定した回は ward_detail_skip 守れた", skip.ward_detail_skip.result === "ok");
  const old = judge([{ k: "begin", d: "", at: 1 }, { k: "fill_progress", d: "", at: 2 }, { k: "fill_progress", d: "", at: 3 }], "2.8.130");
  ok("決まりより前の版の回は no_data", old.audit_one_progress.result === "no_data");
}

console.log("■ 確かめに使う段を記録の上限で落とさない");
{
  const code = checkRulesInCode({ pageScript: read("page-script.js"), searchAudit: read("search-audit.js"), manifestJson: read("manifest.json"), bulkDl: read("bulk-dl.js"), background: read("background.js") });
  ok("コードの点検: 食い違い0", code.length === 0, code);
  const lostKeys = AUTO_RULES.flatMap((r) => verifyKeysOf(r.verify)).filter((k) => !SA.KEEP_STEP.test(k) && !SA.RULE_STEP.test(k));
  ok("verify の段は全部 KEEP_STEP か RULE_STEP", lostKeys.length === 0, lostKeys);
  const broken = checkRulesInCode({ pageScript: read("page-script.js"), searchAudit: read("search-audit.js").replace("playbook_seen|", ""), manifestJson: read("manifest.json"), bulkDl: read("bulk-dl.js"), background: read("background.js") });
  ok("RULE_STEP から段が消えたら点検で出る", broken.some((s) => s.includes("playbook_read") && s.includes("RULE_STEP")), broken);

  ok("search-audit の MAX_STEPS と同じ上限", SA.MAX_STEPS === AUDIT_MAX_STEPS, SA.MAX_STEPS);
  const list: Array<{ k: string }> = [];
  SA.pushStep(list, "begin", "", 1);
  SA.pushStep(list, "page:playbook_seen", "v=x", 2);
  SA.pushStep(list, "page:cursor_one", "", 3);
  for (let i = 0; i < 400; i++) SA.pushStep(list, "page:ward_pace", "x" + i, 10 + i);
  ok("長い回でも begin・playbook_seen・cursor_one が残る", ["begin", "page:playbook_seen", "page:cursor_one"].every((k) => list.some((s) => s.k === k)));
  const many: Array<{ k: string }> = [];
  SA.pushStep(many, "begin", "", 1);
  SA.pushStep(many, "page:playbook_seen", "", 2);
  for (let i = 0; i < 300; i++) SA.pushStep(many, "page:modal_confirm", String(i), 10 + i);
  ok("決まりの段だけで溢れても上限で止まる", many.length === SA.MAX_STEPS, many.length);
  ok("溢れた時は同じ種類の重複から落とす（playbook_seen は残る）", many.some((s) => s.k === "page:playbook_seen") && many.some((s) => s.k === "begin"));
  ok("最新の modal_confirm は残る", many[many.length - 1].k === "page:modal_confirm");
}

console.log("■ 手順書に確かめ方が載る");
{
  const pb = buildPlaybook({ generated_at: new Date().toISOString(), scene_flows: [], points: {}, opens: {} });
  ok("作り方の版 6 以上", PLAYBOOK_BUILD_V >= 6 && pb.build_v === PLAYBOOK_BUILD_V);
  const r = pb.rules.find((x) => x.id === "playbook_read");
  ok("決まりに verified_by（確かめる段）", !!r && r.verified_by.includes("page:playbook_seen"), r);
  const nVer = pb.rules.filter((x) => x.verified_by.length).length;
  ok("確かめられる決まりが半分以上", nVer * 2 >= pb.rules.length, { nVer, all: pb.rules.length });
  ok("確かめる印が無い決まりは gaps に出る", pb.gaps.some((g) => g.includes("確かめる印が無い")), pb.gaps);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
