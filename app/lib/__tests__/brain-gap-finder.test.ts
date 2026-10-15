// 2026-10-15 ブレインの穴を自分で見つける見張り（brain-gap-finder.ts）。お客様の発言は実物の形（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/brain-gap-finder.test.ts
import { findingsOfTurn, todayTagsOf, classifyCause, longOpenItems, reopenedItems, summarizeGaps, brief, isBroughtBundle, brainGapFinderEnabled, type GapTurn } from "../brain-gap-finder";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

const base = (o: Partial<GapTurn>): GapTurn => ({
  id: 1, conversationId: "abcdef0123456789", turnAt: "2026-10-12T05:00:00.000Z", status: "proposing",
  customerText: "", prevStaffText: "", prevCheckPattern: null, staffTexts: [], staffWriter: "takeuchi", staffAix: [],
  draft: null, sentinel: null, brainAction: null, brainReplyMode: "auto_reply", verdict: "partial", detail: { reason: "acts_missing", text_verdict: "partial" },
  finalCodes: [], digest: null, materialBefore: false, firstBrought: false, companyFactHit: false, axis: null, situation: null, demotedOverrides: 0, exitEdits: 0, ...o,
});

it("内覧の日が決まった後の駐車場 → 軸の読み違い（いつの事）", () => {
  const t = base({ customerText: "ありがとうございます！ 駐車場ってありますか？", prevStaffText: "明日14時のご内覧お待ちしております！！", draft: "駐車場の空き状況確認させて頂きます！！", staffTexts: ["はい😊！！近くのコインパーキングにお停め頂けますと幸いです！！"] });
  const f = findingsOfTurn(t);
  eq(f.map((x) => x.kind), ["edited"]);
  eq(f[0].cause, "axis"); ok(f[0].sub.startsWith("when:"), f[0].sub); ok(f[0].tags.includes("parking"));
});
it("送った物件への予算オーバー → 軸の読み違い（about）", () => {
  const t = base({ customerText: "すみません💦 予算オーバーです", materialBefore: true, draft: "かしこまりました！！ご予算内で探させて頂きます！！", staffTexts: ["ご査収頂き有難うございます！！"] });
  const f = findingsOfTurn(t)[0];
  eq(f.cause, "axis"); ok(f.tags.includes("budget_over"));
});
it("送った資料がある設備の質問で約束に倒れた → 材料が届いていない", () => {
  const t = base({ customerText: "ここって洗面台とトイレ一緒な感じですか？", materialBefore: true, draft: "確認させて頂きます！！", staffTexts: ["こちらのお部屋は洗面台とトイレが同じ間取りとなっております！！"] });
  const f = findingsOfTurn(t)[0];
  eq(f.cause, "material"); ok(f.tags.includes("washstand"));
});
it("繁忙期の一般の質問で会社の事実に無い → 知識の不足", () => {
  const t = base({ customerText: "4月等の繁忙期より今の方が家賃安いですか？", draft: "確認させて頂きます！！", staffTexts: ["はい！！繁忙期はお部屋探しの方が多いため…"] });
  eq(findingsOfTurn(t)[0].cause, "knowledge");
});
it("会社の事実に当たるのに約束 → 材料が届いていない", () => {
  const t = base({ customerText: "初期費用カード払いできますか？", companyFactHit: true, kind: undefined, draft: "確認させて頂きます！！", staffTexts: ["はい！！カード払い可能です😊！！"] } as Partial<GapTurn>);
  eq(findingsOfTurn(t)[0].cause, "material");
});
it("規則が LLM の AIX を変え、スタッフは LLM の AIX を押した → 決まりがブレインを上書き", () => {
  const t = base({ verdict: "different", detail: { reason: "aix_other" }, digest: { la: "property_check_result", aix: null, ds: "rule:two_stage_promise(brought_both)" }, staffAix: ["property_check_result"], brainAction: "" });
  const f = findingsOfTurn(t);
  eq(f.map((x) => [x.kind, x.cause]), [["brain_mismatch", "rule_override"]]);
});
it("2番手の申込の流れ → 状況の把握の不足", () => {
  const t = base({ customerText: "お願いします", prevStaffText: "現在1番手の方が審査中で、2番手でのお申込みとなります", draft: "かしこまりました！！", staffTexts: ["〇〇号室お申込し、並行してお部屋お探しさせて頂きます！！"] });
  const f = findingsOfTurn(t)[0];
  eq(f.cause, "situation"); ok(f.tags.includes("second_applicant"));
});
it("募集なしの後に内覧へ誘った下書き → 状況（募集なしの後の誘い）", () => {
  const t = base({ customerText: "ありがとうございます！", prevCheckPattern: "unavailable", draft: "ありがとうございます！！ご都合よろしいお日にちにご内覧いかがでしょうか！！", staffTexts: ["ありがとうございます！！何卒よろしくお願い致します😌！！"] });
  const f = findingsOfTurn(t)[0];
  eq(f.cause, "situation"); ok(f.tags.includes("invite_after_unavailable"));
});
it("ペット可を外す（じゃなくてもいい）→ 軸（polarity）", () => {
  const t = base({ customerText: "ペット可じゃなくてもいいです", draft: "ペット不可のお部屋は外して探させて頂きます！！", staffTexts: ["かしこまりました！！ペット可以外のお部屋も含めて…"] });
  eq(findingsOfTurn(t)[0].cause, "axis");
});
it("文がスタッフと同じなら中身の型に数えない（返信か AIX かだけ）", () => {
  const t = base({ customerText: "今日って車で行っても良いですか？", prevStaffText: "本日14時のご内覧お待ちしております", draft: "車でお越し頂いて大丈夫です😊！！", staffTexts: ["車でお越し頂いて大丈夫です😊！！"], verdict: "different", detail: { reason: "text_but_staff_fact", text_verdict: "same" } });
  const f = findingsOfTurn(t);
  eq(f.map((x) => x.cause), ["unknown"]);
});
it("新しい軸（about）が入った後はその値で照らす", () => {
  const t = base({ customerText: "駐車場ってありますか？", draft: "空き状況確認させて頂きます！！", staffTexts: ["近くのコインパーキングにお停め頂けますと幸いです！！"], axis: [{ about: "property_equipment", when: "now" }] });
  const c = classifyCause(t, "edited", todayTagsOf(t));
  eq(c.cause, "axis"); ok(c.sub.includes("about=property_equipment"));
});
it("初回の持ち込みで下書きに最大限割引の見積の一言が無い", () => {
  const t = base({ firstBrought: true, customerText: "ここ空いてますか？", draft: "お送り頂きました物件の募集状況確認させて頂きます！！", staffTexts: ["お部屋の募集状況確認させて頂き、最大限割引させて頂いた御見積書も合わせてお送りさせて頂きます！！"] });
  const f = findingsOfTurn(t).find((x) => x.kind === "brought_no_estimate");
  ok(f); eq(f!.cause, "knowledge");
  const t2 = base({ ...t, draft: "募集状況確認させて頂き、最大限割引させて頂いた初期費用の御見積書もお送りさせて頂きます！！" });
  eq(findingsOfTurn(t2).some((x) => x.kind === "brought_no_estimate"), false);
});
it("取りこぼし系の最終チェックが残った番は final_miss", () => {
  const t = base({ finalCodes: ["MISSED_QUESTION:warning"], verdict: "same", detail: { reason: "exact", text_verdict: "same" }, draft: "x", staffTexts: ["x"] });
  eq(findingsOfTurn(t).map((x) => x.kind), ["final_miss"]);
});
it("穴の無い番は何も出さない", () => {
  eq(findingsOfTurn(base({ verdict: "same", detail: { reason: "exact", text_verdict: "same" }, draft: "x", staffTexts: ["x"] })), []);
});
it("要旨は名前の呼びかけと URL を伏せて30字まで", () => {
  eq(brief("ゆりさんご査収頂き有難うございます！！ https://suumo.jp/x"), "〇〇さんご査収頂き有難うございます！！ [URL]");
  eq(brief(""), "（画像・資料・様式だけ）");
  eq([...brief("あ".repeat(50))].length, 30);
});
it("持ち込みの束（ポータルの URL）", () => {
  ok(isBroughtBundle("ここ空いてますか\nhttps://suumo.jp/chintai/jnc_000/"));
  eq(isBroughtBundle("ありがとうございます"), false);
});
it("確認事項: 48時間以上の未対応・完了の後の問い直し", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");
  const items = [
    { quote: "初期費用いくらですか", topic: "cost", status: "open" as const, saidAt: "2026-10-10T00:00:00Z" },
    { quote: "空いてますか", topic: "vacancy", status: "done" as const, saidAt: "2026-10-12T00:00:00Z", doneAt: "2026-10-12T01:00:00Z" },
    { quote: "来年また相談", topic: "pickup", status: "open" as const, saidAt: "2026-10-10T00:00:00Z", deferred: true },
  ];
  eq(longOpenItems(items, now).map((x) => x.topic), ["cost"]);
  const msgs = [{ sender: "customer", text: "ここはまだ募集出てますか？", createdAt: "2026-10-12T05:00:00Z" }];
  const r = reopenedItems(items, msgs, (s) => (/募集|空/.test(s) ? ["vacancy"] : []));
  eq(r.map((x) => x.item.topic), ["vacancy"]);
});
it("まとめ: 型ごとの数・前の週との差（同じ番の同じ原因は1つ）", () => {
  const t = base({ customerText: "すみません 予算オーバーです", materialBefore: true, draft: "条件変えて探します", staffTexts: ["ご査収頂き有難うございます"], finalCodes: ["CONCERN_UNADDRESSED:warning"] });
  const cur = findingsOfTurn(t);
  eq(cur.length, 2);
  const s = summarizeGaps(cur, [], 10);
  eq(s.byCause.find((c) => c.cause === "axis")!.n, 1);
  eq(s.byCause.find((c) => c.cause === "axis")!.diff, 1);
  eq(s.byTag.find((x) => x.tag === "budget_over")!.n, 1);
});
it("戻す環境変数 BRAIN_GAP_FINDER=off", () => {
  eq(brainGapFinderEnabled({}), true);
  eq(brainGapFinderEnabled({ BRAIN_GAP_FINDER: "off" }), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  ✗", f); process.exit(1); }
