// 2026-09-17 竹内（a🤫 事例）: 物件名を並べた直後の「複数の物件について」を落とす
// 実行: npx tsx app/lib/__tests__/vague-quantifier.test.ts
import { stripVagueQuantifier, VAGUE_QUANTIFIER_NOTE } from "../vague-quantifier";

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

const DRAFT = "かしこまりました！！\n生野西一丁目戸建・阪南町3丁目3L戸建て・天神ノ森3SLDK、複数の物件について募集状況確認させて頂きます！！\n本日は管理会社の営業時間が終了しておりますので、明日一番で確認しご連絡させて頂きます😌！！";
const SENT = "かしこまりました！！\n生野西一丁目戸建・阪南町3丁目3L戸建て・天神ノ森3SLDK、の物件について募集状況確認させて頂きます！！\n本日は管理会社の営業時間が終了しておりますので、明日一番で確認しご連絡させて頂きます😌！！";

console.log("\n[竹内さんの通]");
it("AI 下書き → 実送信と同じ文になる", () => {
  const r = stripVagueQuantifier(DRAFT);
  expect(r.text).toBe(SENT);
  expect(r.removed).toBe(["複数の物件について"]);
});
it("実送信の形は触らない", () => {
  expect(stripVagueQuantifier(SENT)).toBe({ text: SENT, removed: [] });
});

console.log("\n[落とす形]");
it("「複数件」「3件の物件」も列挙の直後なら落とす", () => {
  const a = "A戸建・Bマンション・Cハイツ、複数のお部屋について確認させて頂きます！！";
  expect(stripVagueQuantifier(a).text).toBe("A戸建・Bマンション・Cハイツ、のお部屋について確認させて頂きます！！");
  const b = "A戸建・Bマンション、これらの物件について確認させて頂きます！！";
  expect(stripVagueQuantifier(b).text).toBe("A戸建・Bマンション、の物件について確認させて頂きます！！");
});
it("読点が無い時は繋ぎ語を足さない", () => {
  const t = "A戸建・Bマンション・Cハイツ 複数の物件を確認させて頂きます！！";
  expect(stripVagueQuantifier(t).text).toBe("A戸建・Bマンション・Cハイツ を確認させて頂きます！！");
});

console.log("\n[触らない形]");
it("物件名の列挙が無い文は触らない（別の文脈の「複数の」は担当外）", () => {
  const a = "当日は複数のお部屋を比較しながらご相談頂けますので、何卒よろしくお願い致します！！";
  expect(stripVagueQuantifier(a)).toBe({ text: a, removed: [] });
  const b = "複数の物件について募集状況確認させて頂きます！！";
  expect(stripVagueQuantifier(b)).toBe({ text: b, removed: [] });
});
it("件数を書く形（物件名を並べない）は触らない＝実送信32件の型", () => {
  const t = "お部屋お送り頂きありがとうございます😊！！\nお送り頂きました3件、募集状況確認させて頂きます！！";
  expect(stripVagueQuantifier(t)).toBe({ text: t, removed: [] });
});
it("別の行の列挙に引きずられない（文ごとに見る）", () => {
  const t = "A戸建・Bマンション、の物件について確認させて頂きます！！\n当日は複数のお部屋ご案内可能です！！";
  expect(stripVagueQuantifier(t)).toBe({ text: t, removed: [] });
});
it("空文・列挙だけの文は触らない", () => {
  expect(stripVagueQuantifier("")).toBe({ text: "", removed: [] });
  expect(stripVagueQuantifier("A戸建・Bマンション・Cハイツ")).toBe({ text: "A戸建・Bマンション・Cハイツ", removed: [] });
});

console.log("\n[生成の指示]");
it("2通りの書き方と実データの根拠が入っている", () => {
  expect(VAGUE_QUANTIFIER_NOTE).toContain("物件名を「・」で並べたら");
  expect(VAGUE_QUANTIFIER_NOTE).toContain("お送り頂きました3件");
  expect(VAGUE_QUANTIFIER_NOTE).toContain("208通のうち「複数の物件／複数のお部屋」は0件");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
