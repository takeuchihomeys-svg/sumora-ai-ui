// app/lib/__tests__/repeat-brain-align.test.ts — 繰り返し（もう言った事の言い直し）をブレイン基準・竹内さんの実送信にそろえる（2026-10-13）
//   実行: npx tsx app/lib/__tests__/repeat-brain-align.test.ts
//   例は本番の下書きと竹内さんの実送信（scripts/audit-draft-repeat.ts の見本・名前は伏せた）
import { repeatSentences, sentenceSimilarity, isAckOnlyTurn, isCourtesyOnly, promiseTopics, ackReplyShape, priorPromiseForm, topicRepeats } from "../draft-repeat";
import { contractAlreadySaidRepeat, demoteRepeatNote, pickupAckMaterial, alreadySaidAllowance, pendingPickupAckLine, ackEchoToWait, confirmAckMaterial, ackFormFacts, ackFormMaterialLine, ackFormContractLine, ackFormCell, isCompactWaitLine, confirmAckMaterialFor, pickupAckMaterialFor } from "../repeat-brain-align";
import { renderTurnContractNote, issueContradictsContract, type TurnContract } from "../turn-contract";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const ON = {}, OFF = { REPEAT_BRAIN_ALIGN: "off" };

console.log("① 文の近さ・受けだけ・礼だけ");
t("名前・絵文字・開口語を除いて同じ", sentenceSimilarity("〇〇さん審査面も無事通過出来ますようにサポートさせて頂きます😊！！", "審査面も無事通過出来ますようサポートさせて頂きます！！") >= 0.72);
t("よろしくお願いします は受けだけ", isAckOnlyTurn(["よろしくお願いします！", "ありがとうございます"]));
t("条件を足した発言は受けだけでない", !isAckOnlyTurn(["ありがとうございます🙇", "できれば大阪の市内付近でお願いいたします（京都・尼崎方面は避けたいです）"]));
t("何卒よろしく は礼だけ", isCourtesyOnly("明日何卒よろしくお願い致します！！"));
t("ピックアップの約束の中身", promiseTopics("〇〇さんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！").includes("pickup"));
t("お届けも約束の形", promiseTopics("梅田まで1本で行ける沿線・9万以内・1LDKのお部屋をお届けします！！").includes("pickup"));
t("全力でサポートは約束の中身に数えない", promiseTopics("〇〇さんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！").length === 0);

console.log("② 下書きの繰り返しを数える（監査の部品）");
const prior = [{ text: "管理会社火曜日までお休みとなりますので、無事1番手でお申込出来ているか火曜日確認させて頂き確認出来次第ご連絡させて頂きます！！\nその後ご内覧につきまして調整させて頂きます！！", back: 1 }];
const hits = repeatSentences("はい😊！！\n火曜日に無事1番手でお申込出来ているか確認させて頂き、確認出来次第ご連絡させて頂きます！！\nその後ご内覧につきまして調整させて頂きます😌！！", prior, ["よろしくお願いします！"]);
t("4f9d58e8: 確認・内覧の約束の言い直しを2つ拾う", hits.filter((h) => h.kind === "staff").length === 2);
t("同じ下書きの中の二度言い", repeatSentences("確認出来次第ご連絡させて頂きます！！\n確認出来次第ご連絡させて頂きます！！", [], []).some((h) => h.kind === "self"));
t("言い換えの約束（topic）", topicRepeats("塚本・大国町エリアでオススメ出来るお部屋、ピックアップ出来次第お送りさせて頂きます😌！！", [{ text: "塚本・大国町エリアでもオススメ出来るお部屋ピックアップさせて頂きます！！", back: 1 }]).length === 1);
t("竹内さんの形: 待ちの形で言い直す", ackReplyShape("はい！！\nピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！", "大阪駅、梅田エリアで〇〇さんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！") === "待ちの形で言い直す");
t("竹内さんの形: 日付の締め", ackReplyShape("はい😊！！\n当日何卒よろしくお願い致します！！", "8/22 14:00にセレニテ十三 現地エントランスお待ち合わせで何卒よろしくお願い致します！！") === "日付の締め");
t("前の約束の形: 言い切り", priorPromiseForm("かしこまりました！！\n中央区、浪速区全域から14万円以内の2LDKのお部屋ピックアップさせていただきます😊！！")?.form === "言い切り");
t("前の約束の形: 待ちの形", priorPromiseForm("はい！〇〇さんにオススメ出来るお部屋が出次第お送りさせて頂きます😌！！")?.form === "待ちの形");

