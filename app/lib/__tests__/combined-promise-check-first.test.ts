// npx tsx app/lib/__tests__/combined-promise-check-first.test.ts
// 2026-11-23 作業員K2（台帳 #469）: 確認＋見積の約束の後、2件以上の持ち込みなら物件確認した を先に（COMBINED_PROMISE_CHECK_FIRST・既定 off）。17208 の形（名前・物件は伏せた）
import assert from "node:assert/strict";
import { combinedPromiseCheckFirst, combinedPromiseCheckFirstOn } from "../combined-promise-check-first";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const now = Date.parse("2026-11-22T05:36:00Z");
const promise = { sender: "staff", text: "〇〇さんお世話になっております！！かしこまりました！！〇〇の募集状況と初期費用確認させて頂きます！！確認出来次第、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！", created_at: "2026-11-22T05:26:29Z" };
const ask = { sender: "customer", text: "ありがとうございます！！大体見積もりいつ頃ご連絡いただけそうですか？", created_at: "2026-11-22T05:35:00Z" };
const brought = (k: number) => Array.from({ length: k }, (_, i) => ({ sender: "customer", text: `https://suumo.jp/chintai/bc_${i}/`, created_at: `2026-11-22T05:1${i}:00Z` }));
t("既定 off", () => { assert.equal(combinedPromiseCheckFirstOn({}), false); assert.equal(combinedPromiseCheckFirstOn({ COMBINED_PROMISE_CHECK_FIRST: "on" }), true); });
t("2件以上の持ち込み＋確認と見積の約束＋見積書が立つ番＝物件確認した に（17208）", () => {
  assert.equal(combinedPromiseCheckFirst("estimate_sheet", [...brought(3), promise, ask], now), "property_check_result");
});
t("持ち込み0〜1件は今のまま（竹内さんでも割れる）", () => {
  assert.equal(combinedPromiseCheckFirst("estimate_sheet", [...brought(1), promise, ask], now), null);
  assert.equal(combinedPromiseCheckFirst("estimate_sheet", [promise, ask], now), null);
});
t("見積書以外が立つ番・約束が無い・約束をもう果たした番は触らない", () => {
  assert.equal(combinedPromiseCheckFirst("property_check_result", [...brought(3), promise, ask], now), null);
  assert.equal(combinedPromiseCheckFirst("estimate_sheet", [...brought(3), ask], now), null);
  const done = { sender: "staff", text: "お待たせ致しました😊！！お送り頂きました物件の募集状況と最大限割引しました初期費用御見積させて頂きました！！【募集中のお部屋】", created_at: "2026-11-22T05:34:00Z" };
  assert.equal(combinedPromiseCheckFirst("estimate_sheet", [...brought(3), promise, done, ask], now), null);
});
t("確認だけ（見積の語なし）の約束は対象外", () => {
  const p2 = { ...promise, text: "〇〇の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！" };
  assert.equal(combinedPromiseCheckFirst("estimate_sheet", [...brought(3), p2, ask], now), null);
});
console.log(`${n} ok`);
