// 実行: node tests/chrome-extension/search-audit.test.js
// 検索の点検（拡張側 chrome-extension/search-audit.js）を固定する。
// 2026-09-25 竹内「ブレインモードで物件自動検索や一括検索した際に、検索がちゃんとされていなかったら原因を見つけられるようにする」
//   ・名前・電話を送らない ・送信は5秒で切れて検索を止めない ・audit は 8KB まで ・1回につき finished は1通だけ
//   ・読み込みの配線（background の import・popup.html・manifest の content_scripts の先頭と web_accessible_resources）
// お客様の情報は使わない（条件は架空・駅名などの地名だけ）
const fs = require("fs");
const path = require("path");
const A = require("../../chrome-extension/search-audit.js");
const M = require("../../chrome-extension/mode-core.js");

let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }

(async () => {
  console.log("\n■ run_id（サーバーの validRunId と同じ形）");
  const SERVER_RE = /^[A-Za-z0-9_-]{6,64}$/;
  const ids = Array.from({ length: 50 }, () => A.newRunId());
  ok("50個とも形が合う", ids.every((x) => SERVER_RE.test(x)));
  ok("50個とも違う", new Set(ids).size === 50);

  console.log("\n■ お客様の条件の写し（名前・電話は入れない）");
  const cust = {
    id: "c1", customer_name: "テスト太郎", phone: "090-0000-0000", line_user_id: "Uxxxx",
    desired_area: "東三国・新大阪", area_mode: "station", rent_max: 80000, walk_minutes: 10, building_age: 20,
    preferences: "連絡は 090-1234-5678 まで・2階以上", floor_plan: null,
  };
  const snap = A.snapshotCustomer(cust);
  ok("名前が無い", !("customer_name" in snap));
  ok("電話の欄が無い", !("phone" in snap) && !("line_user_id" in snap));
  ok("自由記述の中の電話番号は伏せる", !/1234/.test(snap.preferences) && /2階以上/.test(snap.preferences));
  eq("条件の欄は残る", [snap.desired_area, snap.area_mode, snap.rent_max, snap.walk_minutes, snap.building_age], ["東三国・新大阪", "station", 80000, 10, 20]);
  ok("null の欄は入れない", !("floor_plan" in snap));
  eq("無い時は null", A.snapshotCustomer(null), null);

  console.log("\n■ 入れようとした条件の写し");
  const it = A.pickIntended({ rent_max: 80000, station_names: ["東三国", "新大阪"], _audit_run_id: "sa_x", customerName: "x", rp_update_days: 7 });
  eq("見る欄だけ", Object.keys(it).sort(), ["rent_max", "rp_update_days", "station_names"]);
  eq("駅の配列は80まで", A.pickIntended({ station_names: Array.from({ length: 200 }, (_, i) => "駅" + i) }).station_names.length, 80);

  console.log("\n■ audit は 8KB まで");
  const big = { v: 1, site: "itandi", stations_missing: Array.from({ length: 60 }, (_, i) => ({ name: "駅" + i, line: "JR京都線", label_count: 40, sample: Array.from({ length: 40 }, (_, j) => "ラベル" + j) })), form: { stations: Array.from({ length: 300 }, (_, i) => "駅" + i) }, steps: Array.from({ length: 40 }, (_, i) => ({ k: "s" + i })) };
  const clamped = A.clampAudit(big);
  ok("8KB 以下", JSON.stringify(clamped).length <= 8192);
  ok("切った印", clamped.truncated === true);
  ok("押せなかった駅の名前は残る", clamped.stations_missing.length >= 1 && clamped.stations_missing[0].name === "駅0");
  eq("小さい物はそのまま", A.clampAudit({ v: 1, search_clicked: true }), { v: 1, search_clicked: true });

  console.log("\n■ 件数表示の生の文字（画面の文字から「N件」を探す）");
  eq("検索結果 123件（NFKC で全角の：は半角に）", A.readCountText("メニュー\n検索結果：123件\n並び替え"), { text: "検索結果:123件", number: 123 });
  eq("1,234件中", A.readCountText("1,234件中 1〜30件を表示"), { text: "1,234件中 1〜30件を表示", number: 1234 });
  eq("該当する物件はありません → 0", A.readCountText("条件\n該当する物件はありません\n"), { text: "該当する物件はありません", number: 0 });
  eq("全角の数字も読む", A.readCountText("検索結果 ５件"), { text: "検索結果 5件", number: 5 });
  eq("見つからなければ null", A.readCountText("物件一覧\n並び替え"), { text: null, number: null });
  eq("空", A.readCountText(""), { text: null, number: null });

  console.log("\n■ モードの札（ブレインの時だけ）");
  eq("ブレイン×通常", A.modeLabel(M.readState({ brainMode: true }, 0)), "brain_normal");
  eq("ブレイン×スタッフ", A.modeLabel(M.readState({ brainMode: true, staffMode: true, staffModeAt: 0 }, 1)), "brain_staff");
  eq("ブレイン×AIX", A.modeLabel(M.readState({ brainMode: true, aixMode: true }, 0)), "brain_aix");
  eq("ブレイン OFF は null", A.modeLabel(M.readState({ aixMode: true }, 0)), null);
  eq("サイトの名前", ["realnetpro", "リアプロ", "itandi", "reins"].map(A.siteKey), ["realpro", "realpro", "itandi", "reins"]);

  console.log("\n■ 送信は5秒で切り、失敗しても投げない");
  {
    let aborted = false;
    const neverFetch = (_u, init) => new Promise((_res, rej) => { init.signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }); });
    const t0 = Date.now();
    const r = await A.post({ run_id: "sa_test_1", phase: "started" }, { fetch: neverFetch, timeoutMs: 60 });
    ok("待ち切れで ok:false", r.ok === false);
    ok("中断した（fetch に signal を渡している）", aborted);
    ok("すぐ戻る（1秒未満）", Date.now() - t0 < 1000);
    eq("既定の上限は5秒", A.SEND_TIMEOUT_MS, 5000);
    const r2 = await A.post({ run_id: "sa_test_2" }, { fetch: () => { throw new Error("boom"); } });
    ok("fetch が投げても ok:false で戻る", r2.ok === false);
    const r3 = await A.post({ phase: "started" }, { fetch: () => Promise.resolve({ ok: true }) });
    ok("run_id が無ければ送らない", r3.ok === false);
    let sentUrl = null, sentBody = null;
    const r4 = await A.post({ run_id: "sa_test_3", brain: true }, { fetch: (u, init) => { sentUrl = u; sentBody = JSON.parse(init.body); return Promise.resolve({ ok: true, status: 200 }); } });
    ok("送れた", r4.ok === true);
    eq("宛先", sentUrl, "https://sumora-ai-ui.vercel.app/api/search-audits");
    eq("本文", sentBody, { run_id: "sa_test_3", brain: true });
  }

  console.log("\n■ 1回ごとの記録（tracker）");
  {
    const posts = [];
    let now = 1_000_000;
    const T = A.createTracker({ post: (b) => { posts.push(b); return Promise.resolve({ ok: true }); }, now: () => now, extVersion: "2.5.25" });
    const run = T.begin({ site: "realnetpro", customer_id: "c1", customer: cust, trigger: "web_brain", command_id: "cmd1", mode: "brain_normal", is_wide: false, area_mode: "station" });
    eq("started を1通", posts.map((p) => p.phase), ["started"]);
    eq("started の中身", [posts[0].brain, posts[0].site, posts[0].trigger, posts[0].command_id, posts[0].property_customer_id, posts[0].ext_version], [true, "realpro", "web_brain", "cmd1", "c1", "2.5.25"]);
    ok("started に名前が無い", !JSON.stringify(posts[0]).includes("テスト太郎"));
    eq("まだ閉じていない回をお客様で探せる", T.findOpen("c1", "realpro").run_id, run.run_id);
    eq("サイト違いは見つからない", T.findOpen("c1", "itandi"), null);
    now += 5000;
    T.attachFill(run.run_id, { audit: { v: 1, search_clicked: true, stations_missing: [{ name: "東三国", line: null }], steps: [{ k: "fill_start", at: now }] } });
    T.attachResult(run.run_id, { read_rows: 0, count_text: null, zero_reason: "no_rows_25s" });
    await T.finish(run.run_id, {});
    await T.finish(run.run_id, {});
    eq("finished は1通だけ（2回呼んでも）", posts.map((p) => p.phase), ["started", "finished"]);
    const fin = posts[1];
    eq("finished に入った値と結果", [fin.filled.search_clicked, fin.filled.stations_missing[0].name, fin.result.zero_reason], [true, "東三国", "no_rows_25s"]);
    ok("page-script の段は steps に移る", fin.steps.some((s) => s.k === "page:fill_start") && !("steps" in fin.filled));
    ok("steps は40件まで", fin.steps.length <= 40);
    eq("閉じた回はもう探せない", T.findOpen("c1", "realpro"), null);
    const run2 = T.begin({ site: "itandi", customer_id: "c2", trigger: "single", run_id: "sa_given_id_1", post_started: false });
    eq("run_id を渡せばそれを使う", run2.run_id, "sa_given_id_1");
    eq("post_started:false は送らない", posts.length, 2);
    await T.finish("sa_given_id_1", { error: "watchdog-timeout: 85秒" });
    eq("失敗の文を載せる", posts[2].error, "watchdog-timeout: 85秒");
    // 2026-09-27: 個別の検索（popup が started を送った回）は is_wide を渡さない → null のまま finished（サーバーは欄を書かない＝started の広げてが残る）
    eq("is_wide を渡さない回は null（false で上書きしない）", [run2.is_wide, posts[2].is_wide], [null, null]);
    const r = await T.finish("sa_unknown_1", {});
    eq("知らない回は送らない", [r.ok, posts.length], [false, 3]);
    const run3 = T.begin({ site: "reins", trigger: "bulk_manual" });
    for (let i = 0; i < 60; i++) T.step(run3.run_id, "s" + i, null);
    await T.finish(run3.run_id, {});
    ok("段が多くても40件に切る", posts[posts.length - 1].phase === "finished" && posts[posts.length - 1].steps.length === 40);
  }

  console.log("\n■ 読み込みの配線（静かに外れないように）");
  const root = path.join(__dirname, "..", "..", "chrome-extension");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  // 2026-09-27 v2.5.29: 同じ先頭の段の前に待ち時間のばらつき（human-wait.js）が入った（search-audit.js は他の content script より先のまま）
  eq("content_scripts の先頭の段が human-wait.js → search-audit.js", manifest.content_scripts[0].js, ["human-wait.js", "search-audit.js"]);
  ok("3サイトで読む", ["realnetpro.com", "itandibb.com", "system.reins.jp"].every((h) => manifest.content_scripts[0].matches.some((m) => m.includes(h))));
  ok("web_accessible_resources にある", manifest.web_accessible_resources[0].resources.includes("search-audit.js"));
  ok("版は 2.5.25 以上", (() => { const [a, b, c] = manifest.version.split(".").map(Number); return a > 2 || (a === 2 && (b > 5 || (b === 5 && c >= 25))); })());
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  ok("background が import している", /import\s+"\.\/search-audit\.js";/.test(bg));
  const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  ok("popup.html が popup.js より先に読む", html.indexOf("search-audit.js") > 0 && html.indexOf("search-audit.js") < html.indexOf('src="popup.js"'));
  ok("mode-core の behavior に searchAudit", M.behavior("normal", true).searchAudit === true && M.behavior("normal", false).searchAudit === false);
  ok("chrome-extension/ に「_」で始まる物を置かない", fs.readdirSync(root).every((f) => !f.startsWith("_")));
  // page-script は fill-done に runId と audit を載せる（ブレインの時だけ＝conditions._audit_run_id がある時）
  for (const f of ["page-script.js", "itandi-page-script.js", "reins-page-script.js"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    ok(`${f}: _audit_run_id を読み、fill-done に runId・audit を載せる`, /_audit_run_id/.test(src) && /\.runId\s*=/.test(src) && /\.audit\s*=/.test(src));
  }
  for (const f of ["content.js", "itandi-content.js", "reins-content.js"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    ok(`${f}: runId・audit を中継し、error は pageError で渡す（待ちの解き方を変えない）`, /runId:\s*e\.data\.runId/.test(src) && /audit:\s*e\.data\.audit/.test(src) && /pageError:/.test(src) && !/\n\s*error:\s*e\.data\.error/.test(src));
  }
  for (const f of ["bulk-dl.js", "itandi-bulk-dl.js"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    const n = (src.match(/type: "axlx-batch-customer-done"/g) || []).length;
    const withAudit = (src.match(/type: "axlx-batch-customer-done"[^\n]*audit:/g) || []).length + (src.match(/\{ type: "axlx-batch-customer-done", customerId: customerId \|\| null, propertyCount: 0, audit:/g) || []).length * 0;
    ok(`${f}: axlx-batch-customer-done の全部（${n}か所）に audit`, n > 0 && withAudit === n);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
