// app/lib/__tests__/estimate-ask-signal.test.ts
// 実行: npx tsx app/lib/__tests__/estimate-ask-signal.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 2026-10-01 竹内「まだ確かめ切れていない事の3点強化」③ — 🌟 の1件への見積もりの依頼（監査で止めた・ブレインには未接続）。材料は実物の本文
import { askPointsAtStarredRoom, resolveStarEstimateAsk, starredRoomOf } from "../estimate-ask-signal";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
const STAR = "🌟ポーラーベアー 302号室 新着でかなり条件のいいお部屋となります！！";

it("🌟 の1件を読む", () => eq(starredRoomOf(STAR)?.name, "ポーラーベアー"));
it("「初期費用はいくら位になりますかね」は 🌟 を指す（実物 c024b7b9 の言い方）", () => eq(askPointsAtStarredRoom("初期費用はいくら位になりますかね", STAR), true));
it("別の建物を名指し「クレール元町の見積りお願いしたいです」は指さない（実物 ae3ffecb）", () => eq(askPointsAtStarredRoom("ありがとうございます😊 クレール元町の見積りお願いしたいです。", STAR), false));
it("複数「シティハイツ千種、メゾン加美北、サンコーハイツ、上記の初期費用」は指さない（実物 3d9b67d7）", () => eq(askPointsAtStarredRoom("シティハイツ千種、 メゾン加美北、 サンコーハイツ、 上記の初期費用も教えてほしいんです", STAR), false));
it("空きも聞いている時は指さない", () => eq(askPointsAtStarredRoom("まだ空いてますか？初期費用いくらですか", STAR), false));
it("🌟 の後にお客様が URL を送っていたら当てない", () => eq(resolveStarEstimateAsk([
  { sender: "staff", text: STAR }, { sender: "customer", text: "https://suumo.jp/chintai/bc_1/" }, { sender: "customer", text: "初期費用いくらですか" },
], "初期費用いくらですか").hit, false));
it("🌟 → 依頼 は当たる", () => eq(resolveStarEstimateAsk([{ sender: "staff", text: STAR }, { sender: "customer", text: "ここの初期費用教えてください" }], "ここの初期費用教えてください"), { hit: true, starName: "ポーラーベアー" }));
console.log(`\n${passed} passed / ${failed} failed`);
if (failed) process.exit(1);
