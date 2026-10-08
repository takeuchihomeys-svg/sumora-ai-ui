// 2026-10-08 把握「お客様の事情」（customer-circumstances.ts）
// 実行: npx tsx app/lib/__tests__/customer-circumstances.test.ts
// お客様の発言は実物（scripts/audit-customer-circumstances.ts で読んだ物・名前と物件名は伏せた）
import { extractCircumstances, validCircumstances, circumstanceDelaysViewing, buildCircumstancesNote, resolveDateExpr } from "../customer-circumstances";
import { buildAppealInput, resolveAppealTiming } from "../appeal-timing";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 160))} to contain ${JSON.stringify(sub)}`); }
const jst = (s: string) => Date.parse(`${s}+09:00`);
const md = (ms: number) => { const d = new Date(ms + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const one = (text: string, at: string) => extractCircumstances([{ text, createdAt: new Date(jst(at)).toISOString() }], jst(at) + 1);
const kinds = (text: string, at = "2026-09-01T12:00:00") => extractCircumstances([{ text, createdAt: new Date(jst(at)).toISOString() }], jst(at)).map((c) => c.kind);

console.log("日付の言い方 → 暦日（言った日が基準）");
it("9月13日以降（8/30 に言った）→ 9/13", () => eq(md(resolveDateExpr("9月13日以降", jst("2026-08-30T15:24:00"))!), "9/13"));
it("10月頭（8/31）→ 10/1", () => eq(md(resolveDateExpr("10月頭", jst("2026-08-31T19:06:00"))!), "10/1"));
it("22日（6/18）→ 6/22", () => eq(md(resolveDateExpr("22日", jst("2026-06-18T15:03:00"))!), "6/22"));
it("5日（6/18）→ 来月の 7/5", () => eq(md(resolveDateExpr("5日", jst("2026-06-18T15:03:00"))!), "7/5"));
it("1月（12/10）→ 来年の 1/1", () => { const d = new Date(resolveDateExpr("1月", jst("2026-12-10T10:00:00"))! + 9 * 3600_000); eq(`${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`, "2027/1"); });
it("来週末（水曜 10/7）→ 10/17（土）", () => eq(md(resolveDateExpr("来週末", jst("2026-10-07T10:00:00"))!), "10/17"));

console.log("お客様の都合（〇日以降・帰国）＝実物");
it("「内覧したいんですが都合つくのが9月13日以降の予定なんですが」→ 9/13〜", () => {
  const c = one("ありがとうございます！\n内覧したいんですが都合つくのが9月13日以降の予定なんですが、今見てる物件埋まる可能性高いですかね", "2026-08-30T15:24:00");
  eq(c.map((x) => x.kind), ["available_from"]); eq(md(c[0].fromDayMs!), "9/13");
});
it("「週末が大阪にいないため22日以降になってしまいそうです」→ 6/22〜", () => {
  const c = one("〇〇の内覧ですが、週末が大阪にいないため22日以降になってしまいそうです😭", "2026-06-18T15:03:00");
  eq(c[0].kind, "available_from"); eq(md(c[0].fromDayMs!), "6/22");
});
it("「31日以降の内見お願い致します」→ 7/31〜", () => { const c = one("31日以降の内見お願い致します", "2026-07-24T12:33:00"); eq(md(c[0].fromDayMs!), "7/31"); });
it("「今海外にて10月頭に日本に帰ります」→ 10/1〜＋遠方", () => {
  const c = one("よろしくお願いします\n初期費用を抑えたいです\n今海外にて10月頭に日本に帰ります", "2026-08-31T19:06:00");
  eq(c.map((x) => x.kind).sort(), ["available_from", "remote"]); eq(md(c.find((x) => x.kind === "available_from")!.fromDayMs!), "10/1");
});
it("「9月20日に大阪に来ます」→ 9/20〜", () => eq(md(one("9月20日に大阪に来ます", "2026-09-16T19:25:00")[0].fromDayMs!), "9/20"));

console.log("お客様の都合ではない物は読まない（線: 180日の当たりを目で読んで外した形）");
it("お部屋の内覧の可否の質問「7月中旬以降ならすぐに内見できるのでしょうか」", () => eq(kinds("〇〇は7月中旬以降ならすぐに内見できるのでしょうか??"), []));
it("退去予定の話「資料に8月中旬退去予定と書いてあるので、今すぐは難しそう」", () => eq(kinds("〇〇の方は資料に8月中旬退去予定と書いてあるので、今すぐは難しそうでしょうか"), []));
it("入居の時期「入居希望時期が8月30日以降なのですが」", () => eq(kinds("入居希望時期が8月30日以降なのですが、まだ内覧時期としては早いですか"), []));
it("仮定の質問「仮に6月中旬一発目に見に行けたとしたらどうですか」", () => eq(kinds("仮に6月中旬一発目に見に行けたとしたらどうですか?"), []));
it("お部屋の質問「10月16日から内覧できるんでしょ??」", () => eq(kinds("10月16日から内覧できるんでしょ??"), []));
it("入居の希望「9月中旬あたりで行けるとこ探して欲しいです」", () => eq(kinds("9月中旬あたりで行けるとこ探して欲しいです"), []));
it("ルールの質問「お申し込みが入ってる場合は内見は行けない感じですか」", () => eq(kinds("お申し込みが入ってる場合は内見は行けない感じですか?"), []));
it("条件のフォームの中の家族は読まない", () => eq(kinds("①【ご入居の時期】⇒冬\n⑧【その他ご要望あれば】⇒子ども二人シングルマザー 主人と相談"), []));
it("申込の書類の貼り付け「就職、転職の方は『無し』を選択」は読まない", () => eq(kinds("就職、転職の方は『無し』を選択のうえ、就業を証明する書類"), []));
it("保証の話の親「保証会社様から親に連絡行くことできたらさけたく」は同行者でない", () => eq(kinds("前と同じくなのですが、保証会社様から親に連絡行くことできたらさけたく(T ^ T"), []));

console.log("しばらく来られない・遠方・時期の事情・同行者・体調");
it("「今月前半結構予定詰まってて」→ しばらく来られない", () => eq(kinds("今月前半結構予定詰まってて🥲"), ["cannot_come_soon"]));
it("「現在出張中のため、そちらへ伺うことができません」", () => eq(kinds("現在出張中のため、そちらへ伺うことができません"), ["cannot_come_soon"]));
it("「今が広島に住んでいて、内見が難しい状況」→ 遠方", () => eq(kinds("今が広島に住んでいて、内見が難しい状況なのですが、写真だけ見て契約とかはできるのでしょうか？"), ["remote"]));
it("「現在、東京在住なのですが」→ 遠方", () => eq(kinds("現在、東京在住なのですが貴社からの物件に興味があります"), ["remote"]));
it("「会社の移動先が変わるかもしれなくて」→ 時期の事情", () => eq(kinds("すみません！\n4日内見予約させてもらっていたのですが、会社の移動先が変わるかもしれなくて一旦キャンセルさせてもらってもいいですか？"), ["life_timing"]));
it("「11月の更新をせずに」→ 時期の事情", () => eq(kinds("11月の更新をせずに\n引越ししたいなと、思うのです"), ["life_timing"]));
it("「木曜日だと主人が行けなくて」→ 同行者", () => eq(kinds("木曜日だと主人が行けなくて、私一人なのでその場で決め切ることが出来ず"), ["companion"]));
it("「昨夜から熱があり」→ 体調", () => eq(kinds("すいません、昨夜から熱があり現在38.1度とかなりしんどいので"), ["health"]));

console.log("鮮度");
it("〇日以降は日付が過ぎたら落ちる（9/13 以降 → 9/14 には無い）", () => {
  const c = one("内覧したいんですが都合つくのが9月13日以降の予定なんですが", "2026-08-30T15:24:00");
  eq(validCircumstances(c, jst("2026-09-05T10:00:00")).length, 1);
  eq(validCircumstances(c, jst("2026-09-14T10:00:00")).length, 0);
});
it("体調は5日で落ちる", () => { const c = one("昨夜から熱があり", "2026-09-08T16:58:00"); eq(validCircumstances(c, jst("2026-09-15T10:00:00")).length, 0); });
it("同じ種類は新しい方だけ", () => {
  const c = extractCircumstances([
    { text: "都合つくのが9月13日以降の予定です", createdAt: new Date(jst("2026-08-30T15:00:00")).toISOString() },
    { text: "やっぱり20日以降で内見お願いします", createdAt: new Date(jst("2026-09-02T15:00:00")).toISOString() },
  ], jst("2026-09-03T00:00:00"));
  const v = validCircumstances(c, jst("2026-09-03T10:00:00"));
  eq(v.length, 1); eq(md(v[0].fromDayMs!), "9/20");
});

console.log("すぐ来られない（訴求）・注記");
it("2日より先の〇日以降・遠方・しばらく来られない＝すぐ来られない／明日以降は当てない", () => {
  const now = jst("2026-09-05T10:00:00");
  eq(circumstanceDelaysViewing(validCircumstances(one("都合つくのが9月13日以降の予定です", "2026-08-30T15:00:00"), now), now), true);
  eq(circumstanceDelaysViewing(validCircumstances(one("6日以降の内見お願い致します", "2026-09-05T09:00:00"), now), now), false);
  eq(circumstanceDelaysViewing(validCircumstances(one("今が広島に住んでいて", "2026-09-01T09:00:00"), now), now), true);
});
it("注記: 暦日・今日から何日後・言った日・お客様の言葉", () => {
  const now = jst("2026-09-08T10:00:00");
  const v = validCircumstances(one("内覧したいんですが都合つくのが9月13日以降の予定なんですが", "2026-08-30T15:24:00"), now);
  const n = buildCircumstancesNote(v, { nowMs: now, scene: "viewing" });
  has(n, "9/13（日） 以降（今日から5日後）"); has(n, "8/30（日） の発言"); has(n, "都合つくのが9月13日以降");
});
it("注記: 場面に要らない物は出さない（同行者は条件の場面では出さない・今回の発言なら出す）", () => {
  const now = jst("2026-09-08T10:00:00");
  const old = validCircumstances(one("木曜日だと主人が行けなくて", "2026-09-07T10:00:00"), now);
  eq(buildCircumstancesNote(old, { nowMs: now, scene: "conditions" }), "");
  const cur = validCircumstances(extractCircumstances([{ text: "木曜日だと主人が行けなくて", createdAt: new Date(now - 1000).toISOString() }], now - 5000), now);
  has(buildCircumstancesNote(cur, { nowMs: now, scene: "conditions" }), "同行・一緒に決める人");
});
it("CUSTOMER_CIRCUMSTANCES=off で注記なし・APPEAL_CIRCUMSTANCES=off ですぐ来られないに数えない", () => {
  const now = jst("2026-09-05T10:00:00");
  const v = validCircumstances(one("都合つくのが9月13日以降の予定です", "2026-08-30T15:00:00"), now);
  process.env.CUSTOMER_CIRCUMSTANCES = "off"; eq(buildCircumstancesNote(v, { nowMs: now, scene: "viewing" }), ""); delete process.env.CUSTOMER_CIRCUMSTANCES;
  process.env.APPEAL_CIRCUMSTANCES = "off"; eq(circumstanceDelaysViewing(v, now), false); delete process.env.APPEAL_CIRCUMSTANCES;
});

console.log("訴求のタイミング（appeal-timing）に効く: 実物 r 8/30");
it("内覧の希望＋前の発言の「9/13以降」＝申込で抑えた状態でご内覧（人の文と同じ向き）", () => {
  const msgs = [
    { sender: "staff", text: "🌟〇〇 7階\n家賃8.5万円…オススメ出来るお部屋となります😊！！", createdAt: new Date(jst("2026-08-30T12:00:00")).toISOString() },
    { sender: "customer", text: "ありがとうございます！\n都合つくのが9月13日以降の予定なんですが", createdAt: new Date(jst("2026-08-30T15:20:00")).toISOString() },
    { sender: "staff", text: "かしこまりました！！", createdAt: new Date(jst("2026-08-30T15:22:00")).toISOString() },
    { sender: "customer", text: "内覧したいです！", createdAt: new Date(jst("2026-08-30T15:30:00")).toISOString() },
  ];
  const input = buildAppealInput({ msgs, aixLogs: [], customerKind: "positive" });
  eq(input.viewingDelayed, true);
  const v = resolveAppealTiming(input);
  eq(v.kind, "apply");
  process.env.APPEAL_CIRCUMSTANCES = "off";
  eq(buildAppealInput({ msgs, aixLogs: [], customerKind: "positive" }).viewingDelayed, false);
  delete process.env.APPEAL_CIRCUMSTANCES;
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
