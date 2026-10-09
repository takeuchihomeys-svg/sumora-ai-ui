// 2026-10-08 把握「お客様の事情」（customer-circumstances.ts）
// 実行: npx tsx app/lib/__tests__/customer-circumstances.test.ts
// お客様の発言は実物（scripts/audit-customer-circumstances.ts で読んだ物・名前と物件名は伏せた）
import { extractCircumstances, validCircumstances, circumstanceDelaysViewing, buildCircumstancesNote, resolveDateExpr, holdFirstReason, onlineViewingReason, ONLINE_VIEWING_LINE } from "../customer-circumstances";
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

console.log("2026-10-08 竹内さん「期間が1週間以上空いた場合や、遠方の方には（先に抑える）提案する」");
it("〇日以降が7日以上先＝抑える提案／6日先＝入れない／遠方＝入れる", () => {
  const now = jst("2026-10-08T14:00:00");
  const v7 = validCircumstances(one("都合つくのが10月15日以降の予定です", "2026-10-08T13:00:00"), now);
  const v6 = validCircumstances(one("都合つくのが10月14日以降の予定です", "2026-10-08T13:00:00"), now);
  const vr = validCircumstances(one("今広島に住んでいて、内見が難しい状況です", "2026-10-07T13:00:00"), now);
  has(String(holdFirstReason(v7, now)), "今日から7日後"); eq(holdFirstReason(v6, now), null); eq(holdFirstReason(vr, now), "遠方のお客様");
  eq(circumstanceDelaysViewing(v7, now), true); eq(circumstanceDelaysViewing(v6, now), false); eq(circumstanceDelaysViewing(vr, now), true);
});
console.log("2026-10-08 竹内さん「（予定が詰まって・出張中＝日付なし）先に部屋を抑える方向で。出張中ならオンライン内見も対応可能と伝える」");
it("予定が詰まって（日付なし・実物 fb8ab8d5＝竹内さんは「一度室内撮影…お部屋を抑えた状態で…ご案内」）→ 抑える提案／オンライン内見は付けない", () => {
  const now = jst("2026-10-08T14:00:00");
  const v = validCircumstances(one("今月前半結構予定詰まってて🥲", "2026-10-08T10:00:00"), now);
  has(String(holdFirstReason(v, now)), "予定が詰まって");
  eq(circumstanceDelaysViewing(v, now), true);
  eq(onlineViewingReason(v), null);
  const n = buildCircumstancesNote(v, { nowMs: now, scene: "viewing" });
  has(n, "お申込みでお部屋を抑えた状態でご内覧頂く");
  if (n.includes("オンライン内見")) throw new Error("予定が詰まっての時にオンライン内見が入った");
});
it("出張中（日付なし・実物 d367d1b9 の2通目）→ 抑える提案＋オンライン内見（竹内さんの実送信の形）", () => {
  const now = jst("2026-10-08T14:00:00");
  const v = validCircumstances(one("申し訳ございません。\n現在出張中のため、そちらへ伺うことができません", "2026-10-08T10:00:00"), now);
  has(String(holdFirstReason(v, now)), "出張中");
  eq(onlineViewingReason(v), "business_trip");
  const n = buildCircumstancesNote(v, { nowMs: now, scene: "viewing" });
  has(n, "お申込みでお部屋を抑えた状態でご内覧頂く"); has(n, ONLINE_VIEWING_LINE); has(n, "出張中なのでオンライン内見も対応可能");
});
it("出張でも日付がある（実物 749c5559「明日から15日までお仕事の出張で厳しい」）→ 日付の線（7日）が正・オンライン内見は付けない", () => {
  const now = jst("2026-08-08T10:48:00");
  const v = validCircumstances(one("明日から15日までお仕事の出張で厳しいです💦", "2026-08-08T10:48:00"), now);
  eq(v.map((c) => c.kind), ["available_from"]);
  eq(onlineViewingReason(v), null);
});
it("出張中＋戻る日（実物 d367d1b9 7/27「北海道へ出張中です。来月5日に大阪へ戻る予定」）→ 戻る日の「〇日以降」（日付が正）", () => {
  const v = one("現在、北海道へ出張中です。\n来月5日に大阪へ戻る予定なのですが、内見はいつ頃でしたらご都合がよろしいでしょうか。", "2026-07-27T18:08:00");
  eq(v.map((c) => c.kind), ["available_from"]); eq(md(v[0].fromDayMs as number), "8/5");
});
it("今週は無理（日付なし・短い）は抑える提案に入れない／CIRCUMSTANCE_UNDATED_HOLD=off で旧", () => {
  const now = jst("2026-10-08T14:00:00");
  eq(holdFirstReason(validCircumstances(one("今週は内覧に行けないです", "2026-10-08T10:00:00"), now), now), null);
  const v = validCircumstances(one("今月前半結構予定詰まってて", "2026-10-08T10:00:00"), now);
  eq(holdFirstReason(v, now, { CIRCUMSTANCE_UNDATED_HOLD: "off" }), null);
  eq(onlineViewingReason(validCircumstances(one("現在出張中のため伺えません", "2026-10-08T10:00:00"), now), { CIRCUMSTANCE_ONLINE_VIEWING: "off" }), null);
});
it("遠方（実物 c1d57c97 広島）→ オンライン内見の言い回しも注記に", () => {
  const now = jst("2026-10-08T14:00:00");
  const v = validCircumstances(one("今が広島に住んでいて、内見が難しい状況なのですが", "2026-10-07T13:00:00"), now);
  eq(onlineViewingReason(v), "remote");
  has(buildCircumstancesNote(v, { nowMs: now, scene: "viewing" }), ONLINE_VIEWING_LINE);
});
it("訴求: 内覧の希望＋今の発言「出張中」→ 抑える提案＋オンライン内見／APPEAL_ONLINE_VIEWING=off で付けない", () => {
  const msgs = [
    { sender: "staff", text: "🌟〇〇 7階\n家賃8.5万円…オススメ出来るお部屋となります😊！！", createdAt: new Date(jst("2026-10-08T10:00:00")).toISOString() },
    { sender: "customer", text: "内覧したいのですが、現在出張中のため伺うことができません", createdAt: new Date(jst("2026-10-08T12:30:00")).toISOString() },
  ];
  const inp = buildAppealInput({ msgs, aixLogs: [], customerKind: "positive" });
  eq(inp.viewingDelayed, true); eq(inp.onlineViewing, "business_trip");
  const v = resolveAppealTiming(inp);
  eq(v.kind, "apply"); has(v.note, ONLINE_VIEWING_LINE);
  process.env.APPEAL_ONLINE_VIEWING = "off";
  const inp2 = buildAppealInput({ msgs, aixLogs: [], customerKind: "positive" });
  delete process.env.APPEAL_ONLINE_VIEWING;
  eq(inp2.onlineViewing, null);
  if (resolveAppealTiming(inp2).note.includes("オンライン内見")) throw new Error("off でもオンライン内見が入った");
});
it("訴求: 前の発言の「出張中」（2日前）＋今「気になります」→ すぐ来られない・オンライン内見", () => {
  const msgs = [
    { sender: "customer", text: "現在出張中のため、そちらへ伺うことができません", createdAt: new Date(jst("2026-10-06T12:00:00")).toISOString() },
    { sender: "staff", text: "🌟〇〇 7階\n家賃8.5万円…オススメ出来るお部屋となります😊！！", createdAt: new Date(jst("2026-10-08T10:00:00")).toISOString() },
    { sender: "customer", text: "ここ気になります！", createdAt: new Date(jst("2026-10-08T12:30:00")).toISOString() },
  ];
  const inp = buildAppealInput({ msgs, aixLogs: [], customerKind: "positive" });
  eq(inp.viewingDelayed, true); eq(inp.onlineViewing, "business_trip");
});
it("注記: 7日以上先は抑える提案・候補日は AIX で来られる日以降／6日先は「入れない」と書く", () => {
  const now = jst("2026-10-08T14:00:00");
  const n7 = buildCircumstancesNote(validCircumstances(one("都合つくのが10月20日以降の予定です", "2026-10-08T13:00:00"), now), { nowMs: now, scene: "viewing" });
  has(n7, "お申込みでお部屋を抑えた状態でご内覧頂く"); has(n7, "AIX【内覧調整】で来られる日以降から出す");
  const n6 = buildCircumstancesNote(validCircumstances(one("都合つくのが10月14日以降の予定です", "2026-10-08T13:00:00"), now), { nowMs: now, scene: "viewing" });
  has(n6, "お部屋を抑える提案は入れない");
  if (n6.includes("お申込みでお部屋を抑えた状態")) throw new Error("6日先に抑える提案が入った");
});
it("HOLD_FIRST_MIN_DAYS で線を変えられる", () => {
  const now = jst("2026-10-08T14:00:00");
  const v6 = validCircumstances(one("都合つくのが10月14日以降の予定です", "2026-10-08T13:00:00"), now);
  process.env.HOLD_FIRST_MIN_DAYS = "5"; eq(holdFirstReason(v6, now) !== null, true); delete process.env.HOLD_FIRST_MIN_DAYS;
});
it("訴求: 内覧の希望＋前の発言の「〇日以降」が5日先 → 抑えない（内覧の受け）", () => {
  const msgs = [
    { sender: "staff", text: "🌟〇〇 7階\n家賃8.5万円…オススメ出来るお部屋となります😊！！", createdAt: new Date(jst("2026-10-08T10:00:00")).toISOString() },
    { sender: "customer", text: "都合つくのが10月13日以降の予定です", createdAt: new Date(jst("2026-10-08T12:00:00")).toISOString() },
    { sender: "staff", text: "かしこまりました！！", createdAt: new Date(jst("2026-10-08T12:05:00")).toISOString() },
    { sender: "customer", text: "内覧したいです！", createdAt: new Date(jst("2026-10-08T12:30:00")).toISOString() },
  ];
  eq(buildAppealInput({ msgs, aixLogs: [], customerKind: "positive" }).viewingDelayed, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
