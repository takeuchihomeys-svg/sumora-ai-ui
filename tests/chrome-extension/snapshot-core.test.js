// 実行: node tests/chrome-extension/snapshot-core.test.js
// 2026-09-29 v2.5.40 竹内「ブレインのAIX検索モードが隼斗さんで止まってしまっている。なぜ固まっているのか」
//   「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
// 止まりの見張り（6分・1回だけ・1日20回）・撮り方（前に出す／出さない）・ログの輪・帯の状態の札・1回の検索の上限と、
// background・score-overlay・popup・manifest への配線を固定する。
const fs = require("fs");
const path = require("path");
const S = require("../../chrome-extension/snapshot-core.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
const NOW = Date.UTC(2026, 8, 29, 7, 32, 0); // 16:32 JST
const MIN = 60 * 1000;

console.log("\n■ 止まりの見張り（6分・同じ回×お客様×サイトで1回だけ）");
{
  const w = { commandId: "f36ea311", customerId: "c1", site: "realnetpro", pass: null };
  const key = S.stallKey(w);
  eq("鍵の形", key, "f36ea311|c1|realnetpro|-");
  eq("一括が動いていない → 撮らない", S.shouldSnapStall({ running: false, lastProgressAt: NOW - 30 * MIN, key }, NOW).snap, false);
  eq("5分59秒 → まだ撮らない（bulk-dl の無進捗5分より長く待つ）", S.shouldSnapStall({ running: true, lastProgressAt: NOW - 6 * MIN + 1000, key, snappedKeys: [] }, NOW).snap, false);
  eq("6分 → 撮る", S.shouldSnapStall({ running: true, lastProgressAt: NOW - 6 * MIN, key, snappedKeys: [] }, NOW), { snap: true, reason: "stall", idle_ms: 6 * MIN });
  eq("同じ鍵は2回撮らない", S.shouldSnapStall({ running: true, lastProgressAt: NOW - 20 * MIN, key, snappedKeys: [key] }, NOW).reason, "already");
  eq("進みの時刻が無い → 撮らない（分からない時に撮らない）", S.shouldSnapStall({ running: true, lastProgressAt: null, key }, NOW).reason, "no_progress_info");
}

console.log("\n■ 撮る回数（1日20回・同じきっかけは3分に1回・頼まれは上限を見ない）");
{
  let h = null;
  for (let i = 0; i < 20; i++) { const g = S.rateGate(h, "t" + i, NOW + i); eq("  " + (i + 1) + "回目は撮る", g.ok, true); h = g.hist; }
  eq("21回目（別のきっかけでも）→ 1日の上限", S.rateGate(h, "stall", NOW + 100).reason, "daily_limit");
  eq("頼まれた時は上限を見ない", S.rateGate(h, "request", NOW + 100).ok, true);
  eq("日付が替われば数え直し（JST）", S.rateGate(h, "stall", NOW + 24 * 60 * MIN).ok, true);
  const g1 = S.rateGate(null, "stall", NOW);
  eq("同じきっかけは3分あける", S.rateGate(g1.hist, "stall", NOW + 2 * MIN).reason, "too_soon");
  eq("3分たてば撮る", S.rateGate(g1.hist, "stall", NOW + 3 * MIN).ok, true);
  eq("違うきっかけはすぐ撮る", S.rateGate(g1.hist, "fill_timeout", NOW + 1000).ok, true);
  eq("元の hist は変えない", g1.hist.count, 1);
}

console.log("\n■ 撮るタブ（サイトごとに1つ・前に出ているタブ優先）");
{
  const tabs = [
    { id: 1, url: "https://sumora-ai-ui.vercel.app/conditions", active: true },
    { id: 2, url: "https://www.realnetpro.com/main.php?method=estate&display=building", active: false, lastAccessed: 100 },
    { id: 3, url: "https://www.realnetpro.com/main.php", active: true, lastAccessed: 50 },
    { id: 4, url: "https://itandibb.com/rent_rooms/list", active: false, lastAccessed: 10 },
    { id: 5, url: "https://itandibb.com/rent_rooms/list?page=2", active: false, lastAccessed: 99 },
    { id: 6, url: "https://system.reins.jp/main/PF08/SA08I010.aspx", active: false },
  ];
  eq("リアプロ・itandi・レインズの順・3つ", S.pickTabs(tabs).map((p) => p.site + ":" + p.tab.id), ["realpro:3", "itandi:5", "reins:6"]);
  eq("サイトのタブが無ければ空", S.pickTabs([{ url: "https://example.com" }]), []);
  eq("URL の判定", ["https://realnetpro.com/x", "https://www.realnetpro.com/main.php", "https://itandibb.com/a", "https://system.reins.jp/b", "https://evil.com/realnetpro.com"].map(S.siteOfUrl), ["realpro", "realpro", "itandi", "reins", null]);
}

console.log("\n■ 撮り方（前に出ているタブはそのまま・裏のタブは放置の PC だけ前に出す）");
{
  const win = { state: "normal" };
  eq("許可なし → 撮らない（文字だけ）", S.capturePlan({ active: true }, win, { canCapture: false }).reason, "no_permission");
  eq("前に出ている → そのまま", S.capturePlan({ active: true }, win, { canCapture: true }).how, "visible");
  eq("裏のタブ・放置の PC → 前に出す", S.capturePlan({ active: false }, win, { canCapture: true, staffMode: false }).how, "activate");
  eq("裏のタブ・スタッフモード → 前に出さない（人の作業を邪魔しない）", S.capturePlan({ active: false }, win, { canCapture: true, staffMode: true }), { how: "none", reason: "background_tab_staff" });
  eq("前に出すのを止めた PC（snapAllowActivate:false）", S.capturePlan({ active: false }, win, { canCapture: true, allowActivate: false }).reason, "background_tab");
  eq("最小化の窓 → 撮らない（窓を出さない）", S.capturePlan({ active: true }, { state: "minimized" }, { canCapture: true }).reason, "minimized");
  eq("スタッフでも前に出ているタブは撮る", S.capturePlan({ active: true }, win, { canCapture: true, staffMode: true }).how, "visible");
}

console.log("\n■ ログの輪（80行・1行300字）");
{
  const buf = [];
  for (let i = 0; i < 200; i++) buf.push(S.logLine("log", ["[batch]", "line " + i, { a: i }], NOW + i));
  const t = S.trimLog(buf);
  eq("80行に切る（新しい方を残す）", [t.length, t[0].m, t[79].m], [80, '[batch] line 120 {"a":120}', '[batch] line 199 {"a":199}']);
  eq("1行は300字まで", S.logLine("warn", ["x".repeat(1000)], NOW).m.length, 300);
  eq("Error は message", S.logLine("error", [new Error("boom")], NOW).m, "boom");
  eq("元の配列は変えない", buf.length, 200);
}

console.log("\n■ 帯（score-overlay）の状態の札 — 9/29 隼斗さんの帯が「固まって見えた」件");
{
  eq("一括の回が動いていない → 待機中・最終の条件 10:57（今のページの検索とは関係ない印）",
    S.bandStatus({ at: Date.UTC(2026, 8, 29, 1, 57, 0) }, { running: false, at: Date.UTC(2026, 8, 29, 1, 57, 40) }, NOW),
    { state: "idle", label: "待機中・最終の条件 10:57" });
  eq("動いている → 一括検索中（誰・どこ）", S.bandStatus({ at: NOW - MIN }, { running: true, at: NOW - MIN, customerName: "隼斗", site: "realnetpro" }, NOW),
    { state: "running", label: "▶ 一括検索中（隼斗・リアプロ）" });
  eq("15分より古い「実行中」は信じない（SW が落ちた等）", S.bandStatus(null, { running: true, at: NOW - 16 * MIN }, NOW).state, "idle");
  eq("何も無い → 待機中（前回の条件）", S.bandStatus(null, null, NOW).label, "待機中（前回の条件）");
}

console.log("\n■ 1回の検索の上限と止まった理由の文");
{
  eq("上限: リアプロ20分・itandi25分・レインズ8分・知らないサイトはリアプロ", ["realnetpro", "itandi", "reins", "x"].map((s) => S.passDeadlineMs(s) / MIN), [20, 25, 8, 20]);
  ok("上限は fill-done（itandi 245秒）＋無進捗5分より長い", S.passDeadlineMs("itandi") > 245000 + 5 * MIN);
  const w = { customerName: "隼斗", site: "realnetpro", pass: null, waitingFor: "検索の完了（fill-done）と全ページの送信", lastEvent: "送信の進み", passStartedAt: NOW - 21 * MIN, lastProgressAt: NOW - 7 * MIN };
  eq("見張りの時間切れの文", S.describeStall(w, NOW, "pass_deadline"), "見張りの時間切れ（21分）: 隼斗さん・リアプロ・待っていた物=検索の完了（fill-done）と全ページの送信・最後の合図=送信の進み");
  eq("止まりの文", S.describeStall(w, NOW, "stall"), "動きなし7分: 隼斗さん・リアプロ・待っていた物=検索の完了（fill-done）と全ページの送信・最後の合図=送信の進み");
  ok("記録が無い時（SW の作り直し）も文を返す", /ロックだけ残っている/.test(S.describeStall(null, NOW, "stall")));
}

console.log("\n■ 心拍の中身・モードの札・縮小・base64");
{
  const hb = S.heartbeatState({ extVersion: "2.5.40", mode: "brain_aix", batchRunning: true, batchCommandId: "f36ea311", customerId: "c1", site: "realnetpro", waitingFor: "x".repeat(300), canCapture: false });
  eq("心拍の名前（サーバーの sanitizeHeartbeat と同じ）", Object.keys(hb), ["ext_version", "mode", "device_label", "batch_running", "batch_command_id", "batch_started_at", "last_progress_at", "current_customer_id", "current_site", "waiting_for", "can_capture", "staff_mode"]);
  eq("待っている物は120字まで", hb.waiting_for.length, 120);
  eq("モードの札", [S.modeKey({ mode: "aix", brain: true }), S.modeKey({ mode: "normal", brain: false }), S.modeKey({ mode: "staff", brain: true })], ["brain_aix", "normal", "brain_staff"]);
  eq("幅1280に縮める（比は保つ）", S.scaledSize(2560, 1440), { w: 1280, h: 720 });
  eq("小さい物はそのまま", S.scaledSize(800, 600), { w: 800, h: 600 });
  eq("base64", S.bytesToBase64(new Uint8Array([0xff, 0xd8, 0xff, 0x00])), Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64"));
}

console.log("\n■ ページの文字（作り物の document）");
{
  const el = (text, extra) => Object.assign({ innerText: text, textContent: text, style: { display: "flex" }, getBoundingClientRect: () => ({ width: 100, height: 20 }) }, extra || {});
  const byId = {
    "axlx-score-bar": el("👤 隼斗: 家賃〜10.5万 / 2K 2DK 2LDK / 更新3日内(前回09/29)"),
    "axlx-count": el("0件"),
    "axlx-bar": el("📥 0件を選択中"),
  };
  const doc = {
    title: "リアルネットプロ",
    visibilityState: "hidden",
    body: { innerText: "📥 0件を選択中\n検索結果\n16,042棟\n1 / 10 ページ\nログインしてください" },
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => (/dialog/.test(sel) ? [] : [
      { type: "text", name: "rent_max", value: "10.5" }, { type: "checkbox", checked: true }, { type: "password", name: "pw", value: "secret" }, { type: "hidden", name: "tok", value: "x" },
    ]),
  };
  const d = S.readDom(doc, { href: "https://www.realnetpro.com/main.php?method=estate&display=building" });
  eq("サイト・見えているか", [d.site, d.visibility], ["realpro", "hidden"]);
  eq("件数（「0件を選択中」は件数と読まない・棟を読む）", d.count_text, "16,042棟");
  eq("ページ", d.page_text, "1 / 10 ページ");
  eq("注意の文", d.alert_text, "ログインしてください");
  eq("帯の文・選択数", [d.band_text, d.selected_count, d.bulk_bar_shown], ["👤 隼斗: 家賃〜10.5万 / 2K 2DK 2LDK / 更新3日内(前回09/29)", "0件", true]);
  eq("フォーム（パスワード・隠し欄は読まない）", d.form, { checked: 1, filled: [{ name: "rent_max", value: "10.5" }] });
}

console.log("\n■ 配線（background・score-overlay・popup・manifest）");
{
  const bg = read("background.js");
  ok("background: snapshot-core.js を import", /import "\.\/snapshot-core\.js";/.test(bg));
  ok("background: アラーム sumora-snap-poll（1分）", /chrome\.alarms\.create\("sumora-snap-poll", \{ periodInMinutes: 1 \}\)/.test(bg));
  const snapListener = bg.slice(bg.indexOf('if (alarm.name !== "sumora-snap-poll") return;'), bg.indexOf('if (alarm.name !== "sumora-snap-poll") return;') + 200);
  ok("background: sumora-snap-poll のリスナーは batchRunning を見て止まらない（止まっている時ほど撮る）", snapListener.length > 0 && !/batchRunning/.test(snapListener));
  const tick = bg.slice(bg.indexOf("async function _snapPollTick"), bg.indexOf('chrome.alarms.get("sumora-snap-poll"'));
  ok("background: 見張りは pending の取りに行き（_pollAndRunBatch）を呼ばない", tick.length > 0 && !/_pollAndRunBatch/.test(tick));
  // 2026-09-30 v2.5.42: ITANDI の条件の入れ直し（_itandiGuardRetry）も同じ1回の検索の見張りの中（4つ目の race）
  ok("background: 1回の検索の見張りを入力の段と送信の段の両方に（＋ITANDI の入れ直し）", (bg.match(/_passGuard\.race\(/g) || []).length === 4 && /_passGuard\.race\(_batchAutofill\([^)]*\), PASS_AUTOFILL_PHASE_MS\)/.test(bg) && /_passGuard\.race\(_itandiGuardRetry\(/.test(bg));
  ok("background: 見張りの時間切れは catch で done・点検に pass_deadline", /_passGuard\.done\(\);\n(?:\s+_itandiGuardCtx = null;[^\n]*\n)?\s+_passFailed\+\+;/.test(bg) && /error_kind: "pass_deadline"/.test(bg));
  ok("background: pending に版と PC を渡す", /"x-ext-version": _extVersion\(\)/.test(bg) && /"x-ext-install":/.test(bg));
  ok("background: 見送りの文に版を書く", /自動便（AIX連動）は実行しない（拡張 v" \+ \(_extVersion\(\)/.test(bg));
  ok("background: 待ちの時間切れで撮る（fill-done・送信の終わり）", /_snapOnEvent\("fill_timeout"/.test(bg) && /_snapOnEvent\("waiter_timeout"/.test(bg));
  ok("background: 進みの合図で時刻を新しくする（fill-done・入力開始・送信の進み・送信の終わり）", ["\"fill-done\"", "\"入力を始めた\"", "\"送信の進み\"", "\"送信の終わり\""].every((s) => bg.indexOf("_watchProgress(" + s) >= 0));
  ok("background: 回の終わりで見張りを消す（finally）", /finally \{\n\s+_searchOverrideLink = null;[^\n]*\n\s+_batchLoopAlive = false;\n\s+_watchClear\(\);/.test(bg));
  ok("background: 帯の条件の時刻（axlx_score_meta）を書く", /axlx_score_meta: \{ at: Date\.now\(\)/.test(bg));
  const so = read("score-overlay.js");
  ok("score-overlay: 帯に状態の札（bandStatus）・待機中は薄い色", /SC\.bandStatus\(bandMeta, bandRun, Date\.now\(\)\)/.test(so) && /axlx-score-state/.test(so));
  ok("score-overlay: axlx_run_state / axlx_score_meta を読む", /"axlx_score_meta", "axlx_run_state"/.test(so) && /changes\.axlx_run_state/.test(so));
  const html = read("popup.html");
  ok("popup.html: 許可ボタンと snapshot-popup.js（popup.js の後）", /id="snap-perm-btn"/.test(html) && html.indexOf('src="snapshot-popup.js"') > html.indexOf('src="popup.js"'));
  ok("snapshot-popup.js: <all_urls> を人のクリックで頼む", /chrome\.permissions\.request\(ORIGINS/.test(read("snapshot-popup.js")) && /"<all_urls>"/.test(read("snapshot-popup.js")));
  const mf = JSON.parse(read("manifest.json"));
  eq("manifest の版", mf.version, "2.5.64");
  eq("manifest: optional_host_permissions に <all_urls>（最初から持たせない）", [mf.optional_host_permissions, (mf.host_permissions || []).includes("<all_urls>")], [["<all_urls>"], false]);
  ok("manifest: 3サイトの content script（document_start）に snapshot-core.js", mf.content_scripts.some((c) => c.run_at === "document_start" && c.js.includes("snapshot-core.js") && c.matches.some((m) => /itandibb/.test(m)) && c.matches.some((m) => /reins/.test(m)) && c.matches.some((m) => /realnetpro/.test(m))));
  ok("manifest: tabs の権限（captureVisibleTab の窓・タブを読む）", mf.permissions.includes("tabs"));
  ok("拡張の中に「_」で始まるファイルを置いていない", !fs.readdirSync(EXT).some((f) => f.startsWith("_")));
}

console.log("\n■ 見張り（2026-09-29）: 件数の数・塗る位置・止める印・送る本文");
{
  eq("件数の数（棟・件中・ありません）", [S.countNumberOf("16,042棟"), S.countNumberOf("検索結果 1,234件中 1-20件"), S.countNumberOf("該当する物件はありません"), S.countNumberOf("全 58 件"), S.countNumberOf("1 / 10 ページ"), S.countNumberOf(null)], [16042, 1234, 0, 58, null, null]);
  const el = (text, rect, extra) => Object.assign({ innerText: text, textContent: text, style: { display: "flex" }, getBoundingClientRect: () => rect, parentElement: null }, extra || {});
  const bar = el("👤 隼斗: 家賃〜10.5万", { left: 0, top: 0, width: 1280, height: 36 });
  const inner = el("隼斗", { left: 10, top: 5, width: 40, height: 20 }, { parentElement: { closest: () => bar } });
  const chip = el("82点", { left: 900, top: 300, width: 60, height: 22 }, { parentElement: { closest: () => null } });
  const hidden = el("", { left: 0, top: 0, width: 0, height: 0 }, { parentElement: { closest: () => null } });
  const doc = {
    title: "リアルネットプロ", visibilityState: "visible", defaultView: { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2 },
    body: { innerText: "検索結果\n16,042棟\n1 / 10 ページ" },
    getElementById: () => null,
    querySelectorAll: (sel) => (sel === S.MASK_SEL ? [bar, inner, chip, hidden] : []),
  };
  const d = S.readDom(doc, { href: "https://www.realnetpro.com/main.php" });
  eq("readDom: count_number", d.count_number, 16042);
  eq("readDom: 塗る位置（拡張の要素・入れ子は外側だけ・見えない物は無し）", d.mask_rects, [{ x: 0, y: 0, w: 1280, h: 36 }, { x: 900, y: 300, w: 60, h: 22 }]);
  eq("readDom: 画面の大きさ", d.viewport, { w: 1280, h: 720, dpr: 2 });
  ok("MASK_SEL は axlx- で始まる id と class", /\[id\^='axlx-'\]/.test(S.MASK_SEL) && /\[class\*=' axlx-'\]/.test(S.MASK_SEL));
  eq("写真の px に直す（2倍の画面→幅1280に縮めた写真・2px 広め）", S.maskRectsScaled(d.mask_rects, d.viewport, 1280, 720), [{ x: 0, y: 0, w: 1280, h: 38 }, { x: 898, y: 298, w: 64, h: 26 }]);
  eq("半分に縮めた写真", S.maskRectsScaled([{ x: 100, y: 100, w: 200, h: 50 }], { w: 1280, h: 720 }, 640, 360), [{ x: 48, y: 48, w: 104, h: 29 }]);
  eq("位置・大きさが無ければ塗らない", [S.maskRectsScaled(null, { w: 1, h: 1 }, 10, 10), S.maskRectsScaled([{ x: 0, y: 0, w: 5, h: 5 }], null, 10, 10)], [[], []]);
  const NOW2 = Date.UTC(2026, 8, 29, 8, 0, 0);
  const stop = S.watchStopFrom({ ok: true, label: "login_expired", action: "stop_site", stop_site: { site: "realpro", label: "login_expired", reason: "タブの URL がログインの画面" } }, NOW2);
  eq("止める印（サーバーの答え stop_site）", stop, { site: "realpro", label: "login_expired", reason: "タブの URL がログインの画面", at: NOW2 });
  eq("stop_site が無ければ null", S.watchStopFrom({ ok: true, label: "wrong_conditions", action: "flag" }, NOW2), null);
  eq("リアプロの印は realnetpro（一括のサイトの呼び名）にも効く", S.watchStopApplies(stop, "realnetpro", NOW2 + 60000), true);
  eq("別のサイト（itandi）には効かない", S.watchStopApplies(stop, "itandi", NOW2), false);
  eq("2時間で切れる", S.watchStopApplies(stop, "realnetpro", NOW2 + S.WATCH_STOP_TTL_MS), false);
  eq("印が無ければ効かない", S.watchStopApplies(null, "realnetpro", NOW2), false);
  const body = S.watchBody("results", { runId: "sa_x", commandId: 12, customerId: "c1", site: "realnetpro", installId: "i-1", extVersion: "2.5.40" },
    { url: "https://www.realnetpro.com/main.php", count_text: "16,042棟", form: { checked: 3, filled: [{ name: "rent_max", value: "10" }] }, mask_rects: [{ x: 0, y: 0, w: 1, h: 1 }], viewport: { w: 1, h: 1 }, band_text: "隼斗: 家賃" });
  eq("送る本文: ブレイン・要所・サイトはそろえた呼び名・件数の数", [body.brain, body.checkpoint, body.site, body.command_id, body.dom.count_number], [true, "results", "realpro", "12", 16042]);
  ok("送る本文にフォームの値・塗る位置は入れない", !("form" in body.dom) && !("mask_rects" in body.dom) && !("viewport" in body.dom));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
