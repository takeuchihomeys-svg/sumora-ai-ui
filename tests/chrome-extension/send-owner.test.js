// 実行: node tests/chrome-extension/send-owner.test.js
// v2.5.49（2026-09-30 竹内「監視のところでちゃんと入り込まんように対策する／お客さんの名前ずれてないか監視する」）
//   送信の出口（background の callMergeApi）で、送る相手が「今そのサイトで検索している回のお客様」か照らす（batch-guard.js sendOwner）。
//   実例は 9/30 の本番の記録（search_audits と property_pickups）: 🐥 さん（42a89f52）の ITANDI の回の物件が ℳ さん（382d4296）に付いた 等。
const fs = require("fs");
const path = require("path");
const G = require("../../chrome-extension/batch-guard.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
function ok(name, c) { eq(name, !!c, true); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

const M = "382d4296-abc8-40f8-93d0-ea7b8b6b0918";   // ℳ さん（前のお客様）
const HIYO = "42a89f52-3c5d-4d51-8126-1cf064c7813e"; // 🐥 さん（16:29〜16:42 に ITANDI を検索していた回）
const YUMA = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";

console.log("\n■ siteKey（サイトの呼び名をそろえる）");
{
  eq("realpro", G.siteKey("realpro"), "realnetpro");
  eq("realnetpro", G.siteKey("realnetpro"), "realnetpro");
  eq("itandi", G.siteKey("itandi"), "itandi");
  eq("reins", G.siteKey("reins"), "reins");
  eq("空", G.siteKey(null), null);
}

console.log("\n■ sendOwner（順の回: 見張りは上の段に1本）");
{
  const watch = { customerId: HIYO, customerName: "🐥", site: "itandi", runId: "sa_x", commandId: "cmd1" };
  const bad = G.sendOwner(watch, true, "itandi", M);
  ok("★ 9/30 16:39 の実例: 🐥 さんの回なのに相手が ℳ さん → 送らない", bad.batch && !bad.ok && bad.reason === "mismatch");
  eq("回のお客様と点検の回が付く", [bad.ownerId, bad.ownerName, bad.runId, bad.commandId], [HIYO, "🐥", "sa_x", "cmd1"]);
  const good = G.sendOwner(watch, true, "itandi", HIYO);
  ok("本人に送るのは通す", good.batch && good.ok && !good.fill);
  const fill = G.sendOwner(watch, true, "itandi", null);
  ok("相手が空 → 回のお客様で送る（止めない）", fill.batch && fill.ok && fill.fill && fill.ownerId === HIYO);
  ok("一括の回が走っていない（手の検索・スタッフの送信）は見ない", G.sendOwner(watch, false, "itandi", M).batch === false);
  ok("見張りが無い時は見ない", G.sendOwner(null, true, "itandi", M).batch === false);
  ok("別のサイトの送信（ITANDI の回の間のリアプロ）は見ない", G.sendOwner(watch, true, "realpro", M).batch === false);
  ok("回のお客様が分からない時は見ない", G.sendOwner({ site: "itandi" }, true, "itandi", M).batch === false);
  ok("サイトが分からない送信は見ない", G.sendOwner(watch, true, null, M).batch === false);
}

console.log("\n■ sendOwner（同時の回: サイトごとの本）");
{
  const watch = { customerId: YUMA, customerName: "YUMA", site: "realnetpro", runId: "sa_top", commandId: "c9",
    lanes: { realnetpro: { customerId: YUMA, customerName: "YUMA", site: "realnetpro", runId: "sa_rp", commandId: "c9", done: false },
             itandi: { customerId: YUMA, customerName: "YUMA", site: "itandi", runId: "sa_it", commandId: "c9", done: false } } };
  const it = G.sendOwner(watch, true, "itandi", YUMA);
  ok("ITANDI の本の回で照らす", it.batch && it.ok && it.runId === "sa_it");
  const rp = G.sendOwner(watch, true, "realpro", M);
  ok("リアプロの本: 相手が別の人 → 送らない", rp.batch && !rp.ok && rp.runId === "sa_rp");
  const doneLane = Object.assign({}, watch, { site: "realnetpro", lanes: Object.assign({}, watch.lanes, { itandi: Object.assign({}, watch.lanes.itandi, { done: true }) }) });
  ok("終わった本は使わない（上の段が別のサイトなら見ない）", G.sendOwner(doneLane, true, "itandi", M).batch === false);
}

console.log("\n■ nameDrift（ID は同じで見出しの名前が違う）");
{
  ok("同じ名前", !G.nameDrift("YUMA", "YUMA"));
  ok("末尾の「さん」「様」・空白の違いは同じ扱い", !G.nameDrift("松浦 麻夜", "松浦麻夜さん") && !G.nameDrift("YUMA", "YUMA様"));
  ok("全角と半角の違いは同じ扱い", !G.nameDrift("ＹＵＭＡ", "YUMA"));
  ok("★ 別の名前 → ずれ", G.nameDrift("🐥", "ℳ"));
  ok("どちらかが空なら見ない", !G.nameDrift(null, "YUMA") && !G.nameDrift("YUMA", ""));
}

console.log("\n■ 配線（background.js の callMergeApi）");
{
  const bg = read("background.js");
  const fn = bg.slice(bg.indexOf("async function callMergeApi(payload)"), bg.indexOf("async function callMergeApi(payload)") + 5000);
  ok("sendOwner を見張り（_batchWatch・_batchLoopAlive）で呼ぶ", /AxlxBatchGuard\.sendOwner\(_batchWatch, _batchLoopAlive, payload && payload\.site, payload && payload\.property_customer_id\)/.test(fn));
  ok("違えば fetch の前に投げる（送らない）", fn.indexOf("AXLX_OWNER_MISMATCH") > 0 && fn.indexOf("AXLX_OWNER_MISMATCH") < fn.indexOf("/api/merge-pdfs"));
  ok("点検の段 owner_mismatch に残す", /_auditStep\(_own\.runId, "owner_mismatch"/.test(fn));
  ok("名前ずれは回のお客様の名前で送り、段 owner_name_drift に残す", /"owner_name_drift"/.test(fn) && /customer_name: _own\.ownerName/.test(fn));
  ok("サーバーに回のお客様（batch_owner）を渡す", /batch_owner: batchOwner/.test(fn));
  const mf = JSON.parse(read("manifest.json"));
  eq("manifest の版", mf.version, "2.5.57");
  ok("background が batch-guard.js を読み込んでいる", /batch-guard\.js/.test(bg));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
