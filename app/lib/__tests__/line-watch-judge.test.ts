// LINE の見張り 2段目の判定（app/lib/line-watch-judge.ts）
// 実行: npx tsx app/lib/__tests__/line-watch-judge.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 材料は本番の実送信の対そのまま（scripts/audit-line-watch-verdict.ts で目で読んだ物・2026-10-01。お客様の名前は伏せた）
import { staffWindowOf, judgeTurn, cleanDraft, pickJudgeDraft, asksCustomer, factDiffOf, isAgree, verdictLine, type WindowMsg, type StaffWindow } from "../line-watch-judge";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }
const t0 = Date.parse("2026-09-16T05:00:00.000Z");
const at = (min: number) => new Date(t0 + min * 60_000).toISOString().replace("Z", "+00:00");
const cust = (min: number, text = "お客様の発言"): WindowMsg => ({ sender: "customer", created_at: at(min), text });
const staff = (min: number, text: string, aix = false): WindowMsg => ({ sender: "staff", created_at: at(min), text, is_aix_generated: aix });
/** 返事のまとまりに文が1通の窓（閉じている） */
const win = (text: string, presses: StaffWindow["presses"] = []): Pick<StaffWindow, "closed" | "texts" | "presses" | "aixMessages" | "aixMessagesBurst"> =>
  ({ closed: true, texts: text ? [{ at: at(5), text, burst: true }] : [], presses, aixMessages: 0, aixMessagesBurst: 0 });
const reply = (draft: string, staffText: string) => judgeTurn({ draft, brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: win(staffText) });

console.log("staffWindowOf（番の窓と返事のまとまり）");
it("連投の後の返事: 10分以内に続いた文はまとまり・3時間後の報告はまとまりの外", () => {
  const w = staffWindowOf({ customerTurnAt: at(0), msgs: [cust(0), cust(2), staff(5, "かしこまりました！！"), staff(8, "確認させて頂きます！！"), staff(180, "確認出来ました！！"), cust(300)], nowMs: t0 + 400 * 60_000 });
  eq(w.customerLastAt, at(2));
  eq(w.texts.map((x) => x.burst), [true, true, false]);
  eq(w.closed, true);
  eq(w.staffFirstAt, at(5));
});
it("次のお客様の発言の後のスタッフの文は窓に入らない", () => {
  const w = staffWindowOf({ customerTurnAt: at(0), msgs: [cust(0), staff(5, "はい"), cust(20), staff(25, "次の番の返事")], nowMs: t0 + 60 * 60_000 });
  eq(w.texts.map((x) => x.text), ["はい"]);
});
it("24時間たっていない・次の発言も無い窓は閉じていない", () => {
  const w = staffWindowOf({ customerTurnAt: at(0), msgs: [cust(0)], nowMs: t0 + 60 * 60_000 });
  eq(w.closed, false);
});
it("時刻の形が混ざっても（Z と +00:00・小数の桁）順番どおり", () => {
  const w = staffWindowOf({ customerTurnAt: "2026-09-16T05:00:00Z", msgs: [{ sender: "customer", created_at: "2026-09-16T05:00:00.5+00:00", text: "a" }, { sender: "staff", created_at: "2026-09-16T05:00:01.25+00:00", text: "b" }], nowMs: t0 + DAYMS() });
  eq(w.customerLastAt, "2026-09-16T05:00:00.5+00:00");
  eq(w.texts.length, 1);
});
it("押した AIX: まとまりの中と外を分ける", () => {
  const w = staffWindowOf({ customerTurnAt: at(0), msgs: [cust(0), staff(5, "かしこまりました！！")], presses: [{ aix_type: "condition_hearing", created_at: at(7) }, { aix_type: "property_send", created_at: at(120) }], nowMs: t0 + 2 * DAYMS() });
  eq(w.presses.map((p) => [p.aix_type, p.burst]), [["condition_hearing", true], ["property_send", false]]);
});
function DAYMS() { return 86_400_000; }

