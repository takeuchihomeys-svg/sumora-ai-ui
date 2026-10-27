// app/lib/__tests__/aix-brain-contract.test.ts — ブレインの本質を AIX の文の材料に（実行: npx tsx app/lib/__tests__/aix-brain-contract.test.ts）
//   実物: 10/13 の本番の判断（内覧日調整の番「日曜日とかは案内可能ですか？」・言わない「申込誘導」）を伏せて使う
import { buildAixContractNote, contractFreshForAix, askIsThisAix, keepAllQuestionsRule, aixBrainContractOn, lastCustomerAt, mustNotForAix, promiseFulfilledBy, STAFF_VALUE_LINE_RE, isOwnTopicLine, situationLines, aixContractSituationOn } from "../aix-brain-contract";
import { buildBrainStrategyNote } from "../brain-strategy-note";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };

const viewingMeta = {
  analyzed_msg_ts: "2026-10-13T12:40:43.006Z",
  turn_contract: { asks: [{ aix: "viewing_invite", kind: "question", basis: "judgement", quote: "日曜日とかは案内可能ですですか？", route: "aix", answer: "10/18(日)の空き時間枠を候補日として提示" }], feeling: null, must_not: ["土曜の時間を再提示", "日曜の空きを手打ちで断定", "申込誘導"], lead_with: 0, proposals: ["2物件を同日にまとめて内覧"], close_only: false },
  customer_mindset: { state: "内覧したい", anxiety: { target: "費用", direction: "前向き" }, hesitation: "内覧してから決めたい" },
};
const msgs = [
  { sender: "staff", text: "土曜日16:00〜18:00ご案内できます！！", rawCreatedAt: "2026-10-13T12:30:00.000Z" },
  { sender: "customer", text: "日曜日とかは案内可能ですですか？", rawCreatedAt: "2026-10-13T12:40:40.000Z" },
];

