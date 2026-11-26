// 2.8.310: 版の確認（touch=0）の間隔を効かせる・取り直しの計測を残す・版の確認に「渡す時の版」を使う
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8");
const page = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
const itRules = fs.readFileSync(path.join(root, "app/lib/auto-itandi-rules.ts"), "utf8");
const itPage = fs.readFileSync(path.join(root, "chrome-extension/itandi-page-script.js"), "utf8");
const route = fs.readFileSync(path.join(root, "app/api/human-learn-profile/route.ts"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  OK " + n); } else { fail++; console.log("  NG " + n); } };

// 1. 確認間隔が実際に使われる（2.8.309 まで計算だけで未使用だった）
const headFn = bg.slice(bg.indexOf("async function _refreshLearnedBundle(force)"), bg.indexOf("async function _refreshLearnedBundle(force)") + 9000);
const ttlAt = headFn.indexOf("_headCheckAt > 0 && _headAge < _checkMs");
const fetchAt = headFn.indexOf('"/api/human-learn-profile?touch=0');
ok("版の確認の前に確認間隔（_checkMs）を見て、内なら飛ばす", ttlAt > 0 && fetchAt > ttlAt);
ok("飛ばした時は skipped=head_recent で返す", /skipped: "head_recent"/.test(headFn));
ok("TTL は強制（!force の内側）だけ・強制の経路は見ない", /if \(!force\) \{[\s\S]{0,1600}_headCheckAt > 0 && _headAge < _checkMs/.test(headFn));
ok("時計を進めるのは「同じ版・取り直し無し」の時だけ", /if \(!_rulesStale && hv && hv === lastVer\) _headCheckAt = Date\.now\(\);/.test(bg));
ok("_headCheckAt は宣言されている（メモリのみ）", /var _headCheckAt = 0;/.test(bg));

// 2. ページ側: 関所の版確認に経過ミリ秒を残す
const t0 = page.indexOf("var _lrT0 = Date.now();");
ok("関所の版確認の開始時刻を取る", t0 > 0);
ok("task_api_refresh_res に経過ミリ秒を付ける", /\(Date\.now\(\) - _lrT0\) \+ "ms "/.test(page));
ok("task_api_refresh_res の監査キーは変えていない（KEEP_STEP を保つ）", /"task_api_refresh_res",/.test(page));

// 3. 版の一致（manifest・realproページ・itandiページ・両サイトの見直し印が一致し 2.8.310 以上）
function cmpVer(a, b) {
  const pa = String(a || "").split(".").map((n) => Number(n) || 0);
  const pb = String(b || "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
const pageV = (page.match(/var _AXLX_PAGE_VER = "([^"]+)";/) || [])[1] || "";
const itPageV = (itPage.match(/var _AXLX_ITANDI_PAGE_VER = "([^"]+)";/) || [])[1] || "";
const upToV = (rules.match(/export const AUTO_RULES_REVIEWED_UP_TO = "([^"]+)";/) || [])[1] || "";
const itUpToV = (itRules.match(/export const ITANDI_RULES_REVIEWED_UP_TO = "([^"]+)";/) || [])[1] || "";
ok("manifest が 2.8.310 以上", cmpVer(manifest.version, "2.8.310") >= 0);
ok("リアルプロ・ITANDI ページの版が manifest と一致", pageV === manifest.version && itPageV === manifest.version);
ok("決まりの見直し印（両サイト）が manifest と一致", upToV === manifest.version && itUpToV === manifest.version);

// 4. サーバー: 軽い確認は「渡す時の版」を返す（DB の古い版をそのまま返さない）
ok("軽い確認の版は servedPlaybookRulesV を通す", /playbookRulesV = servedPlaybookRulesV\(dbPb, \{ rules_v: rulesVersionFor\(scope\), build_v: PLAYBOOK_BUILD_V \}\)\.rules_v;/.test(route));
ok("軽い確認の取る列に build_v がある", /playbook_build_v:bundle->playbook->>build_v/.test(route));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