console.log("judgeTurn（返信の番・本番の実物）");
it("絵文字と！の位置だけ違う → そのまま", () => {
  const j = reply("はい😊！！\nBさん気になる点出てきましたら何時でもお気軽にご連絡ください！！😌", "はい😊！！\nBさん気になる点出てきましたら何時でもお気軽にご連絡ください😌！！");
  eq([j.verdict, j.detail.reason], ["same", "exact"]);
});
it("「確認出来次第」→「募集状況確認出来次第」は同じ事", () => {
  const j = reply("Cさんお世話になっております！！\nかしこまりました😊！！\n確認出来次第ご連絡させて頂きます！！", "Cさんお世話になっております！！\nかしこまりました😊！！\n募集状況確認出来次第ご連絡させて頂きます！！");
  eq(j.verdict, "same_meaning");
  eq(isAgree(j.verdict), true);
});
it("案が「明日9月17日」と「本日」を両方書いた → 事実違い（日時）", () => {
  const j = reply("Sさん明日9月17日12時お部屋ご案内させて頂きます！\n本日12時お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！", "Sさんお世話になっております！！\n本日12時お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！");
  eq([j.verdict, j.detail.reason, j.detail.fact_diff], ["different", "fact_conflict", true]);
});
it("物件名が違う（フレシナイ大阪淀川 ↔ フレンシアノイエ難波南）→ 事実違い（物件）", () => {
  const j = reply("かしこまりました！！ドリームネオポリス桜ノ宮404とフレシナイ大阪淀川、2物件分の初期費用を算出し、見積書をお送りさせて頂きます😊！！", "かしこまりました！！\nドリームネオポリス桜ノ宮とフレンシアノイエ難波南の初期費用見積書をお送りさせて頂きます😊！！");
  eq([j.verdict, j.detail.fact_diff], ["different", true]);
  eq(j.detail.facts?.conflict.includes("property"), true);
});
it("呼びかけの名前だけ違う（表示名 it ↔ it_0）は事実違いにしない", () => {
  const body = "、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\nなんば島之内・大国町・新今宮エリアから、家賃5万円・初期費用10万円以内のご条件に合うお部屋をピックアップしてお送りさせて頂きます！！";
  const j = reply(`itさん${body}`, `it_0さん${body}`);
  eq([j.verdict, j.detail.fact_diff], ["same_meaning", false]);
  eq(j.detail.facts?.conflict, ["name"]);
});
it("案は見積書を作る宣言・スタッフはお部屋を探す宣言 → 行為が食い違う", () => {
  const j = reply(
    "Dさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！何卒よろしくお願い致します😌！！",
    "Dさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n松屋町周辺全域から、Dさんご希望のご条件に合った1DK以上のお部屋ピックアップさせて頂きます！！\n初期費用面も最大限割引し、出来る限りDさんのお引越しにかかる費用を抑えさせて頂きます！！\n何卒よろしくお願い致します😌！！",
  );
  eq([j.verdict, j.detail.reason], ["different", "acts_conflict"]);
  eq(j.detail.missing_acts, ["pickup_promise"]);
  eq(j.detail.extra_acts, ["estimate_promise"]);
});
it("案だけが内覧の日時を書いた → 一部違う（AI だけの行為）", () => {
  const j = reply("はい😊！！\n9/19 12:00に現地にてお待ちしております！！", "はい😊！！　\n何卒よろしくお願い致します😌！！");
  eq([j.verdict, j.detail.reason], ["partial", "acts_extra"]);
});
it("行為は同じで言い回しがとても遠い → 一部違う・割り切れない印", () => {
  const j = reply("はい！！\n気にせず大丈夫です😊！！\nそれでは今からお部屋ご案内させて頂きます！！", "かしこまりました！！\n少々お待ちください！！");
  eq([j.verdict, j.detail.reason, j.detail.uncertain], ["partial", "wording_far", true]);
});
it("下書きが無い（手打ち）→ 比べられない", () => {
  eq(reply("", "かしこまりました！！").detail.reason, "no_draft");
});
it("ブレインの判断も下書きも無い → 比べられない（no_brain）", () => {
  eq(judgeTurn({ draft: null, hasBrain: false, window: win("はい") }).detail.reason, "no_brain");
});
it("__SHOWN__・生成の失敗の文は下書きでない", () => {
  eq(reply("__SHOWN__", "はい").detail.reason, "sentinel_only");
  eq(reply("（AI返信の生成に失敗しました。再生成をお試しください）", "はい").detail.reason, "sentinel_only");
});
it("窓が閉じていない・何も送っていない → 判定しない（翌晩）", () => {
  const j = judgeTurn({ draft: "はい", brainReplyMode: "auto_reply", hasBrain: true, window: { ...win(""), closed: false } });
  eq([j.verdict, j.detail.reason], [null, "pending"]);
});
it("窓が閉じて何も送っていない → 比べられない（no_staff）・[返信不要] なら一致", () => {
  eq(judgeTurn({ draft: "はい", brainReplyMode: "auto_reply", hasBrain: true, window: win("") }).detail.reason, "no_staff");
  eq(judgeTurn({ draft: null, sentinel: "[返信不要]", brainReplyMode: "auto_reply", hasBrain: true, window: win("") }).verdict, "same");
});
it("申込以降（screening）は数えない", () => {
  eq(judgeTurn({ draft: "はい", brainReplyMode: "auto_reply", convStatus: "screening", hasBrain: true, window: win("はい") }).detail.reason, "out_of_scope");
});
it("返信の案・スタッフは文を下書きどおり＋条件のフォームの AIX → 一部違う（AIX も足した）", () => {
  const draft = "はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！";
  const j = judgeTurn({ draft, brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: win(draft, [{ aix_type: "condition_hearing", check_pattern: null, at: at(6), burst: true }]) });
  eq([j.verdict, j.detail.reason, j.detail.aix_verdict], ["partial", "text_plus_aix", "unexpected"]);
});
it("返信の案・スタッフは最初に AIX だけ → 別の事", () => {
  const j = judgeTurn({ draft: "はい", brainReplyMode: "auto_reply", hasBrain: true, window: win("", [{ aix_type: "property_send", check_pattern: null, at: at(5), burst: true }]) });
  eq([j.verdict, j.detail.reason], ["different", "text_but_aix"]);
});