console.log("③ 最終チェックの決定論（ブレインの「もう言った事」）");
const said1 = ["管理会社火曜日までお休みとなりますので、無事1番手でお申込出来ているか火曜日確認させて頂き確認出来次第ご連絡させて頂…"];   // repeatCandidates の60字の切り方そのまま
t("4f9d58e8: 受けだけの番の確認の約束の言い直し → 指摘", !!contractAlreadySaidRepeat("はい😊！！\n火曜日に無事1番手でお申込出来ているか確認させて頂き、確認出来次第ご連絡させて頂きます！！", said1, { customerAddsContent: false, env: ON }));
t("8cad64b0: 待ちの形の連絡の約束の言い直し → 指摘", !!contractAlreadySaidRepeat("はい😊！！\n管理会社担当者よりご返事あり次第、ご連絡させていただきます！！\n何卒よろしくお願い致します😌！！", ["管理会社担当者よりご返事あり次第ご連絡させていただきます😊 ！！"], { customerAddsContent: false, env: ON }));
t("待ちの形のピックアップの1文 → 竹内さんの形なので外す", !contractAlreadySaidRepeat("はい！！\nピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！", ["大阪駅、梅田エリアでオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！"], { customerAddsContent: false, env: ON }));
t("中身のある番の新しい物件の確認の約束 → 外す（80980727）", !contractAlreadySaidRepeat("お送り頂きました2件、募集状況確認させて頂きます！！", ["お送りいただきました物件の募集状況確認させて頂きます！！"], { customerAddsContent: true, env: ON }));
t("中身のある番のサポートの宣言 → 外す（7f36cba8 竹内さんも書いた）", !contractAlreadySaidRepeat("〇〇さん審査が無事通るようサポートさせて頂きます😌！！", ["審査無事通るようサポートさせていただきます！！"], { customerAddsContent: true, env: ON }));
t("中身のある番の条件を足したピックアップ → 外す（3f96fc01）", !contractAlreadySaidRepeat("梅田まで1本で行ける沿線・9万以内・1LDK・カウンターキッチンでオススメできるお部屋をお届けします！！", ["梅田まで1本で行ける沿線周辺全域から9万以内・1LDK・カウンターキッチンでオススメでき…"], { customerAddsContent: true, env: ON }));
t("日付の締め → 外す", !contractAlreadySaidRepeat("明日何卒よろしくお願い致します！！", ["明日14:00〜ご案内させて頂きます！！"], { customerAddsContent: false, env: ON }));
t("戻す REPEAT_BRAIN_ALIGN=off", !contractAlreadySaidRepeat("はい😊！！\n管理会社担当者よりご返事あり次第、ご連絡させていただきます！！", ["管理会社担当者よりご返事あり次第ご連絡させていただきます😊 ！！"], { customerAddsContent: false, env: OFF }));
const base: TurnContract = { asks: [], leadWith: null, closeOnly: false, mustNot: [], proposals: [], alreadySaid: ["x"], settled: [], feeling: { kind: null, acknowledge: false }, humanChecks: [], source: "brain" };
t("本質とぶつからない（書き直しに渡る）", !issueContradictsContract({ code: "BRAIN_ALREADY_SAID", message: "", evidence: "x" }, { ...base, closeOnly: true }));

