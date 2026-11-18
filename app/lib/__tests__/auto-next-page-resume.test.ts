// app/lib/__tests__/auto-next-page-resume.test.ts
// 2026-11-18 実測（human_motion_learn・直近2日・realpro）:
//   「左の次｜td.pager」を押した3回とも 2〜6秒後に録画の ring_empty が出た＝ページ全体の読み直し。
//   自動の続き（_autoNextPageThenRestart の _waitRows）はメモリ上なので読み直しで消え、
//   直近2日、自動が次を押した後に印刷用PDFを送った例は0。
//
// 直し（bulk-dl.js 2.8.104）:
//   ① 次を押す前に session へ axlx_auto_next_page（頁・回数・累計・お客さん・時刻）を置く
//   ② 読み直し無しで続けられた時だけ印を消す。前の頁の行がまだ残っている間は続けない（前の頁を押し直さない）
//   ③ start() の Case E が印を読んで、2分以内・同じお客さんなら続きから押す（並べ替え直さない）
//   ④ ⏹ 止める・案内モードの止めでも印を消す
//
// 実行: npx tsx app/lib/__tests__/auto-next-page-resume.test.ts
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");
const src = fs.readFileSync(path.join(root, "chrome-extension", "bulk-dl.js"), "utf8");

const fnBody = (name: string): string => {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  const j = src.indexOf("\n  function ", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
};

console.log("次ページの読み直し後の続き");
const next = fnBody("_autoNextPageThenRestart");
ok("_autoNextPageThenRestart がある", next.length > 0);
const setAt = next.indexOf('axlx_auto_next_page: {');
const clickAt = next.indexOf("btn.click()");
ok("次を押す前に続きの印を置く", setAt > 0 && clickAt > 0 && setAt < clickAt, { setAt, clickAt });
for (const f of ["page:", "tries:", "total:", "customerId:", "at:"]) ok("印に " + f + " がある", next.slice(setAt, setAt + 400).includes(f));
ok("前の頁の行を控える", /_oldRowBtns\s*=\s*tracked\.map/.test(next));
ok("前の行が残る間は続けない", /stillOld/.test(next) && /auto_next_wait_reload/.test(next));
const stillAt = next.indexOf("if (stillOld)");
const removeAt = next.indexOf('chrome.storage.session.remove("axlx_auto_next_page")');
ok("印を消すのは前の行が消えた後", stillAt > 0 && removeAt > stillAt, { stillAt, removeAt });

const stop = fnBody("stopAutoPdfs");
ok("⏹ 止めるで印を消す", stop.includes('remove("axlx_auto_next_page")'));
const guide = fnBody("_guideBlocksAuto");
ok("案内モードの止めで印を消す", guide.includes('remove("axlx_auto_next_page")'));

const start = fnBody("start");
const caseE = start.slice(start.indexOf("Case E"));
ok("start() に Case E がある", start.includes("Case E") && caseE.includes('get(["axlx_auto_next_page"]'));
ok("Case E は読んだら印を消す（二度始めない）", caseE.includes('remove("axlx_auto_next_page")'));
ok("Case E は古い印（2分超）で続けない", /age > 120000/.test(caseE));
ok("Case E はお客さんが変わったら続けない", /customer_changed/.test(caseE));
ok("Case E は頁・回数・累計を戻す", /_autoPdfPage = Number\(s\.page\)/.test(caseE) && /_autoNextPageTries = Number\(s\.tries\)/.test(caseE) && /_autoPdfTotalSent = Number\(s\.total\)/.test(caseE));
ok("Case E は並べ替え直さない", /_adSortDone = true/.test(caseE));
ok("Case E は continuePages で続ける", /_startAutoPressAfterLook\([^)]*continuePages:\s*true/.test(caseE));
ok("Case E は Case A と二重に始めない", /_pendingAutoSendDispatched = true/.test(caseE) && !/_autoSendArmed = true/.test(caseE));
ok("Case E は監査に残す", /_tmark\("auto_next_page_resume"/.test(caseE));

const finish = fnBody("_autoFinish");
const batchDone = fnBody("_sendBatchDone");
ok("_autoFinish の完了合図に点検（段の記録）を載せる", /audit:\s*_auditResult\(/.test(finish) && !/audit:\s*null/.test(finish));
ok("_sendBatchDone の完了合図に点検を載せる", /audit:\s*_auditResult\(/.test(batchDone) && !/audit:\s*null/.test(batchDone));

// 続きの判定を同じ規則で小さく再現（前の行が残っている間は続けない）
const decide = (oldConnected: boolean[], triesLeft: number) => {
  const stillOld = oldConnected.some(Boolean);
  if (stillOld) return triesLeft > 0 ? "retry" : "leave_to_reload";
  return "continue";
};
ok("読み直し前（前の行あり）→ 待つ", decide([true, true], 3) === "retry");
ok("尽きても前の行あり → 読み直し後に任せる", decide([true], 0) === "leave_to_reload");
ok("AJAXで描き直し（前の行なし）→ その場で続ける", decide([false, false], 3) === "continue");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension", "manifest.json"), "utf8"));
ok("manifest 2.8.104 以上", (() => { const p = String(manifest.version).split(".").map(Number); return p[0] > 2 || (p[0] === 2 && (p[1] > 8 || (p[1] === 8 && p[2] >= 104))); })(), manifest.version);

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
