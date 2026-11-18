// app/lib/__tests__/customer-handoff.test.ts
// 2026-11-18 竹内さん「お客さん検索中や選択中上書きしないように ちゃんと１人のお客さん完了してから次のお客さんに移るように」
//   実測（search_audits 1488→1489）: 自動の区クリックの change を人の操作と取り違えて止まり（human_takeover）、
//   1秒後に次のお客さんへ進み、入力が始まる前に前の印で一覧の印刷用PDFを押して次のお客さんの名前で共有した。
//
// 実行: npx tsx app/lib/__tests__/customer-handoff.test.ts
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 300))); }
};

const root = path.join(__dirname, "..", "..", "..");
const req = createRequire(__filename);
const H = req(path.join(root, "chrome-extension", "customer-handoff.js")) as {
  gateHoldsBatch: (k: unknown) => boolean;
  tabHandoffDecision: (p: unknown, cid: string, waited: number, max?: number) => string;
  pageIncomingDecision: (s: unknown) => string;
  pendingFlagBlockReason: (flag: unknown, busy: unknown, nowCid: string | null, now: number) => string | null;
  OTHER_FILL_WAIT_MS: number;
};
const read = (f: string) => fs.readFileSync(path.join(root, "chrome-extension", f), "utf8");

console.log("一括を止める関所");
ok("human_takeover は一括を止める", H.gateHoldsBatch("human_takeover"));
ok("busy_other_customer は一括を止める", H.gateHoldsBatch("busy_other_customer"));
ok("ふつうの関所（条件不足）は今まで通り飛ばして次へ", !H.gateHoldsBatch("AXLX_FILL_INCOMPLETE") && !H.gateHoldsBatch(true) && !H.gateHoldsBatch(null));

console.log("タブに次のお客さんを送ってよいか");
ok("入力中でない → 送る", H.tabHandoffDecision({ fillRunning: false }, "B", 0) === "go");
ok("同じお客さんの入力中 → 送る（今まで通り）", H.tabHandoffDecision({ fillRunning: true, fillCustomerId: "B" }, "B", 0) === "go");
ok("別のお客さんの入力中 → 待つ", H.tabHandoffDecision({ fillRunning: true, fillCustomerId: "A" }, "B", 5000) === "wait");
ok("待ちきれない → 見送る（上書きしない）", H.tabHandoffDecision({ fillRunning: true, fillCustomerId: "A" }, "B", H.OTHER_FILL_WAIT_MS + 1) === "give_up");
ok("タブが答えない（null）→ 送る（今まで通り）", H.tabHandoffDecision(null, "B", 0) === "go");

console.log("ページの中で別のお客さんの依頼が来た時");
const now = 1_000_000;
ok("入力中でない → 始める", H.pageIncomingDecision({ running: false }) === "start");
ok("同じお客さん → 重複として無視", H.pageIncomingDecision({ running: true, runCid: "A", newCid: "A", now, lastTouchAt: now }) === "duplicate");
ok("別のお客さん・入力が進んでいる → 断る", H.pageIncomingDecision({ running: true, runCid: "A", newCid: "B", now, lastTouchAt: now - 10_000 }) === "reject_busy");
ok("別のお客さん・3分以上止まっている → 閉じて次へ", H.pageIncomingDecision({ running: true, runCid: "A", newCid: "B", now, lastTouchAt: now - 200_000 }) === "supersede_stale");
ok("入力中に番号無しの依頼（audit 1494）→ 断る", H.pageIncomingDecision({ running: true, runCid: "A", newCid: null, now, lastTouchAt: now - 5_000 }) === "reject_busy");
ok("番号無しの入力中に番号ありの依頼 → 断る", H.pageIncomingDecision({ running: true, runCid: null, newCid: "B", now, lastTouchAt: now - 5_000 }) === "reject_busy");
ok("両方番号無し → 重複として無視", H.pageIncomingDecision({ running: true, runCid: null, newCid: null, now, lastTouchAt: now }) === "duplicate");

console.log("読み直し後に「検索した印」で押してよいか");
const T = 2_000_000;
ok("印の後に次のお客さんの入力が始まった → 押さない（平田→大村 08:02:30）",
  H.pendingFlagBlockReason({ ts: T - 60_000, customerId: "A" }, { at: T - 20_000, customerId: "B" }, "B", T) === "newer_customer_started");