console.log("judgeTurn（AIX の番）");
const aixTurn = (action: string, draft: string | null, w: Pick<StaffWindow, "closed" | "texts" | "presses" | "aixMessages" | "aixMessagesBurst">) => judgeTurn({ draft, brainAction: action, brainReplyMode: "aix", hasBrain: true, window: w });
it("物件を探す宣言を下書きどおり送り、2時間後に物件ピックアップを押した → 文の判定（そのまま）・AIX も一致", () => {
  const d = "かしこまりました！！\n上本町・谷町エリアも含めてオススメできるお部屋新たにピックアップさせて頂きます😊！！";
  const j = aixTurn("property_send", d, win(d, [{ aix_type: "property_send", check_pattern: null, at: at(120), burst: false }]));
  eq([j.verdict, j.detail.reason, j.detail.aix_verdict], ["same", "exact", "same"]);
});
it("まとまりの中で別の AIX を押した → 別の事（AIX 違い）", () => {
  const j = aixTurn("property_check_result", null, win("", [{ aix_type: "application_push", check_pattern: null, at: at(5), burst: true }]));
  eq([j.verdict, j.detail.reason], ["different", "aix_other"]);
});
// 2026-10-01 竹内「確認します あまり使わないので、いきなり物件確認したで大丈夫」: normalizeAixForMatch が寄せなくなった＝ズレとして見える
it("acknowledge_check の判断・押した property_check_result は別の種類（2026-10-01 から）", () => {
  eq(aixTurn("acknowledge_check", null, win("", [{ aix_type: "property_check_result", check_pattern: null, at: at(5), burst: true }])).verdict, "different");
});
it("確認の AIX を押さず、手打ちで確認の宣言 → 同じ事", () => {
  const j = aixTurn("acknowledge_check", null, win("Eさん\n先ほどはお電話ありがとうございました😊！！\nエスリード難波12階のお部屋募集予定か管理会社に確認させていただきます！！"));
  eq([j.verdict, j.detail.reason], ["same_meaning", "aix_ack_by_text"]);
});
it("AIX の案・下書きなし・手打ちで答えを書いた → 別の事（AI は AIX・スタッフは手打ち）", () => {
  const j = aixTurn("property_check_result", null, win("こちらのお部屋家賃が15万円を超えるお部屋となります！！"));
  eq([j.verdict, j.detail.reason], ["different", "aix_but_text"]);
});

