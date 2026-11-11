// 見張りの物差しの誤り M1〜M3（app/lib/line-watch-judge.ts・LINE_WATCH_MEASURE_V11=on・既定 off）
// 実行: npx tsx app/lib/__tests__/line-watch-measure-v11.test.ts（自己完結。全 PASS で exit 0）
// 材料: 2026-11-11 直近14日の外れ 118番を読んだ実物（9258・11351・9547 の形。お客様の名前は入れていない）
import { judgeTurn, type StaffWindow } from "../line-watch-judge";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const at = (min: number) => new Date(Date.parse("2026-11-05T05:00:00Z") + min * 60_000).toISOString();
type W = Pick<StaffWindow, "closed" | "texts" | "presses" | "aixMessages" | "aixMessagesBurst">;
const win = (text: string, presses: StaffWindow["presses"] = []): W => ({ closed: true, texts: text ? [{ at: at(5), text, burst: true }] : [], presses, aixMessages: 0, aixMessagesBurst: 0 });
const press = (aix_type: string, burst: boolean, min = 6) => ({ aix_type, check_pattern: null, at: at(min), burst });
const withFlag = <T>(on: boolean, fn: () => T): T => { const old = process.env.LINE_WATCH_MEASURE_V11; process.env.LINE_WATCH_MEASURE_V11 = on ? "on" : "off"; try { return fn(); } finally { if (old == null) delete process.env.LINE_WATCH_MEASURE_V11; else process.env.LINE_WATCH_MEASURE_V11 = old; } };

const T9258 = "はい😊！！\nお気に召されたお部屋ございましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！";
const T11351 = "はい！！\n11/8は何卒よろしくお願い致します！！";

console.log("M1 文は下書きどおり・スタッフは 2通目に AIX（9258）");
const m1 = () => judgeTurn({ draft: T9258, brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: win(T9258, [press("property_recommendation", true)]) });
it("off: partial（text_plus_aix）のまま", () => withFlag(false, () => { const j = m1(); eq([j.verdict, j.detail.reason], ["partial", "text_plus_aix"]); }));
it("on: same_meaning（text_same_plus_aix）・aix_verdict は unexpected のまま", () => withFlag(true, () => { const j = m1(); eq([j.verdict, j.detail.reason, j.detail.aix_verdict], ["same_meaning", "text_same_plus_aix", "unexpected"]); }));
it("on でも文が違えば text_but_aix（different）", () => withFlag(true, () => {
  const j = judgeTurn({ draft: "はい😊！！何卒よろしくお願い致します😌！！", brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: win("こちらのお部屋如何でしょうか！！", [press("property_recommendation", true)]) });
  eq([j.verdict, j.detail.reason], ["different", "text_but_aix"]);
}));

console.log("M2 [返信不要] でも文が1字も違わない（11351）");
const m2 = () => judgeTurn({ draft: T11351, sentinel: "[返信不要]", brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: win(T11351) });
it("off: different（no_reply_needed_but_sent）のまま", () => withFlag(false, () => { const j = m2(); eq([j.verdict, j.detail.reason], ["different", "no_reply_needed_but_sent"]); }));
it("on: 文で比べて same", () => withFlag(true, () => { eq(m2().verdict, "same"); }));
it("on でも文が無い [返信不要] だけは今まで通り different", () => withFlag(true, () => {
  const j = judgeTurn({ draft: "", sentinel: "[返信不要]", brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: win("はい！！引き続き新着でお送りさせて頂きます！！") });
  eq([j.verdict, j.detail.reason], ["different", "no_reply_needed_but_sent"]);
}));

console.log("M3 まとまりでは別の AIX・同じ窓でブレインの AIX も（9547）");
const m3 = (laterSame: boolean) => judgeTurn({ draft: "", brainAction: "property_check_result", brainReplyMode: "aix", hasBrain: true,
  window: win("", [press("meeting_place", true), ...(laterSame ? [press("property_check_result", false, 90)] : [])]) });
it("off: different（aix_other）", () => withFlag(false, () => { const j = m3(true); eq([j.verdict, j.detail.reason], ["different", "aix_other"]); }));
it("on: same_meaning（aix_in_window）・関所の aix_verdict は other のまま", () => withFlag(true, () => { const j = m3(true); eq([j.verdict, j.detail.reason, j.detail.aix_verdict], ["same_meaning", "aix_in_window", "other"]); }));
it("on でも窓の中にブレインの AIX が無ければ aix_other", () => withFlag(true, () => { eq(m3(false).detail.reason, "aix_other"); }));

console.log("M4 内覧の当日の段取りの番・スタッフは内覧の後のお礼（12439・9916）");
const m4 = (cust: string) => judgeTurn({ draft: "はい！！南本町2-3-23で合っております！！エントランス前にてお待ちしております！！", brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, customerText: cust,
  window: win("本日お時間頂きありがとうございました！！フォーマットいただき次第お申込しお部屋抑えさせて頂きます！", [press("greeting_viewing", true)]) });
it("off: text_but_aix（different）", () => withFlag(false, () => { eq(m4("着きました\n南本町2-3-23ですよね？").detail.reason, "text_but_aix"); }));
it("on: na（after_viewing_greeting）", () => withFlag(true, () => { const j = m4("着きました\n南本町2-3-23ですよね？"); eq([j.verdict, j.detail.reason], ["na", "after_viewing_greeting"]); }));
it("on でも段取りでない文（内覧の後のお礼への了承）は数える（12459）", () => withFlag(true, () => { eq(m4("かしこまりました！").detail.reason, "text_but_aix"); }));