ok("お客さんが違う → 押さない", H.pendingFlagBlockReason({ ts: T - 1000, customerId: "A" }, null, "B", T) === "customer_changed");
ok("印が古い → 押さない", H.pendingFlagBlockReason({ ts: T - 700_000, customerId: "A" }, null, "A", T) === "stale");
ok("検索後の正しい読み直し（印が入力開始より新しい・同じ客）→ 押す",
  H.pendingFlagBlockReason({ ts: T - 3000, customerId: "B" }, { at: T - 90_000, customerId: "B" }, "B", T) === null);
ok("入力の印が無い・同じ客 → 押す（手動の検索も今まで通り）", H.pendingFlagBlockReason({ ts: T - 3000, customerId: "B" }, null, "B", T) === null);

console.log("配線（page-script）");
const ps = read("page-script.js");
ok("人の判定は pointerdown / keydown（スクリプトでは作れない）",
  /addEventListener\("pointerdown", _onHumanTakeover, true\)/.test(ps) && /addEventListener\("keydown", _onHumanTakeover, true\)/.test(ps));
ok("click / change では人の判定をしない（自動のクリックで止まった原因）",
  !/addEventListener\("change", _onHumanTakeover/.test(ps) && !/addEventListener\("click", _onHumanTakeover/.test(ps));
ok("_onHumanTakeover は pointerdown/keydown 以外を捨てる", /e\.type !== "pointerdown" && e\.type !== "keydown"/.test(ps));
ok("fill-done に止めた理由の種類（gateKind）を載せる", /msg\.gateKind = gate/.test(ps));
ok("入力中に別のお客さんが来たら断る（busy_other_customer）", /gateKind: "busy_other_customer"/.test(ps) && /next_customer_refused/.test(ps));
ok("入力が進んでいる印（__axlxFillTouchAt）を段ごとに更新", /window\.__axlxFillTouchAt = Date\.now\(\)/.test(ps));
ok("ページの版 2.8.107", /_AXLX_PAGE_VER = "2\.8\.107"/.test(ps));

console.log("配線（content・background・bulk-dl）");
const ct = read("content.js");
ok("content: gateKind を background へ中継", /gateKind: e\.data\.gateKind \|\| null/.test(ct));
ok("content: 関所で止めたら前の検索した印を捨てる（断った合図では捨てない）",
  /gateKind !== "busy_other_customer"[\s\S]{0,300}axlx_pending_auto_send/.test(ct));
ok("content: 別のお客さんの入力中は「入力の開始」を知らせない", /_busyOther[\s\S]{0,200}axlx-autofill-initiated/.test(ct));
const bg = read("background.js");
ok("background: customer-handoff.js を読む", /import "\.\/customer-handoff\.js";/.test(bg));
ok("background: 人が引き取った等は一括を止める", /gateHoldsBatch\(msg\.gateKind\)[\s\S]{0,300}_batchShouldStop = true/.test(bg));
ok("background: 次のお客さんを送る前に前客の入力が終わるのを待つ", /tabHandoffDecision\(_pv, _cidStr/.test(bg) && /wait_prev_customer/.test(bg));
ok("background: 次のお客さんの開始で前の検索した印を捨て、入力開始の印を置く",
  /remove\(\["axlx_pending_auto_send", "axlx_auto_next_page"\]\)[\s\S]{0,200}axlx_fill_busy: \{ at: Date\.now\(\), customerId: _cidStr/.test(bg));
const bd = read("bulk-dl.js");
ok("bulk-dl: Case C は印が今のお客さんの物か確かめてから押す", /pendingFlagBlockReason\(_flag/.test(bd) && /caseC_block_/.test(bd));
ok("bulk-dl: 断った合図（busy_other_customer）で今のお客さんの構えに触らない", /gateKind === "busy_other_customer"\) return;/.test(bd));

const manifest = JSON.parse(read("manifest.json"));
ok("manifest: bulk-dl の前に customer-handoff.js", (() => {
  const cs = manifest.content_scripts.find((c: { js: string[] }) => c.js.includes("bulk-dl.js"));
  return !!cs && cs.js.indexOf("customer-handoff.js") >= 0 && cs.js.indexOf("customer-handoff.js") < cs.js.indexOf("bulk-dl.js");
})());
ok("manifest 2.8.106 以上", (() => { const p = String(manifest.version).split(".").map(Number); return p[0] > 2 || (p[0] === 2 && (p[1] > 8 || (p[1] === 8 && p[2] >= 106))); })(), manifest.version);

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