// ① 内覧日調整: この AIX で受ける依頼・言わない・提案・状態
{
  const n = buildAixContractNote({ meta: viewingMeta, action: "viewing_invite", messages: msgs, env: {} });
  t("内覧日調整: この AIX で受ける依頼に日曜の質問", n.includes("この AIX で受ける依頼") && n.includes("日曜日とかは"), n);
  t("内覧日調整: 言わない（申込誘導）が届く", n.includes("言わない") && n.includes("申込誘導"), n);
  t("内覧日調整: 提案（返信の材料）は渡さない", !n.includes("2物件を同日にまとめて内覧"), n);
  t("内覧日調整: 話題の線・空きの断言の線は渡す（確かめる人 重要1）", n.includes("土曜の時間を再提示") && n.includes("日曜の空きを手打ちで断定"), n);
  t("内覧日調整: お客様の今（状態・気にしている事の形・迷い）", n.includes("内覧したい") && n.includes("気にしている事: 費用・前向き") && n.includes("迷い: 内覧してから決めたい") && !n.includes("[object Object]"), n);
  t("内覧日調整: 新しい約束を足さない", n.includes("新しい**確認・交渉・作成の約束は足さない"), n);
  t("内覧日調整: 旧の全て回答は出さない", keepAllQuestionsRule(n) === false);
}
// ② 別の AIX の番は答えない
{
  const n = buildAixContractNote({ meta: viewingMeta, action: "property_send", messages: msgs, env: {} });
  t("ブレインの読みと違う AIX を押した番は振り分けを渡さない（重要2）", !n.includes("この文では触れない依頼") && !n.includes("この AIX で受ける依頼") && n.includes("申込誘導"), n);
  const n2 = buildAixContractNote({ meta: { ...viewingMeta, action: "property_send" }, action: "property_send", messages: msgs, env: {} });
  t("ブレインの一手がこの AIX なら別の AIX の依頼は触れない", n2.includes("この文では触れない依頼") && n2.includes("別の AIX viewing_invite"), n2);
}
// ③ 古い判断（お客様の新しい発言の前の分析）は渡さない
{
  const later = [...msgs, { sender: "customer", text: "あと見積もりも", rawCreatedAt: "2026-10-13T12:50:00.000Z" }];
  t("古い判断は空", buildAixContractNote({ meta: viewingMeta, action: "viewing_invite", messages: later, env: {} }) === "");
  t("鮮度: 新しい発言の後の分析は新しい", contractFreshForAix(viewingMeta, msgs) === true);
  t("鮮度: analyzed_msg_ts が無い判断は使わない", contractFreshForAix({ turn_contract: viewingMeta.turn_contract }, msgs) === false);
  t("鮮度: 5秒の幅（他の鮮度の線と同じ）", contractFreshForAix({ ...viewingMeta, analyzed_msg_ts: "2026-10-13T12:40:36.000Z" }, msgs) === true && contractFreshForAix({ ...viewingMeta, analyzed_msg_ts: "2026-10-13T12:40:34.000Z" }, msgs) === false);
  t("鮮度: 時刻の無い会話は判断を信じる", contractFreshForAix(viewingMeta, [{ sender: "customer" }]) === true);
  t("最後のお客様の時刻", lastCustomerAt(msgs) === Date.parse("2026-10-13T12:40:40.000Z"));
}
// ④ 戻すスイッチ・本質なし
{
  t("AIX_BRAIN_CONTRACT=off で空", buildAixContractNote({ meta: viewingMeta, action: "viewing_invite", messages: msgs, env: { AIX_BRAIN_CONTRACT: "off" } }) === "");
  t("既定 on", aixBrainContractOn({}) === true && aixBrainContractOn({ AIX_BRAIN_CONTRACT: "off" }) === false);
  t("本質も状態も無い判断は空", buildAixContractNote({ meta: { analyzed_msg_ts: viewingMeta.analyzed_msg_ts }, action: "viewing_invite", messages: msgs, env: {} }) === "");
  t("本質が無い時は旧の全て回答を残す", keepAllQuestionsRule("") === true);
}
// ⑤ ボタン×ピッカーの照合
{
  t("鍵: ボタンだけ", askIsThisAix("property_send", "property_send", null));
  t("鍵: ボタン/ピッカー（ピッカー不明）", askIsThisAix("property_check_result/unavailable", "property_check_result", null));
  t("鍵: ピッカー違いは別", !askIsThisAix("property_check_result/unavailable", "property_check_result", "available"));
  t("鍵: 別のボタン", !askIsThisAix("estimate_sheet", "property_send", null));
  t("鍵: 空", !askIsThisAix("", "property_send", null));
}
// ⑥ 返信・約束の番の依頼はこの AIX の文の外（10/13 試し link1: 御見積書の約束・審査の励ましを AIX に足した）・気持ち
{
  const meta = { analyzed_msg_ts: "2026-10-13T12:40:43.006Z", action: "property_send", turn_contract: { asks: [
    { quote: "初期費用はどれくらい？", route: "promise", answer: "最大限割引の御見積書を作成しお送り", kind: "question" },
    { quote: "ペットは大丈夫？", route: "reply", answer: "資料にペット可", kind: "question" },
    { quote: "よろしくお願いします", route: "none", kind: "feeling" },
  ], feeling: { kind: "anxious", acknowledge: true }, must_not: [], proposals: [], close_only: false } };
  const n = buildAixContractNote({ meta, action: "property_send", messages: msgs, env: {} });
  t("返信・約束の依頼はこの文で触れない（中身は渡さない）", n.includes("この文では触れない依頼") && n.includes("初期費用はどれくらい？」（約束で受ける）") && n.includes("ペットは大丈夫？」（返信で答える）") && !n.includes("最大限割引"), n);
  t("触れない（none）", n.includes("触れない: 「よろしくお願いします」"), n);
  t("気持ち（不安）を一言で受ける", n.includes("不安") && n.includes("一言で受ける"), n);
}
// ⑧ 実物 viewing_invite:02c26493（10/13 試し・内覧の依頼＋初期費用の約束）: 値の線は落とし、話題の線は残す・初期費用の約束はこの文の外
{
  const meta = { analyzed_msg_ts: "2026-10-13T12:40:43.006Z", action: "viewing_invite", turn_contract: { asks: [
    { quote: "プレミアス鳳の内見お願い致します。", kind: "request", route: "aix", answer: null, aix: "viewing_invite" },
    { quote: "初期費用もお願い致します。", kind: "request", route: "promise", answer: "最大限割引した御見積書を作成してお送りします" },
  ], must_not: ["内覧日程を本文で確定する", "初期費用の金額を本文で示す", "申込誘導"], proposals: [], feeling: null, close_only: false } };
  const n = buildAixContractNote({ meta, action: "viewing_invite", messages: msgs, env: {} });
  t("02c26493: 内覧の依頼はこの AIX", n.includes("この AIX で受ける依頼: 「プレミアス鳳の内見"), n);
  t("02c26493: 初期費用の約束はこの文の外", n.includes("初期費用もお願い致します。」（約束で受ける）"), n);
  t("02c26493: 候補日を消す線（日程を本文で確定）は渡さない・申込誘導は渡す", !n.includes("内覧日程を本文で確定") && !n.includes("金額を本文で示す") && n.includes("申込誘導"), n);
  t("02c26493 2回目の線も落とす", mustNotForAix(["内覧日時を本文で確定させる", "見積書の金額を本文で書く"], "viewing_invite").length === 0);
}
// ⑨ 実物 property_send:88d3839f（ブレインは物件確認したの番・スタッフは物件ピックアップを押した）: 振り分けは渡さず、見積書・初期費用の線は渡す
{
  const meta = { analyzed_msg_ts: "2026-10-13T12:40:43.006Z", action: "property_check_result", turn_contract: { asks: [
    { quote: "ここって空いてますでしょうか？？", kind: "question", route: "promise", answer: "管理会社に募集状況を確認し、結果を報告する" },
    { quote: "4月とかの繁忙期より、今みたいな時期の方が家賃安いですかね？", kind: "question", route: "reply", answer: "繁忙期は家賃が上がる" },
  ], must_not: ["物件名の断定", "見積書", "初期費用", "申込誘導"], proposals: [], feeling: null, close_only: false } };
  const n = buildAixContractNote({ meta, action: "property_send", messages: msgs, env: {} });
  t("88d3839f: 振り分けを渡さない（全部が触れないにならない）", !n.includes("この文では触れない依頼") && !n.includes("この AIX で受ける依頼"), n);
  t("88d3839f: 見積書・初期費用の線は届く（重要1）", n.includes("見積書") && n.includes("初期費用") && n.includes("申込誘導"), n);
  t("88d3839f: 安全の線（物件名の断定）はこの AIX の話題でも渡す", n.includes("物件名の断定"), n);
  const n2 = buildAixContractNote({ meta, action: "property_check_result", messages: msgs, env: {} });
  t("88d3839f: 確認の約束は物件確認したで受ける（重要2）", n2.includes("この AIX で受ける依頼: 「ここって空いてますでしょうか"), n2);
}
// ⑩ 線の物差し（本番の must_not から）
{
  const keep = ["見積書", "見積書の話", "日程の催促", "内覧日程の打診", "土曜の時間を再提示", "審査の通過断言", "審査結果の断定", "空室の断言", "申込誘導", "来阪"];
  const drop = ["金額を書く", "内覧日の確定", "日時の創作", "初期費用の金額を書く", "内覧の候補日提示", "日時を本文で作る", "金額の断言"];
  t("話題の線・審査や空室の断言は値の線ではない", keep.every((s) => !STAFF_VALUE_LINE_RE.test(s)), keep.filter((s) => STAFF_VALUE_LINE_RE.test(s)));
  t("値を書く線は値の線", drop.every((s) => STAFF_VALUE_LINE_RE.test(s)), drop.filter((s) => !STAFF_VALUE_LINE_RE.test(s)));
  t("約束の種類: 見積→見積書送る", promiseFulfilledBy("御見積書を作成しお送り", "estimate_sheet") && !promiseFulfilledBy("御見積書を作成しお送り", "property_send"));
  t("約束の種類: 探す→物件ピックアップ", promiseFulfilledBy("ご条件でピックアップしお送り", "property_send"));
  t("約束の種類: 内覧の調整→内覧日調整", promiseFulfilledBy("内覧の日程を調整", "viewing_invite"));
}
// ⑪ 10/14 見直し: 自分の話題が行の頭で、他の話題・安全の線を含まない行だけ落とす
{
  const prop = ["物件の創作", "物件名を初出で書く", "見積書の提案", "分割払いの提案", "内覧日の提案", "内覧日の再提案", "内覧日程の提案", "10/18・土曜の再提案", "退去予定物件の内覧日時を約束する"];
  t("物件の AIX: 安全の線・別の話題・内覧の話題は渡す", mustNotForAix(prop, "property_send").length === prop.length && mustNotForAix(prop, "property_recommendation").length === prop.length, prop.filter((x) => !mustNotForAix([x], "property_send").length));
  t("物件の AIX: 自分の話題の行は落とす", ["物件の追加提案", "新しい物件の追加提案", "物件ピックアップ", "新規物件の提案", "物件の再提案"].every((x) => isOwnTopicLine(x, "property_send")));
  t("内覧の AIX: 申込を含む誘導・退去予定の約束は渡す", mustNotForAix(["内覧・申込の誘導", "退去予定物件の内覧日時を約束する"], "viewing_invite").length === 2 && mustNotForAix(["内覧・申込の誘導", "退去予定物件の内覧日時を約束する"], "meeting_place").length === 2);
  t("内覧の AIX: 内覧日の打診・再提案は落とす", ["内覧日程の打診", "内覧日の再提案", "内覧の日程"].every((x) => isOwnTopicLine(x, "viewing_invite")));
  t("申込の AIX: 見積書や申込の話は渡す・申込誘導は落とす", mustNotForAix(["見積書や申込の話"], "application_push").length === 1 && isOwnTopicLine("申込誘導", "application_push"));
  t("どの AIX でも断言・断定は落とさない", !isOwnTopicLine("空室の断言", "property_check_result") && !isOwnTopicLine("内覧可否の断定", "viewing_invite"));
  t("約束: 管理会社に内覧可否を確認→内覧日調整でも物件確認したでも受ける", promiseFulfilledBy("管理会社に内覧可否を確認しご連絡", "viewing_invite") && promiseFulfilledBy("管理会社に内覧可否を確認しご連絡", "property_check_result") && !promiseFulfilledBy("管理会社に内覧可否を確認しご連絡", "property_send"));
}
// ⑦ ✨ の戦略の注記: 本質がある時は宣言1文の強制を材料に下げる
{
  const meta = { winning_pattern: "内覧で決まる", closing_strategy: "内覧に誘う" };
  const forced = buildBrainStrategyNote(meta as never, { fresh: true });
  const soft = buildBrainStrategyNote(meta as never, { fresh: true, contractPresent: true });
  t("本質なし: 旧の宣言1文", forced.includes("1文だけ**入れる"), forced);
  t("本質あり: 宣言の強制を出さない", !soft.includes("1文だけ**入れる") && soft.includes("ブレインが読んだこの番】に合う時だけ"), soft);
}

// 2026-10-28 2番手の申込＋並行して探す（q152・AIX_CONTRACT_SITUATION）
{
  const l = situationLines("2番手で申込＋並行して探す・お客様承諾済み", "application_push");
  t("申込へ: 状況と竹内さんの形", l.length === 2 && /並行してお部屋お探しさせて頂きます/.test(l[1]), l);
  t("他の AIX は状況の行だけ", situationLines("2番手で申込＋並行して探す", "property_send").length === 1);
  t("状況が無ければ空", situationLines("", "application_push").length === 0);
  t("既定 off", aixContractSituationOn({}) === false && aixContractSituationOn({ AIX_CONTRACT_SITUATION: "on" }) === true);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
