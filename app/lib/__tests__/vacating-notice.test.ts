// 2026-09-17 竹内: AIX【物件確認した】退去予定のお部屋の伝え方（費用のマイナスの説明を入れない・内覧解禁日を入れる）
// 実行: npx tsx app/lib/__tests__/vacating-notice.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  viewableFromVacancyDate,
  vacatingViewableSentence,
  stripNegativeCostTalk,
  ensureVacatingNotice,
  buildVacatingPromptNote,
} from "../vacating-notice";

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

// 2026-09-17 12:00 JST 相当
const NOW = Date.parse("2026-09-17T03:00:00Z");

console.log("\n[内覧解禁日＝退去日の翌日]");
it("実送信の実例どおりに翌日を出す", () => {
  expect(viewableFromVacancyDate("9月27日", NOW)).toBe("9月28日");
  expect(viewableFromVacancyDate("8月31日", NOW)).toBe("9月1日");
  expect(viewableFromVacancyDate("9月30日", NOW)).toBe("10月1日");
  expect(viewableFromVacancyDate("10月15日", NOW)).toBe("10月16日");
  expect(viewableFromVacancyDate("8月29日", NOW)).toBe("8月30日");
});
it("旬・末も実送信どおり（8月末・8月下旬 → 9月1日）", () => {
  expect(viewableFromVacancyDate("9月末", NOW)).toBe("10月1日");
  expect(viewableFromVacancyDate("8月下旬", NOW)).toBe("9月1日");
  expect(viewableFromVacancyDate("9月中旬", NOW)).toBe("9月21日");
  expect(viewableFromVacancyDate("9月上旬", NOW)).toBe("9月11日");
});
it("年号つき・全角・年跨ぎ・読めない値", () => {
  expect(viewableFromVacancyDate("2026年9月30日", NOW)).toBe("10月1日");
  expect(viewableFromVacancyDate("９月２７日", NOW)).toBe("9月28日");
  expect(viewableFromVacancyDate("12月31日", Date.parse("2026-12-01T03:00:00Z"))).toBe("1月1日");
  expect(viewableFromVacancyDate("2月28日", Date.parse("2028-02-01T03:00:00Z"))).toBe("2月29日"); // 2028 は閏年
  expect(viewableFromVacancyDate("", NOW)).toBe(null);
  expect(viewableFromVacancyDate("未定", NOW)).toBe(null);
  expect(viewableFromVacancyDate("2月30日", NOW)).toBe(null);
  expect(viewableFromVacancyDate("9月", NOW)).toBe(null); // 日も旬も無い
});
it("文は実送信で最多の言い回し（51件）", () => {
  expect(vacatingViewableSentence("9月27日", NOW)).toBe("9月27日退去予定のため、9月28日以降にご内覧可能です！！");
  expect(vacatingViewableSentence("未定", NOW)).toBe(null);
});

console.log("\n[費用のマイナスの説明を落とす]");
it("竹内さんが指摘した文はまるごと落ちる", () => {
  const r = stripNegativeCostTalk("こちら9月27日に退去予定のお部屋となり、割引出来る金額が少なく礎金もかかりますので初期費用はかなりかかってしまう形となります！！\nお手隙の際にご査収ください😌！！");
  expect(r.text).toBe("お手隙の際にご査収ください😌！！");
  expect(r.removed.length).toBe(1);
});
it("プラスの費用の話は残す（最大限割引・敷金礼金なしで抑えられる）", () => {
  const ok = "最大限割引しました初期費用の御見積書同封させて頂きました！！\n敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n初期費用さらに🌟34,000円割引させて頂き";
  expect(stripNegativeCostTalk(ok).text).toBe(ok);
  expect(stripNegativeCostTalk(ok).removed.length).toBe(0);
});
it("同じ行の他の文は残る・全部落ちる時は元のまま（安全側）", () => {
  const r = stripNegativeCostTalk("現在募集中となります！！初期費用はかなりかかってしまう形となります！！");
  expect(r.text).toBe("現在募集中となります！！");
  expect(stripNegativeCostTalk("初期費用はかなりかかってしまう形となります！！").text).toBe("初期費用はかなりかかってしまう形となります！！");
  expect(stripNegativeCostTalk("").text).toBe("");
});

