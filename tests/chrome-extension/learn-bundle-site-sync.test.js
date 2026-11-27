// 実行: node tests/chrome-extension/learn-bundle-site-sync.test.js
// 2026-11-27 Phase 2: 拡張 ↔ API 同期・サイト別分離・rules_v 検知バグ修正の網
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../..");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8").replace(/\r\n/g, "\n");
const ct = fs.readFileSync(path.join(root, "chrome-extension/content.js"), "utf8").replace(/\r\n/g, "\n");
const ic = fs.readFileSync(path.join(root, "chrome-extension/itandi-content.js"), "utf8").replace(/\r\n/g, "\n");
const ip = fs.readFileSync(path.join(root, "chrome-extension/itandi-page-script.js"), "utf8").replace(/\r\n/g, "\n");
const bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
const sa = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8").replace(/\r\n/g, "\n");
const route = fs.readFileSync(path.join(root, "app/api/human-learn-profile/route.ts"), "utf8").replace(/\r\n/g, "\n");
const sm = fs.readFileSync(path.join(root, "app/lib/learn-bundle-scene-meta.ts"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function ok(name, c, extra) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra).slice(0, 260) : "")); }
}

console.log("■ ① background.js: scope付き版確認・rules_v検知・allBundle隔離・サイト別キー保存");
{
  const fn = bg.slice(bg.indexOf("async function _refreshLearnedBundle(force)"), bg.indexOf("return {\n      ok: true, next:"));
  ok("?touch=0 に scope= が付く", /human-learn-profile\?touch=0&scope="\s*\+\s*encodeURIComponent\(curSite\)/.test(fn));
  ok("storage.get に axlx_learn_playbook / axlx_learn_for_site / __realpro / __itandi が含まれる",
    fn.includes('"axlx_learn_playbook"') && fn.includes('"axlx_learn_playbook__realpro"') && fn.includes('"axlx_learn_playbook__itandi"'));
  ok("_rulesStale は手元の _localRulesV が空の時も検知する", /var _rulesStale = !!\(_serverRulesV && _serverRulesV !== _localRulesV\);/.test(fn));
  ok("ITANDI では allBundle を混ぜない（curSite === 'itandi' で bundle = siteBundle）",
    /if \(curSite === "itandi"\) \{\s*\/\/[^\n]*\n\s*bundle = siteBundle;/.test(fn));
  ok("realpro でも perSite.realpro があれば混載 allBundle で上書きしない",
    /if \(curSite !== "itandi" && !perSite\.realpro\)/.test(fn) && !/_mergeLearnedShots\(/.test(fn));
  ok("反対側サイトの手順書・版のずれも確認して取り残さない",
    fn.includes("var _otherSite = curSite === \"itandi\" ? \"realpro\" : \"itandi\"") && fn.includes("axlx_learn_playbook__"));
  ok("サイト別キー(__realpro / __itandi)にも保存する",
    fn.includes('"axlx_learn_playbook" + _suf') && fn.includes('"axlx_learn_next" + _suf') && fn.includes('"axlx_learn_points" + _suf'));
}

console.log("\n■ ② content.js / itandi-content.js / itandi-page-script.js / bulk-dl.js: 他サイト混入ガード & ITANDI手順書反映");
{
  ok("content.js: _realproLearnView が __realpro を優先し他サイト時は無印キーを落とす",
    /function _realproLearnView\(raw\)/.test(ct) && ct.includes('"axlx_learn_playbook__realpro"'));
  ok("itandi-content.js: _itandiLearnView が __itandi キーを無印キーへ中継する",
    /function _itandiLearnView\(raw\)/.test(ic) && ic.includes('"axlx_learn_playbook__itandi"') && ic.includes('"axlx_learn_scene_flows__itandi"'));
  ok("itandi-content.js: axlx-guide-live-flush を site=itandi で中継する",
    ic.includes('e.data.from !== "axlx-guide-live-flush"') && ic.includes('site: "itandi"'));
  ok("itandi-page-script.js: 手順書を受け取り playbook_seen / axlx-guide-live-flush / local_it_ で残す",
    ip.includes("_itAuditPlaybookSeen") && ip.includes("axlx-guide-live-flush") && ip.includes('"local_it_"') && ip.includes("_AXLX_ITANDI_PAGE_VER"));
  ok("search-audit.js: COLLAPSE_STEP が dl:send_bar_show の連打を畳み込む",
    /COLLAPSE_STEP = .*dl:send_bar_show/.test(sa));
  ok("bulk-dl.js: _withPlaybook / _readSupervisor / sort で __realpro を優先する",
    bd.includes('"axlx_learn_playbook__realpro"') && bd.includes('"axlx_learn_supervisor__realpro"') && bd.includes('"axlx_learn_points__realpro"'));
}

console.log("\n■ ③ API & scene-meta: needs_auto / playbook_rules_up_to / scene_flows");
{
  ok("route: needs_auto が isAutoMode(a.mode) を使う", /isAutoMode\(a\.mode\)/.test(route));
  ok("route: light の playbook_rules_up_to が stale 作り直し時はサイト別 rulesReviewedUpToFor を返す",
    /if \(_servedStale\)\s*\{\s*playbookRulesUpTo = rulesReviewedUpToFor\(scope\);/.test(route));
  ok("route: 長期 cron 束保護（shouldPreserveLongCronBundle）を通す", /shouldPreserveLongCronBundle\(/.test(route));
  ok("scene-meta: 夜間 cron や期限切れ時に computeLightSceneFlows で scene_flows を生成する",
    /async function computeLightSceneFlows/.test(sm) && /!light \|\| !copied\.scene_flows\?\.length/.test(sm));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
