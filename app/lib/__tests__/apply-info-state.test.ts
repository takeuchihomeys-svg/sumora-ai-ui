// npx tsx app/lib/__tests__/apply-info-state.test.ts
// 実物の文（竹内さん本人の 200日の申込の意思の番・個人の値は伏せた）で、申込の情報の状態と申込の意思の番の見分けを確かめる
import { readApplyInfoState, isApplyIntentTurn, applyInfoBrainLine, applyIntentFormStateOn } from "../apply-info-state";
import { applyIntentReplyFirstRule } from "../turn-contract";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("NG", m); } else console.log("ok", m); };
const S = (text: string, at: string) => ({ sender: "staff", text, created_at: at });
const C = (text: string, at: string, image_type?: string) => ({ sender: "customer", text, created_at: at, image_type: image_type ?? null });

// ── 申込の意思の番か（実物のお客様の発言） ──
for (const t of ["それでは608で申し込みしたいです！", "ぜひ申し込みさせていただきたいです！", "ありがとうございます！\nここ1度抑えたいです！", "申し込みお願いします", "一応申し込みお願いします❣️",
  "でしたらRenatus新大阪の方で1度審査通して頂いてもよろしいでしょうか？", "お部屋抑えていただきたいです！", "ここで審査通してください！", "抑えてください!!念のため!!"]) {
  ok(isApplyIntentTurn(t), `申込の意思: ${t.replace(/\n/g, " ")}`);
}
for (const t of ["初期費用が高かったのでもう少し抑えたいです。", "旭区周辺で家賃もう少し抑えたいです。", "申し込みの流れを教えてください", "ありがとうございます！\n審査に不安があったのでよかったです！\nこの物件で初期費用確認次第申し込みさせていただきたいと思ってます🙇‍♂️",
  "二匹大丈夫なら明日申し込みお願いします！", "ここも見てたんですけど賃料が高くて…\nもう少し抑えたいです", "① 入居時期     いつでも大丈夫\n② 駐車場代込で 8万ぐらい\n⑦ 出来れば 20万か25万以内に抑えたい", "こちらの物件今申し込みすると 最短でいつから入居できますか？", "ありがとうございます！"]) {
  ok(!isApplyIntentTurn(t), `申込の意思ではない: ${t}`);
}

// ── 状態 ──
// まだ（a0cfe4c4 9/12 の前・物件の確認と見積だけ）
ok(readApplyInfoState([
  S("YUMAさん確認させていただきました！！\nスプランディッド大阪EAST 608号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！", "2026-09-12T12:00:00Z"),
  C("それでは608で申し込みしたいです！", "2026-09-12T13:09:19Z"),
]).state === "none", "見積と確認だけ＝まだ");
// 説明の文は数えない（f5afb8c2 6/09・8590144d・q383 の繰り上がりの説明・3612）
ok(readApplyInfoState([
  S("保証会社加入必須となります！！\n無事保証会社の審査通過しますと\n総賃料の50%が", "2026-06-09T00:20:00Z"),
  S("1番手審査の方が否決・キャンセルの場合、番手繰り上がり審査開始となります！", "2026-06-10T00:00:00Z"),
  S("保証会社の審査通過後オーナー審査開始までキャンセル可能です", "2026-06-11T00:00:00Z"),
  S("現在募集中のお部屋となりますが、1番手のお申込が入っております！！", "2026-06-12T00:00:00Z"),
  S("お送りいただきありがとうございます！！\nお申込み完了しましたらご連絡させていただきます！！", "2026-06-13T00:00:00Z"),
  S("ほのかさんお世話になっております！！\n現在お申込が完了していない状況となります！！", "2026-06-14T00:00:00Z"),
  S("即日ご入居可能となり、審査通過次第ご入居可能となりますが、ご入居希望日は何日となりますでしょうか！！", "2026-06-15T00:00:00Z"),
]).state === "none", "説明・他の方の申込・まだの報告は数えない");
// フォーマットは送ったが記入はまだ
const fs = readApplyInfoState([S("フォーマット\n\n個人用\n【お申込者様記入欄】\n・入居希望日\n・氏名、フリガナ", "2026-06-22T13:04:17Z")]);
ok(fs.state === "form_sent" && fs.at === "2026-06-22T13:04:17Z", "こちらがフォーマットを送った＝記入待ち");
// 届いている: お客様の記入（f5afb8c2 6/22）
ok(readApplyInfoState([
  S("【お申込者様記入欄】\n・入居希望日", "2026-06-22T13:04:17Z"),
  C("フォーマット\n\n個人用\n【お申込者様記入欄】\n・入居希望日7/30\n・氏名、フリガナ\n〇〇", "2026-06-22T13:13:55Z"),
]).via === "customer_form", "お客様の記入＝届いている");
// 届いている: こちらの完了の報告（f5afb8c2 7/02・q383 be73fa13）
for (const t of ["無事一番手にてお申込み完了しております！！", "お部屋のお申し込み完了しております！！\n\n管理会社より昨晩お申込みが入ってしまい505号室2番手でのお申込みとのことです！！",
  "アスヴェル神戸元町1304号室管理会社より\n保証会社 全保連の審査が否決となり", "再度管理会社に緊急連絡先での審査継続を交渉させていただきますが", "以前いただきましたご情報でお申し込み可能ですので追加で必要な書類現時点ではございません！！"]) {
  ok(readApplyInfoState([S(t, "2026-07-02T17:38:58Z")]).state === "received", `届いている: ${t.slice(0, 30).replace(/\n/g, " ")}`);
}
// 届いている: 本人確認書類の画像
ok(readApplyInfoState([C("[画像] 本人確認書類", "2026-09-22T11:58:45Z")]).state === "received", "本人確認書類の画像＝届いている");
ok(readApplyInfoState([C("[画像]", "2026-09-22T11:58:45Z", "id_document")]).state === "received", "image_type=id_document＝届いている");

