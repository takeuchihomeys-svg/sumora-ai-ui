/**
 * 2026-11-27: 改善・手順書・学習結果が確実に本番→DB→拡張→自動検索へ反映され続ける「仕組み」の総合検証テスト
 * 実行: npx tsx app/lib/__tests__/reflect-mechanism-hardening.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { execFileSync } from "node:child_process";
import { cacheHeaders, bundleVersionParam } from "../human-learn-profile-guard";
import { syncSupervisorImproveLoop } from "../learn-bundle-preserve";
import { AUTO_RULES, AUTO_RULES_REVIEWED_UP_TO, checkRulesInCode } from "../auto-procedure-rules";
import { ITANDI_AUTO_RULES, ITANDI_RULES_REVIEWED_UP_TO, checkItandiRulesInCode } from "../auto-itandi-rules";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail === undefined ? "" : " :: " + JSON.stringify(detail))); }
}

const ROOT = path.join(__dirname, "../../..");
function readRel(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

console.log("■ 1. CDN キャッシュ完全バイパスヘッダ & 版クエリ構築");
{
  const hNone = cacheHeaders("none");
  ok("cacheHeaders('none') は no-store, no-cache, must-revalidate",
    /no-store/.test(hNone["Cache-Control"]) && /no-cache/.test(hNone["Cache-Control"]) && /must-revalidate/.test(hNone["Cache-Control"]),
    hNone);
  ok("bundleVersionParam({generated_at, rules_v, build_v}) が安定した版文字列を返す",
    bundleVersionParam({ generated_at: "2026-11-27T01:23:45Z", playbook_rules_v: "abcd1234", playbook_build_v: 19 }) === "2026-11-27T01:23:45Z_abcd1234_19",
    bundleVersionParam({ generated_at: "2026-11-27T01:23:45Z", playbook_rules_v: "abcd1234", playbook_build_v: 19 }));
  ok("bundleVersionParam(null) がクラッシュせず 0_0_0 を返す", bundleVersionParam(null) === "0_0_0");

  const routeSrc = readRel("app/api/human-learn-profile/route.ts");
  ok("route.ts: touch=0 が bundle_v を返す", routeSrc.includes("bundle_v:"));
  ok("route.ts: forceFresh || playbookRefreshed || 版不一致時に cacheHeaders('none') を返す",
    routeSrc.includes("cacheHeaders(\"none\")") && routeSrc.includes("actualBundleV"));
}

console.log("\n■ 2. syncSupervisorImproveLoop: 統括の自己矛盾（自動モード完成度 & 学習完成）の同期");
{
  const bundle: Record<string, unknown> = {
    source: { rows: 120, with_ops: 800, newest_at: "2026-11-27T02:00:00Z", oldest_at: "2026-11-20T02:00:00Z" },
    bundle_reflect: { read_count: 4, read_at: "2026-11-27T02:10:00Z", auto_after: true },
    shots: {
      in_storage: 850,
      learned: {
        form: [
          { name: "賃料", x: 0.1, y: 0.5, n: 12 },
          { name: "rental_cost1", x: 0.1, y: 0.5, n: 6 },
          { name: "間取り", x: 0.2, y: 0.5, n: 5 },
          { name: "所在地絞り込み＋", x: 0.1, y: 0.3, n: 4 },
        ],
      },
    },
    supervisor: {
      meeting: {
        evidence: [
          { label: "自動モード完成度", value: "自動モード完成度 30/100／人間らしさの再現40%／欄×観点35%／精度50%（画面位置の土台がまだゼロ）", guessed: true },
          { label: "学習完成（期間・土台・つながり・一連）", value: "つながり=画面位置がゼロ・未完", guessed: true },
          { label: "学習完成・つながり", value: "0件（画面位置がゼロ）", guessed: true },
        ],
        agenda: [
          { priority: 1, topic: "自動モード完成度: まず通常検索で画面位置をためる", why: "古い行（画面位置0）", decide: "画面位置をためる" },
          { priority: 1, topic: "学習完成: 画面位置を3件以上ためる", why: "古い行（画面位置0）", decide: "まず撮る" },
        ],
      },
    },
  };
  const n = syncSupervisorImproveLoop(bundle, "realpro");
  const ev = (bundle.supervisor as { meeting: { evidence: Array<{ label: string; value: string }> } }).meeting.evidence;
  const ag = (bundle.supervisor as { meeting: { agenda: Array<{ topic: string; why: string }> } }).meeting.agenda;
  const autoEv = ev.find((e) => e.label === "自動モード完成度")?.value || "";
  const finEv = ev.find((e) => e.label === "学習完成（期間・土台・つながり・一連）")?.value || "";
  const autoAg = ag.find((a) => a.topic.startsWith("自動モード完成度"))?.why || "";
  ok("syncSupervisorImproveLoop が更新を返す", n > 0, n);
  ok("自動モード完成度 から「まだゼロ」自己矛盾が消え、実測値に同期する",
    !/まだゼロ/.test(autoEv) && /[%％]/.test(autoEv) && !/再現\?/.test(autoEv),
    autoEv);
  ok("学習完成（期間・土台・つながり・一連）が画面位置ゼロ誤記から更新される",
    !/画面位置がゼロ/.test(finEv) && finEv.length > 0,
    finEv);
  ok("agenda の自動モード完成度理由も最新化される",
    !/古い行（画面位置0）/.test(autoAg) && autoAg.length > 0,
    autoAg);
}

console.log("\n■ 3. リアプロ・ITANDI 決まり正本 + 拡張版数一致 + 構文無欠チェック");
{
  const manifestJson = readRel("chrome-extension/manifest.json");
  const manifestVer = String(JSON.parse(manifestJson).version);
  const pageScript = readRel("chrome-extension/page-script.js");
  const searchAudit = readRel("chrome-extension/search-audit.js");
  const bulkDl = readRel("chrome-extension/bulk-dl.js");
  const background = readRel("chrome-extension/background.js");
  const itandiPage = readRel("chrome-extension/itandi-page-script.js");
  const itandiBulk = readRel("chrome-extension/itandi-bulk-dl.js");

  ok("新リアプロ決まり 2本が AUTO_RULES に存在する",
    AUTO_RULES.some((r) => r.id === "learn_reflect_before_reset") && AUTO_RULES.some((r) => r.id === "notify_done_clears_queue"));
  ok("新ITANDI決まり 3本が ITANDI_AUTO_RULES に存在する",
    ITANDI_AUTO_RULES.some((r) => r.id === "it_learn_reflect_gate")
    && ITANDI_AUTO_RULES.some((r) => r.id === "it_learn_aim_pointer")
    && ITANDI_AUTO_RULES.some((r) => r.id === "it_serial_numeric_input"));

  const rpIssues = checkRulesInCode({ pageScript, searchAudit, manifestJson, bulkDl, background });
  ok("checkRulesInCode(リアプロ正本・全ファイル): 不備 0件", rpIssues.length === 0, rpIssues);

  const itIssues = checkItandiRulesInCode({ itandiPage, itandiBulk, manifestVersion: manifestVer, searchAudit });
  ok("checkItandiRulesInCode(ITANDI正本・全ファイル): 不備 0件", itIssues.length === 0, itIssues);

  ok("版が全箇所で揃っている (manifest == AUTO_RULES_REVIEWED_UP_TO == ITANDI_RULES_REVIEWED_UP_TO)",
    manifestVer === AUTO_RULES_REVIEWED_UP_TO && manifestVer === ITANDI_RULES_REVIEWED_UP_TO,
    { manifestVer, AUTO_RULES_REVIEWED_UP_TO, ITANDI_RULES_REVIEWED_UP_TO });

  // 編集した全 JS ファイルが構文エラーなく parse できること（カッコ閉じズレ等を即検知）
  const jsFiles = [
    "chrome-extension/background.js",
    "chrome-extension/content.js",
    "chrome-extension/itandi-content.js",
    "chrome-extension/itandi-page-script.js",
    "chrome-extension/learn-refresh-gate.js",
    "chrome-extension/page-script.js",
    "chrome-extension/pointer-ui.js",
    "chrome-extension/popup.js",
    "chrome-extension/search-audit.js",
    "chrome-extension/underbar.js",
  ];
  for (const jf of jsFiles) {
    let parseOk = true;
    let errMsg = "";
    const src = readRel(jf);
    try {
      if (jf.endsWith("background.js")) {
        execFileSync(process.execPath, ["--input-type=module", "--check"], { input: src, stdio: ["pipe", "pipe", "pipe"] });
      } else {
        new vm.Script(src, { filename: jf });
      }
    } catch (e) {
      parseOk = false;
      errMsg = e instanceof Error ? e.message : String(e);
    }
    ok(`JS構文検証: ${jf}`, parseOk, errMsg);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