console.log("\n[生成文を実送信の形に揃える]");
it("竹内さんの生成文 → 実送信と同じ中身になる", () => {
  const draft = [
    "a🤫さん",
    "お送りいただきましたジュネスニッコー1003号室、現在募集中でご入居可能なお部屋となっております！！",
    "初期費用の御見積書同封させて頂きました😊！！",
    "",
    "こちら9月27日に退去予定のお部屋となり、割引出来る金額が少なく礎金もかかりますので初期費用はかなりかかってしまう形となります！！",
    "お気に召されましたらお申込しお部屋抑えさせて頂きますので、お手隙の際にご査収ください😌！！",
  ].join("\n");
  const { text, applied } = ensureVacatingNotice(draft, ["9月27日"], { nowMs: NOW });
  // ①費用のマイナスの説明が消える
  expect(text).notToContain("割引出来る金額が少な");
  expect(text).notToContain("礎金");
  expect(text).notToContain("かかってしまう");
  // ②退去予定で募集中（今すぐ入居できる、とは書かない）
  expect(text).toContain("ジュネスニッコー1003号室、現在退去予定で募集中となっております！！");
  expect(text).notToContain("ご入居可能なお部屋");
  // ③内覧解禁日が入る（締めの前）
  expect(text).toContain("9月27日退去予定のため、9月28日以降にご内覧可能です！！");
  expect(text.indexOf("9月28日以降") < text.indexOf("お手隙の際にご査収")).toBe(true);
  expect(text).toContain("初期費用の御見積書同封させて頂きました😊！！");
  expect(applied).toBe(["negative_cost:1", "ready_phrase", "inserted:9月27日"]);
});
it("退去予定に触れた文があればその文を置き換える（行ごと増やさない）", () => {
  const draft = "ジュネスニッコー1003号室現在募集中となります！！\n9月27日退去予定のお部屋となります！！\n最大限割引しました御見積書同封させて頂きました！！\n\nお気に召されましたらお申込みしお部屋を抑えさせていただきます！！";
  const { text } = ensureVacatingNotice(draft, ["9月27日"], { nowMs: NOW });
  expect(text).toContain("9月27日退去予定のため、9月28日以降にご内覧可能です！！");
  expect(text).notToContain("9月27日退去予定のお部屋となります！！");
  expect(text.split("\n").length).toBe(draft.split("\n").length);
});
it("既に内覧解禁日を案内していれば触らない（実送信の形）", () => {
  const real = "お送りいただきましたジュネスニッコー1003号室、現在退去予定で募集中となっております！！\n初期費用の御見積書同封させて頂きました😊！！\n\nこちら9月27日に退去予定のお部屋となりますので9月28日以降ご内覧可能となります！！\nお手隙の際にご査収ください😌！！";
  expect(ensureVacatingNotice(real, ["9月27日"], { nowMs: NOW })).toBe({ text: real, applied: [] });
});
it("退去日が無い・読めない時は費用の掃除だけ（内覧日は作らない）", () => {
  const draft = "ジュネスニッコー1003号室現在募集中となります！！\n初期費用はかなりかかってしまう形となります！！\nお手隙の際にご査収ください😌！！";
  const { text } = ensureVacatingNotice(draft, ["", null, "未定"], { nowMs: NOW });
  expect(text).notToContain("かかってしまう");
  expect(text).notToContain("以降にご内覧可能");
});
it("複数の退去予定日（それぞれ1文ずつ・重複は1つ）", () => {
  const draft = "・スワンズシティ大阪イースト 906号室\n・クレストコート O&K 102号室\nこちら2件現在募集中となります！！\nお手隙の際にご査収ください！！";
  const { text } = ensureVacatingNotice(draft, ["8月31日", "9月30日", "8月31日"], { nowMs: NOW });
  expect(text).toContain("8月31日退去予定のため、9月1日以降にご内覧可能です！！");
  expect(text).toContain("9月30日退去予定のため、10月1日以降にご内覧可能です！！");
  expect(text.split("8月31日退去予定のため").length - 1).toBe(1);
});
it("締めが無ければ末尾に足す・空文は触らない", () => {
  const { text } = ensureVacatingNotice("ジュネスニッコー1003号室現在募集中となります！！", ["9月27日"], { nowMs: NOW });
  expect(text.endsWith("9月27日退去予定のため、9月28日以降にご内覧可能です！！")).toBe(true);
  expect(ensureVacatingNotice("", ["9月27日"], { nowMs: NOW }).text).toBe("");
});

console.log("\n[生成に渡す材料・指示]");
it("退去日が読める物件だけ並び、禁止の根拠が実データで書かれている", () => {
  const note = buildVacatingPromptNote(
    [{ name: "ジュネスニッコー1003号室", vacDate: "9月27日" }, { name: "未定の物件", vacDate: "" }],
    { nowMs: NOW },
  );
  expect(note).toContain("・ジュネスニッコー1003号室: 9月27日退去予定 → 9月28日以降ご内覧可能");
  expect(note).notToContain("未定の物件");
  expect(note).toContain("現在退去予定で募集中");
  expect(note).toContain("実送信277件中0件");
  expect(buildVacatingPromptNote([], { nowMs: NOW })).toBe("");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
