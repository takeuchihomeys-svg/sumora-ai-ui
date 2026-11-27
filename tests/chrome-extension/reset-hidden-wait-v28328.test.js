// 2.8.328（2026-11-27 竹内さん「ちゃんとリセットがでるようにして」→ 選択「見えるまで待って知らせる」・設計知見 67da6f24）:
//   前に出してもリアプロのタブが見えない時は、リセットを押さずに待つ（通知と枠で知らせる・10分で止める）。構造と順番を見る。
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8").replace(/\r\n/g, "\n");
const dl = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " :: " + d : "")); } }
function body(src, name) {
  const m = new RegExp("\\n(async )?function " + name + "\\(").exec(src);
  if (!m) return "";
  const end = src.indexOf("\n}\n", m.index + 1);
  return end < 0 ? "" : src.slice(m.index + 1, end + 3);
}

const post = body(bg, "_postSendResetRealpro");
const ins = body(bg, "_resetWithInsurance");
const wait = body(bg, "_waitRealproVisible");
ok("見えるまで待つ関数（_waitRealproVisible）がある", wait.length > 0);

// 順番: 前に出す → まだ hidden なら待つ → その後で押す（executeScript の __axlxResetPressP）
const iFront = post.indexOf("_bringRealproTabFront(_tab, _ridFront");
const iHidden = post.indexOf('if (_pv1 && _pv1.vis === "hidden")');
const iWait = post.indexOf("_waitRealproVisible(_tab, customerId, _ridFront, _stamp)");
const iPress = post.indexOf("window.__axlxResetPressP");
ok("前に出した後、まだ見えない時だけ待つ", iFront > 0 && iHidden > iFront && iWait > iHidden);
ok("待つのは押す前（押してから待たない）", iWait > 0 && iPress > iWait);
ok("10分見えなければ押さずに返す（hiddenStuck）", /tab_hidden_stuck", notPressed: true, hiddenStuck: true/.test(post));

// 保険: 見えないまま止まった時は60〜90秒の保険・押し直しをしない
const iStuck = ins.indexOf("if (rr.hiddenStuck)");
const iInsure = ins.indexOf("reset_insure_wait");
ok("見えないまま止まった時は保険（押し直し）へ行かず止める", iStuck > 0 && iInsure > iStuck && /hiddenStuck\) return \{ ok: false, why: "reset_stop", stop: true/.test(ins));

// 待ちの中身
ok("待つ上限は10分", /var RESET_HIDDEN_WAIT_MAX_MS = 600000;/.test(bg));
ok("待つ間はストップ要求を見る", /_batchShouldStop[\s\S]{0,80}stop_requested/.test(wait));
ok("待つ間は段と窓の上限を伸ばす（見張りが割り込まない）", /_bulkPhaseSet\(_bulkPhase\.phase/.test(wait) && /_quietSet\("reset"/.test(wait));
ok("見えたら印（reset_hidden_visible）を残して押しへ戻る", /reset_hidden_visible[\s\S]{0,200}return \{ ok: true \}/.test(wait));
ok("10分見えなければ印（reset_hidden_stuck）を残す", /reset_hidden_stuck/.test(wait));
ok("通知は待ち始めに出し、終わったら必ず消す（finally）", /_resetHiddenNotify\(true\)/.test(wait) && /finally \{\s*_resetHiddenNotify\(false\)/.test(wait));
ok("強制的に前に出さない（最小化→戻す をしない）", !/state: "minimized"/.test(wait) && !/state: "minimized"/.test(body(bg, "_resetHiddenNotify")));
ok("通知を押したら Chrome の窓を前に出す（人の操作なので前に出せる）", /onClicked\.addListener[\s\S]{0,200}focused: true/.test(bg));
ok("manifest に notifications の許可がある", (mf.permissions || []).includes("notifications"));

// 知らせ: 止めた時の文が見えない時用に分かれる・枠の押した結果の行
ok("止めた時の知らせは見えない時用の文に分かれる", /_resetStopNotify\(customerName, _site, !!_psRes\.hiddenStuck\)/.test(bg) && /_resetStopNotify\([^)]*!!_rbf\.hiddenStuck\)/.test(bg));
ok("枠に『押さずに待っている』を出す", /result === "hidden_wait"/.test(dl));
ok("枠に『見えないまま止めた』を出す", /result === "hidden_stopped"/.test(dl));
ok("枠の待ちの言葉（reset_hidden）が地図の写しにある", /reset_hidden: "/.test(dl));

// 自己点検: 押した後で待つ形は止まる
const bad = post.replace("_waitRealproVisible(_tab, customerId, _ridFront, _stamp)", "X").replace("window.__axlxResetPressP", "window.__axlxResetPressP;_waitRealproVisible(_tab, customerId, _ridFront, _stamp)");
const bW = bad.indexOf("_waitRealproVisible(_tab, customerId, _ridFront, _stamp)"), bP = bad.indexOf("window.__axlxResetPressP");
ok("自己点検: 押してから待つ形は検出される", !(bP > bW && bW > 0));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
