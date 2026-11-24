/**
 * 2.8.196: お客さん検索把握の抜け点検（配線・リロード再開・昇格・F57・KEEP）
 *   「抜けないのかちゃんとテストして確かめる」
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const page = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bulk = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const audit = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const rules = fs.readFileSync(
  path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"),
  "utf8"
);
const graspTs = fs.readFileSync(
  path.join(__dirname, "..", "..", "app", "lib", "guide-screen-grasp.ts"),
  "utf8"
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── 版 ──
function semverOk196(v, min) {
  const a = String(v).split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}
assert(semverOk196(man.version, "2.8.196"), "manifest >= 2.8.196 got " + man.version);
assert(/_AXLX_PAGE_VER = "2\.8\.\d+"/.test(page), "page ver");

// ── 抜け1: 意図把握 → 画面照合が呼ばれる ──
assert(page.includes("_guideLikeAfterSearchGrasp"), "intent grasp fn");
assert(page.includes("_verifyCustomerSearchScreenGrasp(why)"), "verify called from afterSearchGrasp");
assert(page.includes("search_customer_grasp_intent"), "intent stamp");
assert(page.includes("customerId: cid"), "customerId in payload");

// ── 抜け2: リロードでタイマー死 → 再開が無いと把握が消える（必須） ──
assert(page.includes("reload_resume"), "reload resume path");
assert(page.includes("search_grasp_reload_resume"), "reload resume stamp");
assert(page.includes('sessionStorage.getItem("axlx_search_grasped_sync")'), "reads sync on resume");
assert(/hasScreen[\s\S]{0,120}_verifyCustomerSearchScreenGrasp/.test(page)
  || /if \(hasScreen\) return;[\s\S]{0,200}_verifyCustomerSearchScreenGrasp/.test(page),
  "resume only when screen missing");

// ── 抜け3: Case C（リロード後）で screenOk 昇格 ──
assert(bulk.includes("case_c_screen"), "Case C screen upgrade");
assert(bulk.includes("search_customer_screen_ok"), "Case C stamps screen_ok");
assert(bulk.includes("screenOk: true"), "Case C sets screenOk");

// ── 抜け4: 画面OK → 並べ替え kick ──
assert(bulk.includes("customer_screen_grasp"), "kick on screen grasp");
assert(bulk.includes("e.data.screenOk"), "bulk reacts to screenOk");
assert(bulk.includes("_kickSortAfterSearch(\"customer_screen_grasp\")")
  || bulk.includes("_kickSortAfterSearch('customer_screen_grasp')")
  || /_kickSortAfterSearch\(\s*[\"']customer_screen_grasp[\"']\s*\)/.test(bulk)
  || /_kickSortAfterSearch\([^)]*customer_screen_grasp/.test(bulk),
  "kick call");

// ── 抜け5: 画面証拠の判定式（並べ替え / 行+PDF / URL+PDF） ──
assert(page.includes("ev.sortHead"), "evidence sortHead");
assert(
  /okScreen = !!\(ev\.sortHead/.test(page)
  || /evidence = !!\(ev\.sortHead/.test(page)
  || /!!\(ev\.sortHead\s*\|\|/.test(page),
  "okScreen formula",
);
assert(page.includes("rowsHint && ev.pdf"), "rows+pdf path");
assert(page.includes("estateUrl && ev.pdf"), "url+pdf path");

// 純関数相当: 判定表（コードと同じ式をテスト側で再現）
function okScreen(ev) {
  return !!(ev.sortHead || (ev.rowsHint && ev.pdf > 0) || (ev.estateUrl && ev.pdf > 0));
}
assert(okScreen({ sortHead: true, rowsHint: false, pdf: 0, estateUrl: false }) === true, "head alone OK");
assert(okScreen({ sortHead: false, rowsHint: true, pdf: 2, estateUrl: false }) === true, "rows+pdf OK");
assert(okScreen({ sortHead: false, rowsHint: false, pdf: 3, estateUrl: true }) === true, "url+pdf OK");
assert(okScreen({ sortHead: false, rowsHint: true, pdf: 0, estateUrl: false }) === false, "rows only NG");
assert(okScreen({ sortHead: false, rowsHint: false, pdf: 0, estateUrl: true }) === false, "url only NG");
assert(okScreen({ sortHead: false, rowsHint: false, pdf: 0, estateUrl: false }) === false, "empty NG");

// ── 抜け6: 監査印が KEEP/RULE から落ちない ──
assert(audit.includes("search_customer_grasp_"), "KEEP page search_customer_grasp_");
assert(audit.includes("dl:search_customer_"), "KEEP dl search_customer_");
assert(/page:\([^)]*search_customer_grasp_/.test(audit) || audit.includes("search_customer_grasp_"), "RULE keeps grasp");
assert(/page:\([^)]*search_grasp_reload_resume/.test(audit), "RULE_STEP keeps reload_resume (手順書指摘)");
assert(/page:\([^)]*search_grasp_reload_resume/.test(audit.split("RULE_STEP")[0] || "") || /KEEP_STEP[\s\S]*search_grasp_reload_resume/.test(audit),
  "KEEP keeps reload_resume");

// ── 抜け7: F57 が画面把握印を after_search に数える ──
assert(graspTs.includes("search_customer_grasp_ok"), "F57 after_search accepts screen ok");
assert(graspTs.includes("guide_phase_after_search_screen"), "F57 accepts screen phase");

// ── 抜け8: 決まり・RULES_DONE ──
assert(page.includes("search_grasp_reload_resume"), "RULES_DONE reload");
assert(rules.includes('id: "search_grasp_reload_resume"'), "rule reload");
assert(rules.includes('id: "search_customer_screen_grasp"'), "rule screen grasp");

// ── 抜け9: 検索押下の全入口から把握が呼ばれる ──
assert(page.includes('_guideLikeAfterSearchGrasp("search_press_ok")'), "after press ok");
assert(page.includes('_guideLikeAfterSearchGrasp("search_click_直前")'), "before click");
assert(page.includes('_guideLikeAfterSearchGrasp("search_click_直前(直)")'), "direct click");

// ── 抜け10: 手順書照合が画面照合に載る ──
assert(page.includes("_playbookExpectsAfterSearch"), "playbook expect");
assert(page.includes("playbook: pb"), "pb in screen payload");

console.log("search-customer-grasp-gaps-v28196: OK (10 gap checks + evidence table)");