console.log("小さな物差し");
it("聞き返し: 「ご要望お聞かせ頂きありがとう」「ご検討頂けますと幸い」は尋ねていない", () => {
  eq(asksCustomer("ご要望お聞かせ頂きありがとうございます😊！！"), false);
  eq(asksCustomer("ごゆっくりご検討頂けますと幸いです！！"), false);
  eq(asksCustomer("ご希望の地域や駅御座いますでしょうか😌！！"), true);
  eq(asksCustomer("ご条件お聞かせ頂けますと幸いです"), true);
});
it("事実の差: 両方にある日時が違う＝conflict・片方だけ＝one side", () => {
  eq(factDiffOf("9/8にご案内させて頂きます", "当日は何卒").draftOnly, ["datetime"]);
  eq(factDiffOf("明日13:00より", "本日13:00より").conflict, ["datetime"]);
});
it("cleanDraft: <<<FINAL_CHECK の尾・「」の囲みを外す", () => {
  eq(cleanDraft("かしこまりました！！\n<<<FINAL_CHECK:{\"ok\":true}").text, "かしこまりました！！");
  eq(cleanDraft("「はい！！\n気になる物件ございましたらいつでもお送りください😊！！」").text, "はい！！\n気になる物件ございましたらいつでもお送りください😊！！");
  eq(cleanDraft("[AIX誘導中]").sentinel, "[AIX誘導中]");
});
it("verdictLine: 画面の1行", () => {
  const j = reply("はい😊！！\n9/19 12:00に現地にてお待ちしております！！", "はい😊！！\n何卒よろしくお願い致します😌！！");
  eq(verdictLine(j.verdict, j.detail, { viewing_datetime: "内覧の候補日時" }), "一部違う ・ AI だけがした行為がある ・ －内覧の候補日時");
});
it("pickJudgeDraft: draft_last が __SHOWN__ の番は draft_first で比べる（10/07・返信の番の39%が na だった）", () => {
  const ok = "はい😊！！\n結果分かり次第ご連絡させて頂きます😌！！";
  // 版1つ・最後のお客様の発言より後に作った → first
  eq(pickJudgeDraft({ draft_last: "__SHOWN__", draft_first: ok, draft_versions: 2, draft_first_at: at(3), customer_last_at: at(2) }).src, "first");
  // 作り直しがある → stale（比べない）
  eq(pickJudgeDraft({ draft_last: "__SHOWN__", draft_first: ok, draft_versions: 4, draft_first_at: at(3), customer_last_at: at(2) }).src, "stale");
  // 連投の途中（「ありがとうございます！」だけ）に作った下書き → stale（後の「初期費用いくら？」を落とした形と比べない）
  eq(pickJudgeDraft({ draft_last: "__SHOWN__", draft_first: ok, draft_versions: 2, draft_first_at: at(1), customer_last_at: at(2) }).src, "stale");
  eq(pickJudgeDraft({ draft_last: "かしこまりました！！", draft_first: "はい", draft_versions: 2 }).src, "last");
  eq(pickJudgeDraft({ draft_last: "__SHOWN__", draft_first: null, draft_versions: 1 }).src, "none");
  const p = pickJudgeDraft({ draft_last: "__SHOWN__", draft_first: ok, draft_versions: 2, draft_first_at: at(3), customer_last_at: at(2) });
  eq(reply(p.draft ?? "", "はい😊！！\n結果分かり次第ご連絡させて頂きます！！").verdict, "same");
  const st = pickJudgeDraft({ draft_last: "__SHOWN__", draft_first: ok, draft_versions: 4, draft_first_at: at(3), customer_last_at: at(2) });
  eq(reply(st.draft ?? "", "はい").detail.reason, "sentinel_only");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
