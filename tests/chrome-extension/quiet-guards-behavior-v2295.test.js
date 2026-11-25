/**
 * 2.8.295 邪魔しない窓のガードを、本物の background.js のまま動かして確かめる。
 *
 *   ・受け口: axlx-poll-now（ウェブの「すぐ拾って」）・axlx-webapp-search（ウェブの検索）
 *   ・写真: _takeShot（録画・人の写真）・_takeSnapshot（見張りの写真）
 *
 * 偽物は chrome.*（tests/chrome-extension/lib/bg-load.js）と時計だけ。
 * 文字の確認（配線）は quiet-window-v2295.test.js にある。ここは「動いた結果」を見る。
 */
"use strict";
const path = require("path");
const { loadBackground } = require(path.join(__dirname, "lib", "bg-load.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
}
const bulkCalls = (h, re) => h.calls.filter((c) => re.test(c.api));

async function main() {
  console.log("■ ① ウェブの「すぐ拾って」（axlx-poll-now）");
  {
    // 一括の途中 → 断る
    const h = loadBackground({});
    h.ctx._manualBulkAlive = true;
    const r = h.dispatch({ type: "axlx-poll-now" });
    await h.flush(40);
    ok("一括の途中は断る（bulk_busy）", r.res.done && r.res.value && r.res.value.reason === "bulk_busy", r.res);
    ok("  断る時は別の作業（タブの更新・作成）を始めない", bulkCalls(h, /^tabs\.(update|create|reload)$/).length === 0, bulkCalls(h, /^tabs/));
  }
  {
    // 邪魔しない窓の間（一括の外でも）→ 断る
    const h = loadBackground({});
    h.ctx._quiet = { kind: "reset", since: Date.now(), until: Date.now() + 60000, owner: "x:1" };
    const r = h.dispatch({ type: "axlx-poll-now" });
    await h.flush(40);
    ok("窓（リセット）の間は断る（bulk_busy）", r.res.done && r.res.value && r.res.value.reason === "bulk_busy", r.res);
  }
  {
    // 窓が上限を過ぎていれば断らない（窓が残って止まらない）
    const h = loadBackground({});
    h.ctx._quiet = { kind: "reset", since: Date.now() - 999999, until: Date.now() - 1, owner: "x:1" };
    const r = h.dispatch({ type: "axlx-poll-now" });
    await h.flush(40);
    ok("上限を過ぎた窓は断らない（ok:true で受ける）", r.res.done && r.res.value && r.res.value.ok === true, r.res);
  }
  {
    // 何も無い → 受ける
    const h = loadBackground({});
    const r = h.dispatch({ type: "axlx-poll-now" });
    await h.flush(40);
    ok("空いている時は受ける（ok:true）", r.res.done && r.res.value && r.res.value.ok === true, r.res);
  }

  console.log("\n■ ② ウェブの検索（axlx-webapp-search）");
  {
    const h = loadBackground({});
    h.ctx._guideOnly = () => false; // 自動モードを選んでいる前提（モードの関所は mode-gate 試験で見る）
    h.ctx._manualBulkAlive = true;
    const r = h.dispatch({ type: "axlx-webapp-search", site: "realpro", conditions: { customerId: "c12345678" } });
    await h.flush(40);
    ok("一括の途中は断る（bulk_busy）", r.res.done && r.res.value && r.res.value.error === "bulk_busy", r.res);
    ok("  お客さんの切り替えの指示を送らない", bulkCalls(h, /^tabs\.sendMessage$/).length === 0 && bulkCalls(h, /^tabs\.update$/).length === 0, bulkCalls(h, /^tabs/));
    ok("  pendingPopupCmd を書かない（ポップアップが勝手に動かない）", !("pendingPopupCmd" in h.storeLocal), Object.keys(h.storeLocal));
  }
  {
    const h = loadBackground({});
    h.ctx._guideOnly = () => false;
    h.ctx._quiet = { kind: "sort", since: Date.now(), until: Date.now() + 60000, owner: "x:1" };
    const r = h.dispatch({ type: "axlx-webapp-search", site: "realpro", conditions: { customerId: "c1" } });
    await h.flush(40);
    ok("並べ替えの窓の間は断る（bulk_busy）", r.res.done && r.res.value && r.res.value.error === "bulk_busy", r.res);
  }
  {
    // 通常モード（_guideOnly が真）は従来どおり guide_only で断る（既存の関所が先）
    const h = loadBackground({});
    h.ctx._guideOnly = () => true;
    const r = h.dispatch({ type: "axlx-webapp-search", site: "realpro", conditions: { customerId: "c1" } });
    await h.flush(40);
    ok("通常モードは従来どおり guide_only（既存の関所は変えていない）", r.res.done && r.res.value && r.res.value.error === "guide_only", r.res);
  }

  console.log("\n■ ③ 人の写真（_takeShot）の窓");
  {
    // リアプロが裏（アクティブでない）・窓の間 → タブを前に出さず quiet_window で諦める
    let updateCalled = false;
    const tabs = {
      query: async (q) => (q && q.active) ? [] : [{ id: 5, windowId: 1, index: 0, active: false, url: "https://www.realnetpro.com/main.php", title: "リアプロ" }],
      update: async () => { updateCalled = true; return {}; },
      get: async () => ({ id: 5, windowId: 1, active: false, url: "https://www.realnetpro.com/main.php" }),
    };
    const h = loadBackground({ chrome: { tabs, permissions: { contains: async () => true } } });
    h.ctx._quiet = { kind: "gap", since: Date.now(), until: Date.now() + 60000, owner: "x:1" };
    const r = h.dispatch({ type: "axlx-human-shot", site: "realpro", kind: "rec" });
    await h.flush(60);
    const res = r.res.value;
    ok("窓の間は写真のためにリアプロを前に出さず諦める（quiet_window）", res && res.error === "quiet_window", res);
    ok("  タブの切り替え（tabs.update）は呼ばれていない", updateCalled === false);
  }
  {
    // 窓が無い → 同じ条件でも quiet_window にはならない（従来の道へ）
    const tabs = {
      query: async (q) => (q && q.active) ? [] : [{ id: 5, windowId: 1, index: 0, active: false, url: "https://www.realnetpro.com/main.php", title: "リアプロ" }],
      update: async () => ({}),
      get: async () => ({ id: 5, windowId: 1, active: false }),
    };
    const h = loadBackground({ chrome: { tabs, permissions: { contains: async () => true } } });
    const r = h.dispatch({ type: "axlx-human-shot", site: "realpro", kind: "rec" });
    await h.flush(60);
    const res = r.res.value;
    ok("窓が無ければ quiet_window にはしない（写真は従来どおり試す）", res && res.error !== "quiet_window", res);
  }

  console.log("\n■ ④ 見張りの写真（_takeSnapshot）の窓");
  {
    // リアプロが裏・窓の間 → タブを前に出す所（activate）に来たら見送り（image_error: quiet_window）
    let updateCalled = false;
    const tabs = {
      query: async (q) => (q && q.active) ? [] : [{ id: 5, windowId: 1, index: 0, active: false, url: "https://www.realnetpro.com/main.php", title: "リアプロ" }],
      update: async () => { updateCalled = true; return {}; },
      get: async () => ({ id: 5, windowId: 1, active: false, url: "https://www.realnetpro.com/main.php" }),
    };
    const h = loadBackground({
      chrome: {
        tabs,
        windows: { get: async () => ({ id: 1, state: "normal" }) },
        permissions: { contains: async () => true },
        scripting: { executeScript: async () => [{ result: { dom: { visibility: "visible" } } }] },
      },
    });
    h.ctx._quiet = { kind: "reset", since: Date.now(), until: Date.now() + 60000, owner: "x:1" };
    const out = await h.ctx._takeSnapshot("request", {}).catch((e) => ({ threw: String(e && e.message || e) }));
    // 送った中身（見張りの記録）に、窓で見送った印が入っているかを見る
    const sent = h.calls.filter((c) => c.api === "fetch" && /extension-snapshots/.test(c.args[0]));
    const body = sent.length ? String((sent[0].args[1] && sent[0].args[1].body) || "") : "";
    ok("見張りの写真の記録が送られた（試験の前提）", sent.length === 1, { calls: h.calls.map((c) => c.api).slice(-8), out });
    ok("見張りの写真は窓の間にタブを前に出さない（記録に image_error: quiet_window）", /quiet_window/.test(body), body.slice(0, 300));
    ok("  タブの切り替え（tabs.update）は呼ばれていない", updateCalled === false);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("✗ 試験が落ちた: " + (e && e.stack || e)); process.exit(1); });

