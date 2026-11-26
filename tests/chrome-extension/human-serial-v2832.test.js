// 2.8.132: 列の外の押しも1つずつ・選び直しは人の形・一瞬のスクロールを減らす・重ね押しを減らす・連続の止まり（取り直し・ロック延長・alert）
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("✓ " + name); } else { fail++; console.log("✗ " + name + (extra !== undefined ? " " + JSON.stringify(extra).slice(0, 200) : "")); } }

const root = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const ps = read("page-script.js");
const bg = read("background.js");
const pp = read("popup.js");
const ib = read("itandi-bulk-dl.js");
const mf = JSON.parse(read("manifest.json"));

function body(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  let d = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return "";
}

(async () => {
  console.log("■ 版");
  // 2.8.313: 「ちょうど 2.8.132」の固定は次の版で必ず赤になる → 2.8.132 以上
  ok("manifest 2.8.132 以上", (function (a, b) { for (var i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; } return true; })(String(mf.version).split(".").map(Number), [2, 8, 132]));
  ok("_AXLX_PAGE_VER が manifest と同じ", new RegExp('var _AXLX_PAGE_VER = "' + mf.version.replace(/\./g, "\\.") + '"').test(ps));

  console.log("\n■ 列の外の押しも「押している最中」に数える（重ねて押さない）");
  const busy = body(ps, "isClickQueueBusy");
  ok("isClickQueueBusy が _pressBusy を見る（8秒で忘れる）", /_pressBusy > 0 && Date\.now\(\) - _pressBusyAt < 8000/.test(busy) && /\|\| _pressing/.test(busy));
  const pht = body(ps, "_pressHumanTracked");
  ok("_pressHumanTracked がある", !!pht);
  ok("押す前に数え・終わったら（失敗でも）戻す", /_pressBusy\+\+;\s*_pressBusyAt = Date\.now\(\);/.test(pht) && /_pressBusy = Math\.max\(0, _pressBusy - 1\)/.test(pht) && /function \(\) \{ done\(\); return false; \}/.test(pht));
  // 模型: 押しの Promise が成功・失敗・同期の時、どれも数が 0 に戻る
  {
    const mk = (hpc) => new Function("_humanPointerClick", "var _pressBusy = 0, _pressBusyAt = 0;" + pht + "; return { run: function (el, fn) { return _pressHumanTracked(el, fn); }, n: function () { return _pressBusy; } };")(hpc);
    const a = mk(() => Promise.resolve(true));
    const pa = a.run({}, () => {});
    ok("模型: 押している間は 1", a.n() === 1);
    await pa;
    ok("模型: 押し終わったら 0", a.n() === 0);
    const b = mk(() => Promise.reject(new Error("x")));
    await b.run({}, () => {});
    ok("模型: 失敗しても 0 に戻る", b.n() === 0);
    let fired = 0;
    const c = mk(() => { throw new Error("y"); });
    await c.run({}, () => { fired++; });
    ok("模型: カーソルが壊れていたら直接押して 0 に戻る", c.n() === 0 && fired === 1);
  }
  ok("clickByText・simulateClick も印の時刻を付ける", /_pressBusy\+\+;\s*_pressBusyAt = Date\.now\(\)/.test(body(ps, "clickByText")) && /_pressBusyAt = Date\.now\(\)/.test(body(ps, "simulateClick")));
  const ew = body(ps, "ensureWardButtonY");
  ok("区のボタン直しはカーソルで押し・押し終わってから次の手（固定の時間で重ねない）", /_pressHumanTracked\(wTarget/.test(ew) && /\.then\(/.test(ew));
  ok("確定へ進むボタンもカーソル経由で数える", /_pressHumanTracked\(btnEl/.test(body(ps, "clickNextStepBtn")));

  console.log("\n■ プルダウン: 選び済みは開き直さない・違った時は開いて選び直す");
  const qs = body(ps, "queueSelValText");
  ok("表示がそのまま欲しい値なら return（開き直さない）", /if \(_cur === String\(text\)\.replace\(\/\\s\+\/g, ""\)\) return;/.test(qs));
  ok("違う値の時はもう1回開いて選ぶ（sel_retry_human）", /var _verifyOrRetry = function/.test(ps) && /sel_retry_human/.test(ps) && (ps.match(/openThenChoose\(\)\.then\(_verifyOrRetry\)/g) || []).length === 3);

  console.log("\n■ スクロールは一瞬で飛ばさない");
  ok("検索が画面外の時は smooth で送って待つ", /behavior: "smooth" \}\); \} catch \(_\) \{\}\s*try \{ _auditStepP\("search_wait_view"/.test(ps));
  ok("隠れた押す点も smooth", /behavior: "smooth" \}\); \} catch \(_\) \{\}\s*try \{ if \(_audit\) _auditStepP\("press_hidden_scroll"/.test(ps));
  ok("instant は1か所以下（2.8.150 から0＝検索ボタンも smooth）", (ps.match(/behavior: "instant"/g) || []).length <= 1);

  console.log("\n■ チェック欄: 4回目の押し足しをしない");
  const tg = body(ps, "_toggleCheckboxLikeHuman");
  ok("確かめは見るだけ（lookOnly=true）", /_verifyCheckboxUnderstood\(cb, wantOn, _domain, true\)/.test(tg));
  ok("2回目・3回目の後は長めに待つ", /_settleChk\(420\)/.test(tg) && /_settleChk\(480\)/.test(tg));
  {
    const vc = body(ps, "_verifyCheckboxUnderstood");
    let pressed = 0, notes = [];
    const f = new Function("simulateClick", "_labelForCheckbox", "_noteIntentUnderstood", "_intentDomainOfName", vc + "; return _verifyCheckboxUnderstood;")(
      () => { pressed++; }, (cb) => cb, (d, i, o, det) => { notes.push([d, i, o, det]); }, () => "ward");
    const cb = { checked: false, name: "city_code[]", value: "27104" };
    ok("模型: lookOnly は押さずに false", f(cb, true, "ward", true) === false && pressed === 0 && notes[0][2] === false);
    f(cb, true, "ward");
    ok("模型: lookOnly が無い呼び方は今まで通り1回押す", pressed === 1);
  }

  console.log("\n■ 顧客一覧は3回まで取り直す");
  const fr = body(bg, "_fetchCustomerListWithRetry");
  ok("一括・バッチ・スクレイプの3か所が取り直しを使う", (bg.match(/_fetchCustomerListWithRetry\(/g) || []).length === 4);
  {
    const run = async (seq) => {
      let i = 0; const calls = [];
      const fetch = async (u) => { calls.push(u); const s = seq[Math.min(i++, seq.length - 1)]; if (s === "throw") throw new Error("net"); return { ok: s === 200, status: s }; };
      const fakeTimeout = (fn) => { fn(); return 0; };
      const f = new Function("fetch", "setTimeout", "AbortSignal", "console", "return async " + fr + ";")(fetch, fakeTimeout, undefined, { log() {}, warn() {} });
      try { const r = await f("u", "t"); return { ok: r.ok, n: calls.length }; } catch (e) { return { err: String(e.message), n: calls.length }; }
    };
    const a = await run(["throw", 503, 200]);
    ok("模型: 2回失敗しても3回目で取れる", a.ok === true && a.n === 3, a);
    const b = await run([500, 500, 500]);
    ok("模型: 3回とも失敗なら止める（4回目は無い）", !!b.err && b.n === 3, b);
    const c = await run([404]);
    ok("模型: 4xx は取り直さない", !!c.err && c.n === 1, c);
  }

  console.log("\n■ 一連ロック: 進んでいれば延ばす・30分で必ず切れる");
  {
    const live = new Function(body(bg, "_pipelineJobLive") + "; return _pipelineJobLive;")();
    const exp = new Function(body(pp, "_axPipelineExpired") + "; return _axPipelineExpired;");
    const ctx = new Function("AX_PIPELINE_TTL_MS", "AX_PIPELINE_HARD_MS", "return (" + body(pp, "_axPipelineExpired") + ");")(12 * 60e3, 30 * 60e3);
    const now = Date.now();
    void exp;
    ok("bg: 開始13分・延長なし → 切れる", live({ startedAt: now - 13 * 60e3 }) === false);
    ok("bg: 開始13分・2分前に延長 → 生きている", live({ startedAt: now - 13 * 60e3, touchedAt: now - 2 * 60e3 }) === true);
    ok("bg: 開始31分 → 延長していても切れる", live({ startedAt: now - 31 * 60e3, touchedAt: now - 60e3 }) === false);
    ok("popup と bg が同じ答え", ctx({ startedAt: now - 13 * 60e3 }) === true && ctx({ startedAt: now - 13 * 60e3, touchedAt: now - 2 * 60e3 }) === false && ctx({ startedAt: now - 31 * 60e3, touchedAt: now - 60e3 }) === true);
    ok("検索が終わって送付へ入る時に延長する", /_axPipelineTouch\("search-done→送付"\)/.test(pp));
    // 2.8.315: 裏の再起動後の見張り（_swWdRun）が4か所目（同じ決まり _pipelineJobLive を使う）
    ok("bg の4か所が固定の12分ではなく同じ決まりを使う", (bg.match(/_pipelineJobLive\(_/g) || []).length === 4 && !/startedAt \|\| 0\) < 12 \* 60 \* 1000/.test(bg));
  }

  console.log("\n■ ITANDI 自動の回は alert で止めない");
  ok("PDF 0件・送信エラーは自動の回では console だけ", /if \(onComplete\) console\.warn\("\[AXLX itandi\] PDFが1件も取得できませんでした/.test(ib) && /if \(onComplete\) console\.warn\("\[AXLX itandi\] LINE送信エラー/.test(ib));

  console.log("\n合計: " + pass + " pass / " + fail + " fail");
  process.exit(fail ? 1 : 0);
})();
