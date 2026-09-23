// 2026-09-18 竹内（𝒮 さん事例）: 1件しか送っていないなら比較の言い方を書かない／まだ内覧できない部屋は申込誘導
// 実行: npx tsx app/lib/__tests__/recommend-closing.test.ts
import { fixRecommendClosing, stillNotViewable, buildRecommendClosingNote, APPLY_CLOSING_LINE } from "../recommend-closing";

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

// 2026-09-18 12:00 JST 相当（9/30 退去予定 → 10/1 解禁 ＝ まだ内覧できない）
const NOW = Date.parse("2026-09-18T03:00:00Z");
const DRAFT = `お送りさせて頂きましたお部屋の中でも特にUMEDA ILAND REIDENCE 302号室が築年数も新しく費用を抑える事ができ、かなりオススメ出来るお部屋となります！！

家賃67,000円・管理費7,000円（合計74,000円）、洋室8.2帖の1K、2019年2月築（築7年）、野田阪神駅徒歩6分、敷金礼金なしで初期費用も抑えられます！！

9月30日退去予定のため10月1日以降にご内覧可能です！！お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！`;

console.log("\n[まだ内覧できないか]");
it("9月30日退去予定は 9/18 時点ではまだ内覧できない", () => {
  expect(stillNotViewable("9月30日退去予定のため10月1日以降にご内覧可能です！！", NOW)).toBe(true);
});
it("退去日が過ぎていれば内覧できる・退去予定が無い文は false", () => {
  expect(stillNotViewable("8月31日退去予定のため9月1日以降にご内覧可能です！！", NOW)).toBe(false);
  expect(stillNotViewable("現在空室でご内覧可能です！！", NOW)).toBe(false);
  expect(stillNotViewable("", NOW)).toBe(false);
});

console.log("\n[竹内さんの通]");
it("1件だけ送った＋まだ内覧できない → 比較の言い方が消えて申込誘導になる", () => {
  const r = fixRecommendClosing(DRAFT, { sentPropertyCount: 1, nowMs: NOW });
  expect(r.text).notToContain("お送りさせて頂きましたお部屋の中でも");
  expect(r.text.startsWith("UMEDA ILAND REIDENCE 302号室が")).toBe(true);
  expect(r.text).notToContain("ご都合よろしいお日にちにお部屋ご案内");
  expect(r.text).toContain(APPLY_CLOSING_LINE);
  expect(r.text).toContain("9月30日退去予定のため10月1日以降にご内覧可能です！！");
  expect(r.applied).toBe(["comparison_frame", "apply_instead_of_viewing"]);
});

console.log("\n[それぞれ単独]");
it("2件以上送っていれば比較の言い方は残す（実データ179件の型）", () => {
  const r = fixRecommendClosing(DRAFT, { sentPropertyCount: 3, nowMs: NOW });
  expect(r.text).toContain("お送りさせて頂きましたお部屋の中でも特に");
  expect(r.applied).toBe(["apply_instead_of_viewing"]);
});
it("今ご内覧頂けるお部屋は内覧誘導のまま", () => {
  const t = "こちらのお部屋は現在空室でご内覧可能です！！\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
  expect(fixRecommendClosing(t, { sentPropertyCount: 1, nowMs: NOW })).toBe({ text: t, applied: [] });
});
it("既に申込の誘導があれば内覧誘導を落とすだけ（申込を2つ書かない）", () => {
  const t = "9月30日退去予定のため10月1日以降にご内覧可能です！！\nお気に召されましたらお申込しお部屋抑えさせて頂きます！！\nお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！";
  const r = fixRecommendClosing(t, { sentPropertyCount: 3, nowMs: NOW });
  expect(r.applied).toBe(["viewing_invite_removed"]);
  expect((r.text.match(/お申込/g) ?? []).length).toBe(1);
});
it("比較の言い方が無い文・空文は触らない", () => {
  const t = "UMEDA ILAND REIDENCE 302号室がかなりオススメ出来るお部屋となります！！";
  expect(fixRecommendClosing(t, { sentPropertyCount: 1, nowMs: NOW })).toBe({ text: t, applied: [] });
  expect(fixRecommendClosing("", { sentPropertyCount: 1, nowMs: NOW })).toBe({ text: "", applied: [] });
});

console.log("\n[生成の指示]");
it("ブレインが知っている状況（件数・内覧可否）がそのまま文になる", () => {
  const a = buildRecommendClosingNote({ sentPropertyCount: 1, notViewable: true });
  expect(a).toContain("お送りした物件は1件");
  expect(a).toContain("比較の言い方は書かない");
  expect(a).toContain("申込の誘導");
  expect(a).toContain("申込34件 vs 内覧9件");
  expect(a).toContain("煽りは書かない");
  const b = buildRecommendClosingNote({ sentPropertyCount: 4, notViewable: false });
  expect(b).toContain("比較の言い方が使える");
  expect(b).toContain("締めは内覧の誘導");
});
// 2026-09-23: 退去予定の通の締めは誘導なし79%（申込34 vs 内覧9 は誘導がある時だけ）→ 締め自体を必須に読ませない
it("退去予定でも締めの誘導は必須ではない・空室では申込の一文を書かない", () => {
  const a = buildRecommendClosingNote({ sentPropertyCount: 1, notViewable: true });
  expect(a).toContain("必須ではない");
  expect(a).toContain("誘導を入れるなら");
  const b = buildRecommendClosingNote({ sentPropertyCount: 4, notViewable: false });
  expect(b).toContain("申込の一文は書かない");
  expect(b).toContain("4.7%");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
