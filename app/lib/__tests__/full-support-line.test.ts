// 2026-09-18 竹内（ゆうこ事例）: 全力サポートは同じ会話・同じ日に1回だけ
// 実行: npx tsx app/lib/__tests__/full-support-line.test.ts
import { sentFullSupportToday, stripRepeatedFullSupport, buildFullSupportNote, CONTINUE_CLOSING_LINE } from "../full-support-line";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(s)}`); },
  };
}

// 2026-09-17 22:24 JST = 13:24 UTC
const NOW = Date.parse("2026-09-17T13:24:00Z");
const FS = "ゆうこさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！";

console.log("\n[今日すでに送ったか]");
it("同じ日（JST）のこちらの発言にあれば true", () => {
  expect(sentFullSupportToday([
    { sender: "staff", text: `かしこまりました！！\n${FS}`, created_at: "2026-09-17T04:10:00Z" }, // 13:10 JST 同日
  ], NOW)).toBe(true);
});
it("前の日なら false（日をまたげばまた言ってよい）", () => {
  expect(sentFullSupportToday([
    { sender: "staff", text: FS, created_at: "2026-09-16T13:10:00Z" }, // 9/16 22:10 JST
  ], NOW)).toBe(false);
});
it("JST の日付で数える（UTC 15:30 は翌日 0:30 JST）", () => {
  // 9/17 15:30 UTC = 9/18 0:30 JST → 9/17 22:24 JST とは別の日
  expect(sentFullSupportToday([{ sender: "staff", text: FS, created_at: "2026-09-17T15:30:00Z" }], NOW)).toBe(false);
  // 9/16 15:30 UTC = 9/17 0:30 JST → 同じ日
  expect(sentFullSupportToday([{ sender: "staff", text: FS, created_at: "2026-09-16T15:30:00Z" }], NOW)).toBe(true);
});
it("お客様の発言・別の文・時刻なしは数えない", () => {
  expect(sentFullSupportToday([{ sender: "customer", text: FS, created_at: "2026-09-17T04:10:00Z" }], NOW)).toBe(false);
  expect(sentFullSupportToday([{ sender: "staff", text: "お手隙の際にご査収ください😌！！", created_at: "2026-09-17T04:10:00Z" }], NOW)).toBe(false);
  expect(sentFullSupportToday([{ sender: "staff", text: FS }], NOW)).toBe(false);
  expect(sentFullSupportToday([], NOW)).toBe(false);
});

console.log("\n[2回目は落とす]");
const DRAFT = `かしこまりました！！
新大阪よりもう少し駅近な物件も含めて、御堂筋線周辺全域から5階以上・エレベーター必須でゆうこさんにオススメできるお部屋お送りさせて頂きます！！
新着でオススメ出来るお部屋募集に出次第お送りさせていただきます！！
${FS}`;
it("竹内さんの実送信と同じ形になる（全力サポートが落ちて締めが残る）", () => {
  const r = stripRepeatedFullSupport(DRAFT, true);
  expect(r.text).notToContain("全力でサポート");
  expect(r.text).toContain("新着でオススメ出来るお部屋募集に出次第お送りさせていただきます！！");
  expect(r.removed.length).toBe(1);
});
it("落として締めが無くなったら「引き続き何卒よろしくお願い致します！！」を足す", () => {
  const t = `かしこまりました！！\nお部屋ピックアップしお送りさせて頂きます！！\n${FS}`;
  const r = stripRepeatedFullSupport(t, true);
  expect(r.text.endsWith(CONTINUE_CLOSING_LINE)).toBe(true);
});
it("既に締めがあれば足さない（何卒・よろしくお願い・ご査収）", () => {
  const t = `お部屋お送りさせて頂きます！！\n${FS}\n引き続き何卒よろしくお願い致します！！`;
  const r = stripRepeatedFullSupport(t, true);
  expect((r.text.match(/何卒/g) ?? []).length).toBe(1);
});

console.log("\n[触らない形]");
it("今日1回目は触らない（1回は入れてよい＝実データ231件）", () => {
  expect(stripRepeatedFullSupport(DRAFT, false)).toBe({ text: DRAFT, removed: [] });
});
it("全力サポートが無い文・空文は触らない", () => {
  const t = "かしこまりました！！\nお部屋ピックアップしお送りさせて頂きます！！";
  expect(stripRepeatedFullSupport(t, true)).toBe({ text: t, removed: [] });
  expect(stripRepeatedFullSupport("", true)).toBe({ text: "", removed: [] });
});
it("落とすと空になる時は元のまま（安全側）", () => {
  expect(stripRepeatedFullSupport(FS, true)).toBe({ text: FS, removed: [] });
});

console.log("\n[生成の指示]");
it("今日送っている時だけ出る・代わりの書き方と根拠つき", () => {
  const note = buildFullSupportNote(true);
  expect(note).toContain("もう書かない");
  expect(note).toContain("新着でオススメ出来るお部屋募集に出次第お送りさせていただきます！！");
  expect(note).toContain(CONTINUE_CLOSING_LINE);
  expect(note).toContain("231件（90%）");
  expect(buildFullSupportNote(false)).toBe("");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