// ── 1行（事実だけ・個人の値なし） ──
ok(applyInfoBrainLine({ state: "received", at: "2026-07-02T17:38:58Z", via: "staff_done" }, "申し込みお願いいたします").includes("届いている（2026-07-02"), "届いている の1行");
ok(applyInfoBrainLine({ state: "none", at: null, via: null }, "申し込みしたいです！").includes("まだ（フォーマットも送っていない）"), "まだ の1行");
ok(applyInfoBrainLine({ state: "received", at: "2026-07-02T17:38:58Z", via: "staff_done" }, "ありがとうございます！") === "", "申込の意思でない番は1字も足さない");

// ── スイッチ・決まりの文 ──
ok(!applyIntentFormStateOn({}) && applyIntentFormStateOn({ APPLY_INTENT_FORM_STATE: "on" }), "既定 off");
const oldRule = applyIntentReplyFirstRule({});
const newRule = applyIntentReplyFirstRule({ APPLY_INTENT_FORM_STATE: "on" });
ok(oldRule.includes("ご入居希望日は何日") && !oldRule.includes("【申込の情報】"), "off の時は今の決まりの文のまま");
ok(newRule.includes("【申込の情報】") && newRule.includes("aix=\"application_push\"") && newRule.includes("route=\"reply\"") && newRule.endsWith("\n") && !newRule.slice(0, -1).includes("\n"), "on の時は状態ごとの1行");
ok(applyIntentReplyFirstRule({ APPLY_INTENT_REPLY_FIRST: "off", APPLY_INTENT_FORM_STATE: "on" }) === "", "親のスイッチ off なら何も足さない");

// ── 配線（brain-core が材料の並び（毎回変わる所）にこの1行を入れ、決まりの文が turn_contract の決まりに入る） ──
{
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const core = fs.readFileSync(path.join(__dirname, "..", "brain-core.ts"), "utf8");
  ok(/customerStateBlockText \+= applyInfoBrainLine\(reading, unrepliedTurn\.text\)/.test(core), "brain-core: 毎回変わる材料の並びに【申込の情報】を足す");
  ok(/applyIntentFormStateOn\(\) && !isPostApplyStatus\(convStatus\) && isApplyIntentTurn\(unrepliedTurn\.text\)/.test(core), "brain-core: スイッチ on・申込以降でない・申込の意思の番だけ DB を引く");
  const tc = fs.readFileSync(path.join(__dirname, "..", "turn-contract.ts"), "utf8");
  ok(/\$\{applyIntentReplyFirstRule\(\)\}/.test(tc), "turn-contract: 決まりの並びに入っている");
}

if (fail) { console.error(`${fail} 件 NG`); process.exit(1); }
console.log("apply-info-state: 全部 ok");
