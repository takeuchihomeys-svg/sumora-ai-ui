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

  const hLight = cacheHeaders("light");
  ok("cacheHeaders('light') は stale-while-revalidate を含まず s-maxage=30",
    /s-maxage=30/.test(hLight["Cache-Control"]) && !/stale-while-revalidate/.test(hLight["Cache-Control"]),
    hLight);

  const routeSrc = readRel("app/api/human-learn-profile/route.ts");
  ok("route.ts: touch=0 / fresh / refresh=1 が bundle_v と cacheHeaders('none') を返す",
    routeSrc.includes("bundle_v:")
    && routeSrc.includes("cacheHeaders(\"none\")")
    && routeSrc.includes("actualBundleV")
    && (routeSrc.match(/cacheHeaders\("none"\)/g) || []).length >= 4);
}

console.log("\n■ 2. syncSupervisorImproveLoop: 統括の自己矛盾（自動モード完成度 & 学習完成 & meeting.today）の同期");
{
  const bundle: Record<string, unknown> = {
    source: { rows: 120, with_ops: 800, newest_at: "2026-11-27T02:00:00Z", oldest_at: "2026-11-20T02:00:00Z" },
    bundle_reflect: { read_count: 4, read_at: "2026-11-27T02:10:00Z", auto_after: false },
    shots: {
      in_storage: 850,
      learned: {
        form: Array.from({ length: 32 }, (_, i) => ({ name: `欄${i}`, x: 0.1 + i * 0.01, y: 0.5, n: 5 })),
      },
    },
    supervisor: {
      meeting: {
        // 本番の統括は meeting.today に today を持ち、数値は全角「％」を使う
        today: [
          "自動モード完成度 38/100（土台づくり）／一連3/6・再現20％・欄×観点68％・精度31％・人間として不可",
          "完成度の残り: 一連: 束の画面位置で停止（3/6）・再現: 直書き1・欄×観点 68%（要≥70）",
          "完成度↑: 再現・反映・完走の線を満たすまで学ぶ（渡してよいにはしない）",
          "【全体】他の判断行はそのまま残す",
        ],
        evidence: [
          {
            label: "自動モード完成度",
            value: "自動モード完成度 38/100（土台づくり）／一連3/6・再現20％・欄×観点68％・精度31％・人間として不可／内訳: 一連（束→拡張→自動→効果）20/40・人間らしさの再現5/25・欄×観点10/15・精度3/10・人間として自動できるか0/10／残り: 一連: 束の画面位置で停止（3/6）・再現: 直書き1／完成度↑: 再現・反映・完走の線を満たすまで学ぶ",
            guessed: true,
          },
          { label: "学習期間・構築の細部", value: "学習期間・構築: 止=fine_avg:欄×観点の細部学習が完了線未満／次=足りない観点", guessed: true },
          { label: "学習土台点検（F番号）", value: "土台(realpro/印realpro) 33/65 ✓／欠 32", guessed: true },
          { label: "学習完成（期間・土台・つながり・一連）", value: "学習完成: 1/4 ✓／止=土台／土台 33/65 ✓／欠32／重要欠:F6_auto_after_bundle／次=重要欠 F6_auto_after_bundle", guessed: true },
          { label: "学習完成・つながり", value: "✗ 3.束の画面位置: 画面位置がゼロ", guessed: true },
        ],
        agenda: [
          { priority: 1, topic: "自動モード完成度: まず通常検索で画面位置をためる", why: "古い行（画面位置0）", decide: "画面位置をためる" },
          { priority: 1, topic: "学習完成: 画面位置を3件以上ためる", why: "古い行（画面位置0）", decide: "まず撮る" },
        ],
      },
    },
  };
  const n = syncSupervisorImproveLoop(bundle, "realpro");
  const m = (bundle.supervisor as { meeting: { today: string[]; evidence: Array<{ label: string; value: string }>; agenda: Array<{ topic: string; why: string }> } }).meeting;
  const ev = m.evidence;
  const ag = m.agenda;
  const autoEv = ev.find((e) => e.label === "自動モード完成度")?.value || "";
  const linkEv = ev.find((e) => e.label === "学習完成・つながり")?.value || "";
  const finEv = ev.find((e) => e.label === "学習完成（期間・土台・つながり・一連）")?.value || "";
  const autoAg = ag.find((a) => a.topic.startsWith("自動モード完成度"))?.why || "";
  ok("syncSupervisorImproveLoop が更新を返す", n > 0, n);
  ok("全角％の自動モード完成度が消滅せず 38→45（一連4/6・再現20％・欄×観点68％・精度31％）へ正しく同期",
    /45\/100/.test(autoEv) && /一連4\/6/.test(autoEv) && /再現20％/.test(autoEv) && /欄×観点68％/.test(autoEv) && /精度31％/.test(autoEv),
    autoEv);
  ok("meeting.today の機械計算3行が同期され、統括の通常判断行は維持される",
    m.today.some((s) => /^自動モード完成度 45\/100.*一連4\/6/.test(s))
    && m.today.some((s) => /^完成度の残り: 一連: 自動で使うで停止（4\/6）/.test(s))
    && m.today.some((s) => s === "【全体】他の判断行はそのまま残す"),
    m.today);
  ok("auto_after=false 時は solid>=30 でも学習完成・つながりが ✓ に化けず ✗ 5.自動で使う になる",
    /^✗ 5\.自動で使う/.test(linkEv),
    linkEv);
  ok("期間/土台の個別行が無い realpro 形式でも 1/4 ✓ が 1/2 ✓ に半減しない",
    /^学習完成: 1\/4 ✓/.test(finEv) && !/1\/2/.test(finEv),
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
    "chrome-extension/human-learn.js",
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
