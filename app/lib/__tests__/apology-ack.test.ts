// 2026-09-17 竹内（慶次事例）: お客様が謝っている場面は「かしこまりました」ではなく受け止めから入る
// 実行: npx tsx app/lib/__tests__/apology-ack.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveApologyOnly, ensureApologyOpener, buildApologyNote, APOLOGY_ACK_LINE } from "../apology-ack";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
  };
}

it("慶次 17:40「本当にご無理を言いまして申し訳ありません。よろしくお願い致します。」は謝罪だけ", () => {
  expect(resolveApologyOnly("本当にご無理を言いまして申し訳ありません。\nよろしくお願い致します。").apology).toBe(true);
  // 同じ会話の過去の発言（実送信で「とんでもございません」を返している）
  expect(resolveApologyOnly("ご無理を言いますが、よろしくお願い致します。").apology).toBe(true);
  expect(resolveApologyOnly("注文が多くてすみません。\nよろしくお願い致します。").apology).toBe(true);
  expect(resolveApologyOnly("ぽろぽろ質問してしまってすみません😭\nよろしくお願いいたします").apology).toBe(true);
});
it("謝罪と一緒に依頼が来ている時は従来どおり（かしこまりました で受ける場面）", () => {
  // 実送信で「かしこまりました」が使われている形
  expect(resolveApologyOnly("すいません、条件が追加でありまして…  保証人不要も追加でお願いします。").apology).toBe(false);
  expect(resolveApologyOnly("沢山送ってしまって申し訳ないです！こちらの6件お調べして頂きたいのですが").apology).toBe(false);
  expect(resolveApologyOnly("申し訳ありませんが、予定していた内覧をキャンセルさせていただきたいです。").apology).toBe(false);
  expect(resolveApologyOnly("こちらも合わせてお願いします！\n何度もすいません！").apology).toBe(false);
});
it("謝罪が無い発言・空は対象外", () => {
  expect(resolveApologyOnly("ありがとうございます！").apology).toBe(false);
  expect(resolveApologyOnly("").apology).toBe(false);
  expect(resolveApologyOnly(null).apology).toBe(false);
});

it("先頭の「かしこまりました！！」だけの行を受け止めに置き換える（慶次の下書き）", () => {
  const draft = "かしこまりました！！\n敷礼なしのお部屋で審査通過しやすい独立系保証会社採用のオススメできるお部屋ピックアップさせて頂きます！！\n慶次さんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！";
  const out = ensureApologyOpener(draft, true);
  expect(out.split("\n")[0]).toBe(APOLOGY_ACK_LINE);
  expect(out).toContain("敷礼なしのお部屋で審査通過しやすい");   // 本題はそのまま
});
it("挨拶行がある時はその次の行を見る・既に受け止めなら触らない", () => {
  const withGreeting = "慶次さんお世話になっております！！\nかしこまりました！！\nお部屋ピックアップさせて頂きます！！";
  expect(ensureApologyOpener(withGreeting, true).split("\n")[1]).toBe(APOLOGY_ACK_LINE);
  const already = "とんでもございません😊！！\nお部屋ピックアップ出来次第お送りさせて頂きます！！";
  expect(ensureApologyOpener(already, true)).toBe(already);
  const zenzen = "全然大丈夫です！！\nお送り頂きありがとうございます！！";
  expect(ensureApologyOpener(zenzen, true)).toBe(zenzen);
});
it("先頭行に本題が続いている時は触らない（受諾として正しい）・場面でなければ触らない", () => {
  const withBody = "かしこまりました！！6件の募集状況確認させて頂きます！！";
  expect(ensureApologyOpener(withBody, true)).toBe(withBody);
  const draft = "かしこまりました！！\nお部屋ピックアップさせて頂きます！！";
  expect(ensureApologyOpener(draft, false)).toBe(draft);
  expect(ensureApologyOpener("", true)).toBe("");
});
it("材料の文は場面の時だけ", () => {
  expect(buildApologyNote(false)).toBe("");
  expect(buildApologyNote(true)).toContain("お客様が謝っている場面");
  expect(buildApologyNote(true)).toContain(APOLOGY_ACK_LINE);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