console.log("④ 生成の材料（最優先を下げる・竹内さんの形）");
const echo = "\n【🔁 直前のスタッフ約束の復唱（決定論・最優先）】お客様の最新メッセージは短い了承語です。";
t("本質がある番は材料に下げる", /📎 材料: 🔁 直前のスタッフ約束の復唱/.test(demoteRepeatNote(echo, true, ON)) && !/最優先/.test(demoteRepeatNote(echo, true, ON)));
t("本質が無い番は今まで通り", demoteRepeatNote(echo, false, ON) === echo);
t("戻すと今まで通り", demoteRepeatNote(echo, true, OFF) === echo);
const aixNote = "\n【🚫 AIX実行済みアクションの再宣言禁止（最優先・next_steps/フェーズ別パターン/実例より上位）】\n→ 実行済みのアクションを未来形で宣言することは絶対禁止";
t("絶対禁止 → 書かない", /書かない/.test(demoteRepeatNote(aixNote, true, ON)) && !/絶対/.test(demoteRepeatNote(aixNote, true, ON)));
t("ピックアップの後の材料に竹内さんの待ちの形", /ピックアップ出来次第お送りさせて頂きますので/.test(pickupAckMaterial(ON) ?? "") && pickupAckMaterial(OFF) === null);
t("本質の「もう言った事」に竹内さんの形の1行", /待ちの形の1文/.test(renderTurnContractNote({ ...base, alreadySaid: ["ピックアップしてお送りさせて頂きます！！"] })) && alreadySaidAllowance(OFF) === "");