console.log("M5 下書きが物件名を足しただけ（10017）・M6 今日／本日／明日だけ（10232）");
const m5draft = "お送り頂きましたサムティ福島VIVIENTEの募集状況を確認させて頂きます😊！！確認出来次第ご連絡させて頂きます！！";
const m5staff = "お送り頂きましたお部屋の募集状況を確認させて頂きます😊！！確認出来次第ご連絡させて頂きます！！";
const m5 = (ground: string) => judgeTurn({ draft: m5draft, brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, staffFactGround: ground, window: win(m5staff) });
it("off: fact_one_side（partial）", () => withFlag(false, () => { eq(m5("サムティ福島VIVIENTE 3階").detail.reason, "fact_one_side"); }));
it("on: 名前が会話にある → 同じ意味", () => withFlag(true, () => { const j = m5("[画像] サムティ福島VIVIENTE 3階"); eq([j.verdict, (j.detail.measure_notes ?? []).includes("draft_named_property")], ["same_meaning", true]); }));
it("on でも名前が会話に無い（作った名前）→ fact_one_side のまま", () => withFlag(true, () => { eq(m5("ここ空いてますか").detail.reason, "fact_one_side"); }));
const m6 = (d: string, s: string) => judgeTurn({ draft: d, brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, staffFactGround: "", window: win(s) });
const D6 = "かしこまりました！！今日お申込み進めさせて頂きます😊！！入居可能日は明日管理会社より回答が届き次第ご連絡させて頂きます！！";
const S6 = "かしこまりました！！お部屋お申込みさせて頂きます😊！！入居可能日は明日管理会社より回答が届き次第ご連絡させて頂きます！！";
it("off: fact_conflict（different）", () => withFlag(false, () => { eq(m6(D6, S6).detail.reason, "fact_conflict"); }));
it("on: 今日を足しただけ → 日時の食い違いにしない", () => withFlag(true, () => { const j = m6(D6, S6); eq([j.detail.reason !== "fact_conflict", (j.detail.measure_notes ?? []).includes("relative_day_only")], [true, true]); }));
it("on でも日付そのもの（11/5 と 11/6）が違えば fact_conflict", () => withFlag(true, () => { eq(m6("11/5（水）13:00からよろしくお願い致します！！", "11/6（木）13:00からよろしくお願い致します！！").detail.reason, "fact_conflict"); }));

console.log("M4b まとまりが内覧の後の申込の案内（9916）");
it("on: 段取りの番＋まとまりが application_push → na", () => withFlag(true, () => {
  const j = judgeTurn({ draft: "はい！！エントランスは管理棟の1階正面入口となります！！", brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, customerText: "到着して今管理棟のあたりにいるのですが、エントランスはどこにありますか？",
    window: win("先ほどお送りしたフォーマットのご入力と、免許証またはマイナンバーカードの表裏の写真をお送り頂けましたらお申し込みさせていただきます😊！！", [press("application_push", true)]) });
  eq([j.verdict, j.detail.reason], ["na", "after_viewing_greeting"]);
}));

console.log("M7 1通目は下書きどおり・2通目に AIX のフォーム（12924）");
const D7 = "結生さんお世話になっております！！\nかしこまりました！！\nお部屋探し兵庫県で改めてピックアップしてお送りさせて頂きます！！";
const w7: W = { closed: true, texts: [{ at: at(5), text: D7, burst: true }, { at: at(9), text: "改めてこちらのお部屋探しフォームお手すきの際にご入力の程よろしくお願いいたします！！\n①ご入居時期\n②ご希望家賃", burst: true }], presses: [press("condition_hearing", true)], aixMessages: 0, aixMessagesBurst: 0 };
it("off: text_but_aix", () => withFlag(false, () => { eq(judgeTurn({ draft: D7, brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: w7 }).detail.reason, "text_but_aix"); }));
it("on: same_meaning（first_text_same_plus_aix）", () => withFlag(true, () => { const j = judgeTurn({ draft: D7, brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: w7 }); eq([j.verdict, j.detail.reason, j.detail.aix_verdict], ["same_meaning", "first_text_same_plus_aix", "unexpected"]); }));
it("on でも AIX を押していない2通は今まで通り文全体で比べる", () => withFlag(true, () => { eq(judgeTurn({ draft: D7, brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: { ...w7, presses: [] } }).detail.reason === "first_text_same_plus_aix", false); }));

console.log("M8 文を書かず前の約束の結果の AIX だけ（11691）");
const m8 = (ground: string) => judgeTurn({ draft: "", brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, staffFactGround: ground, window: win("", [press("property_check_result", true)]) });
it("off: text_but_aix（different）", () => withFlag(false, () => { eq(m8("お送り頂きました3件の募集状況確認させて頂きます！！").detail.reason, "text_but_aix"); }));
it("on: 前の約束がある → na（promise_fulfilment_only）", () => withFlag(true, () => { const j = m8("お送り頂きました3件の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！\nよろしくお願いいたします"); eq([j.verdict, j.detail.reason], ["na", "promise_fulfilment_only"]); }));
it("on でも前の約束が無い → 今まで通り数える", () => withFlag(true, () => { eq(m8("ここ空いてますか").detail.reason, "text_but_aix"); }));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
