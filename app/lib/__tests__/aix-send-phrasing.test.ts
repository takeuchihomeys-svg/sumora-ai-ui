// 2026-09-17 竹内（まりあ事例）: AIX の物件送付文から返信専用の言い回し（かしこまりました・全力でサポート）を落とす
// 実行: npx tsx app/lib/__tests__/aix-send-phrasing.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { stripReplyOnlyPhrases, SEND_CLOSER_LINE, AIX_SEND_REPLY_PHRASE_BAN } from "../aix-send-phrasing";

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

it("まりあ: 「かしこまりました！！」は落として本題を残し、「見つかるまで全力でサポート」の行は消える", () => {
  const draft = "まりあさんお世話になっております！！\n\nかしこまりました！！ペット可条件は外し、中央区・西区で西天満より南のエリアからWIC付き1LDKでまりあさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nまりあさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！";
  const out = stripReplyOnlyPhrases(draft);
  expect(out).notToContain("かしこまりました");
  expect(out).notToContain("全力でサポート");
  expect(out).toContain("ペット可条件は外し、中央区・西区で西天満より南のエリアからWIC付き1LDKでまりあさんにオススメできるお部屋ピックアップさせて頂きました！！");
  expect(out).toContain("まりあさんお世話になっております！！");
  // 締めが無くなったので実送信80%の締めを足す
  expect(out.endsWith(SEND_CLOSER_LINE)).toBe(true);
});
it("「かしこまりました！！」だけの行は行ごと消える", () => {
  const draft = "かしこまりました！！\n梅田エリアからオススメできるお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！";
  expect(stripReplyOnlyPhrases(draft)).toBe("梅田エリアからオススメできるお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！");
});
it("既に締めがある時は足さない（ご査収・ご案内の申し出・申込・如何でしょうか）", () => {
  const withGoshusyu = "かしこまりました！！お部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！";
  expect(stripReplyOnlyPhrases(withGoshusyu).split("\n").filter((l) => l.includes("ご査収")).length).toBe(1);
  const withInvite = "かしこまりました！！お部屋ピックアップさせて頂きました！！\nお気に召されましたらお部屋ご案内させて頂きます！！";
  expect(stripReplyOnlyPhrases(withInvite)).toBe("お部屋ピックアップさせて頂きました！！\nお気に召されましたらお部屋ご案内させて頂きます！！");
});
it("実送信の形（返信専用の言い回しが無い）は触らない", () => {
  const real = "まりあさんお世話になっております！！\n\n西天満より南のエリアから現在募集が出ているお部屋でまりあさんにオススメできるお部屋ピックアップさせて頂きました！！\nお気に召されお部屋ご案内させて頂きます！！\n\nお手隙の際にご査収ください😌！！";
  expect(stripReplyOnlyPhrases(real)).toBe(real);
  expect(stripReplyOnlyPhrases("")).toBe("");
});
it("落とすと空になる時は元のまま（安全側）", () => {
  expect(stripReplyOnlyPhrases("かしこまりました！！")).toBe("かしこまりました！！");
  const onlySupport = "まりあさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！";
  expect(stripReplyOnlyPhrases(onlySupport)).toBe(onlySupport);
});
it("言い回しのゆれ（承知いたしました・精一杯お探し・ご満足頂ける物件）も落ちる", () => {
  const draft = "承知いたしました！！難波エリアでピックアップさせて頂きました！！\nご満足頂ける物件が見つかるまで精一杯お探しさせて頂きます！！\nお手隙の際にご査収ください！！";
  const out = stripReplyOnlyPhrases(draft);
  expect(out).notToContain("承知いたしました");
  expect(out).notToContain("精一杯");
  expect(out).toContain("難波エリアでピックアップさせて頂きました！！");
});
it("物件オススメ（🌟の物件カード）は締めを足さない（「お手隙の際にご査収ください」は使わない決まり）", () => {
  const rec = "🌟グランパシフィック難波元町 5C\n\n（オススメポイント）\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n\nかしこまりました！！";
  const out = stripReplyOnlyPhrases(rec, { addCloser: false });
  expect(out).notToContain("かしこまりました");
  expect(out).notToContain("ご査収");
  expect(out).toContain("🌟グランパシフィック難波元町 5C");
});
it("指示の文（生成に渡す）に実データの根拠が入っている", () => {
  expect(AIX_SEND_REPLY_PHRASE_BAN).toContain("送りました」の報告");
  expect(AIX_SEND_REPLY_PHRASE_BAN).toContain("実送信0件");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