console.log("⑤ 10/13 レビューの直し");
const est = "\n【🚫 見積書作成宣言の繰り返し禁止（最優先・【💰 見積書カバー文】ゲートより上位）】\nスタッフは直前の返信で既に…";
t("入れ子の【】がある見積の見出しも材料に下げる", /📎 材料: 🚫 見積書作成宣言の繰り返し禁止/.test(demoteRepeatNote(est, true, ON)) && !/最優先/.test(demoteRepeatNote(est, true, ON)));
for (const q of ["空いてますか？", "内覧できますか？", "安くなりますか？", "いつですか？", "明日いけます"]) t(`受けではない: ${q}`, !isAckOnlyTurn([q]) && !isCourtesyOnly(q));
for (const a of ["よろしくお願いします🙇‍♀️", "ありがとうございます！", "了解です！", "よろしくお願いします(ぺこり)", "わかりました"]) t(`受け: ${a}`, isAckOnlyTurn([a]));
t("もう言った事にピックアップが無い番は竹内さんの形の1行を付けない", !/待ちの形の1文/.test(renderTurnContractNote({ ...base, closeOnly: true, alreadySaid: ["確認出来次第ご連絡させて頂きます！！"] })));
t("ピックアップがある番は付ける", /待ちの形の1文/.test(renderTurnContractNote({ ...base, closeOnly: true, alreadySaid: ["大阪駅周辺からピックアップしてお送りさせて頂きます！！"] })));
t("確認・見積の約束は本質がある番だけ受けだけ", ackEchoToWait("募集状況の確認", true, ON) && ackEchoToWait("お見積書の作成・送付", true, ON) && !ackEchoToWait("募集状況の確認", false, ON) && !ackEchoToWait("募集状況の確認", true, OFF));
t("ピックアップ・撮影・内覧は竹内さんの形のまま", !ackEchoToWait("条件に合う物件のピックアップ送付", true, ON) && !ackEchoToWait("室内撮影して送付", true, ON) && !ackEchoToWait("内覧の実施（日時確定）", true, ON));
t("未履行のピックアップの1行は竹内さんの3行の形（戻すと null）", /何卒よろしくお願い致します/.test(pendingPickupAckLine(ON) ?? "") && /3回目/.test(pendingPickupAckLine(ON) ?? "") && pendingPickupAckLine(OFF) === null);
// 10/13（作る人・確認の約束への了承の1文）: 待ちの形の1文も竹内さんの形（受けだけの番 3/7）
t("確認の約束への了承: 材料（ACK_CONFIRM_WAIT_LINE=on）は受けだけ／待ちの形の1文のどちらも許す", /待ちの形の1文/.test(confirmAckMaterial("募集状況の確認", { ACK_CONFIRM_WAIT_LINE: "on" })) && /言い切りで書き直さない/.test(confirmAckMaterial("募集状況の確認", { ACK_CONFIRM_WAIT_LINE: "on" })));
t("既定は旧（受けだけ・試しで日付の言い直しが出たため）", !/待ちの形の1文/.test(confirmAckMaterial("募集状況の確認", ON)) && /受けだけ/.test(confirmAckMaterial("募集状況の確認", ON)));
{
  const said = ["お送り頂きましたお部屋の募集状況確認させて頂き、確認出来次第ご連絡させて頂きます！！"];
  const waitLine = "はい！！\n確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！";
  t("待ちの形の確認の1文（竹内さんの形）は指摘しない", contractAlreadySaidRepeat(waitLine, said, { env: ON }) === null);
  t("言い切りの書き直しは今まで通り指摘", contractAlreadySaidRepeat("はい！！\nお送り頂きましたお部屋の募集状況確認させて頂きます！！", said, { env: ON }) !== null);
  t("ACK_CONFIRM_WAIT_DETECTOR=off で待ちの形の1文も旧どおり見る", contractAlreadySaidRepeat(waitLine, ["確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します！！"], { env: { ACK_CONFIRM_WAIT_DETECTOR: "off" } }) !== null);
}
// 10/13 竹内さん「了承の返事はブレインに任せる」（ACK_FORM_BRAIN=on）
{
  const ONF = { ACK_FORM_BRAIN: "on" };
  const msgs = [
    { sender: "staff", text: "お送り頂きました物件の募集状況確認させて頂きます！！", created_at: "2026-10-13T01:00:00Z" },
    { sender: "customer", text: "宜しくお願いします🙇🏻‍♀️", created_at: "2026-10-13T01:10:00Z" },
  ];
  const f = ackFormFacts(msgs);
  t("材料: 確認の約束・言い切り・了承だけ・10分前", !!f && f.family === "確認・連絡・見積・審査" && f.form === "言い切り" && f.customer === "了承だけ" && f.minutes === 10);
  const fd = ackFormFacts([{ sender: "staff", text: "それでは9月30日に改めてご連絡させて頂きます！！", created_at: null }, { sender: "customer", text: "お願いします🙏", created_at: null }]);
  t("材料: 日付の入った約束は「日付つき」（d3a56a97）", fd?.form === "日付つき");
  t("材料: ピックアップの約束は「探す」", ackFormFacts([{ sender: "staff", text: "ご条件に合ったお部屋ピックアップしてお送りさせて頂きます！！" }, { sender: "customer", text: "よろしくお願いします" }])?.family === "探す");
  t("材料: 前に約束が無い → null", ackFormFacts([{ sender: "staff", text: "ご連絡頂きありがとうございます！！" }, { sender: "customer", text: "はい" }]) === null);
  const line = ackFormMaterialLine(f, ONF);
  t("材料の1行: 竹内さんの並びと ack_form の選び方（答えは書かない）", /ack_form/.test(line) && /受けだけ 5・待ちの形 3/.test(line) && /日付が入っている→受けだけ/.test(line));
  t("既定（ACK_FORM_BRAIN 無し）は材料を出さない", ackFormMaterialLine(f, {}) === "");
  t("本質の行: receive_only／wait_line／null", /受けだけ/.test(ackFormContractLine("receive_only")) && /待ちの形の短い1文/.test(ackFormContractLine("wait_line")) && ackFormContractLine(null) === "");
  const cell = { id: "CP_ACK_WAIT", direction: "受けの締め1文だけ。同じ約束を言い直さない", mustNot: ["直前の約束（〜次第ご連絡・確認させて頂きます）の言い直し"], example: "はい😊！！" };
  const c2 = ackFormCell(cell, "wait_line");
  t("セル: wait_line の時だけ待ちの形の1文のセル（言い直し禁止を外す）", !!c2 && /確認出来次第ご連絡させて頂きますので/.test(c2.direction) && !c2.mustNot.some((m) => /〜次第ご連絡/.test(m)) && ackFormCell(cell, "receive_only") === cell && ackFormCell({ ...cell, id: "CP_ACK" }, "wait_line")?.id === "CP_ACK");
  const said = ["お送り頂きましたお部屋の募集状況確認させて頂き、確認出来次第ご連絡させて頂きます！！"];
  const waitLine = "はい！！\n確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！";
  t("最終チェック: ブレインが wait_line → 短い待ちの形は指摘しない", contractAlreadySaidRepeat(waitLine, said, { env: ON, ackForm: "wait_line" }) === null);
  t("最終チェック: ブレインが receive_only → 短い待ちの形も言い直しとして指摘", contractAlreadySaidRepeat(waitLine, ["確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します！！"], { env: ON, ackForm: "receive_only" }) !== null);
  t("待ちの形の1文の判定（確認・探す）", isCompactWaitLine("確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！") && isCompactWaitLine("ピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！") && !isCompactWaitLine("火曜日に無事1番手でお申込出来ているか確認させて頂き、確認出来次第ご連絡させて頂きます！！"));
  t("材料の注記: wait_line／receive_only でブレインの判断を書く", /待ちの形の短い1文/.test(confirmAckMaterialFor("募集状況の確認", "wait_line")) && /受けだけ/.test(confirmAckMaterialFor("募集状況の確認", "receive_only")) && /待ちの形/.test(pickupAckMaterialFor("wait_line")));
}
{
  console.log("⑩ 10/15 ack_form を出口にそろえる（ACK_FORM_FOLLOW）");
  const rb = require("../repeat-brain-align") as typeof import("../repeat-brain-align");
  t("既定 on・off で旧", rb.ackFormFollowEnabled({}) && !rb.ackFormFollowEnabled({ ACK_FORM_FOLLOW: "off" }));
  t("受けだけの形の1行は待ちの形・約束を書かせない", /受けだけ/.test(rb.ackFormShapeLine("receive_only")) && /待ちの形（〜次第/.test(rb.ackFormShapeLine("receive_only")));
  t("待ちの形の1行は短い1文だけ", /待ちの形の短い1文/.test(rb.ackFormShapeLine("wait_line")) && /言い切りの約束/.test(rb.ackFormShapeLine("wait_line")));
  t("締めの行", /何卒よろしくお願い致します！！」で終える/.test(rb.ackFormCloserLine("receive_only")) && /待ちの形の1文/.test(rb.ackFormCloserLine("wait_line")));
  t("必ず含める内容から外す: 約束の進行（確認・見積・ピックアップ）／残す: 気持ちの受け", rb.ackFormDropTopic("全物件の募集状況確認と御見積書作成進行の一言") && rb.ackFormDropTopic("初期費用を抑えられる物件のピックアップを進める") && !rb.ackFormDropTopic("お礼を受け止める一言"));
  const tc: TurnContract = { source: "brain", asks: [{ quote: "お願いします", kind: "report", route: "reply", answer: "かしこまりました。費用を抑えられる物件のピックアップを進めます。", basis: "judgement", aixKey: null }], leadWith: 0, closeOnly: false, mustNot: [], proposals: [], feeling: { kind: null, acknowledge: false }, alreadySaid: [], settled: [], humanChecks: [], ackForm: "receive_only", ackFollow: true } as unknown as TurnContract;
  t("本質の答えの要点に約束の進行があれば渡さない（ack_form の番）", !/ピックアップを進めます/.test(renderTurnContractNote(tc)));
  t("ACK_FORM_FOLLOW=off なら旧（渡す）", (() => { process.env.ACK_FORM_FOLLOW = "off"; const r = /ピックアップを進めます/.test(renderTurnContractNote(tc)); delete process.env.ACK_FORM_FOLLOW; return r; })());
  t("了承の返事の番は行動宣言を足させる指摘を書き直しに渡さない", issueContradictsContract({ code: "WE_DO_MISSING" }, tc, {}));
  // review: ack_form は質問・急ぎの番にも出る（材料が「質問あり」でも出す）→ 了承だけの番でない（ackFollow なし）は答えの要点・指摘を今まで通り
  const tq = { ...tc, ackFollow: false } as TurnContract;
  t("了承だけの番でない（ackFollow なし）→ 答えの要点を渡す・指摘も渡す", /ピックアップを進めます/.test(renderTurnContractNote(tq)) && !issueContradictsContract({ code: "WE_DO_MISSING" }, tq, {}));
}
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
