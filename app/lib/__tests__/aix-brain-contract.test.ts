// app/lib/__tests__/aix-brain-contract.test.ts — ブレインの本質を AIX の文の材料に（実行: npx tsx app/lib/__tests__/aix-brain-contract.test.ts）
//   実物: 10/13 の本番の判断（内覧日調整の番「日曜日とかは案内可能ですか？」・言わない「申込誘導」）を伏せて使う
import { buildAixContractNote, contractFreshForAix, askIsThisAix, keepAllQuestionsRule, aixBrainContractOn, lastCustomerAt } from "../aix-brain-contract";
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
  t("内覧日調整: 値の言い切りの線（時間・空き）は AIX に渡さない", !n.includes("土曜の時間を再提示") && !n.includes("日曜の空きを手打ちで断定"), n);
  t("内覧日調整: お客様の今（状態・気にしている事の形・迷い）", n.includes("内覧したい") && n.includes("気にしている事: 費用・前向き") && n.includes("迷い: 内覧してから決めたい") && !n.includes("[object Object]"), n);
  t("内覧日調整: 新しい約束を足さない", n.includes("新しい**確認・交渉・作成の約束は足さない"), n);
  t("内覧日調整: 旧の全て回答は出さない", keepAllQuestionsRule(n) === false);
}
// ② 別の AIX の番は答えない
{
  const n = buildAixContractNote({ meta: viewingMeta, action: "property_send", messages: msgs, env: {} });
  t("物件ピックアップで内覧の依頼は別の AIX の番", n.includes("この文では触れない依頼") && n.includes("別の AIX viewing_invite") && !n.includes("この AIX で受ける依頼"), n);
}
// ③ 古い判断（お客様の新しい発言の前の分析）は渡さない
{
  const later = [...msgs, { sender: "customer", text: "あと見積もりも", rawCreatedAt: "2026-10-13T12:50:00.000Z" }];
  t("古い判断は空", buildAixContractNote({ meta: viewingMeta, action: "viewing_invite", messages: later, env: {} }) === "");
  t("鮮度: 新しい発言の後の分析は新しい", contractFreshForAix(viewingMeta, msgs) === true);
  t("鮮度: analyzed_msg_ts が無い判断は使わない", contractFreshForAix({ turn_contract: viewingMeta.turn_contract }, msgs) === false);
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
  const meta = { analyzed_msg_ts: "2026-10-13T12:40:43.006Z", turn_contract: { asks: [
    { quote: "初期費用はどれくらい？", route: "promise", answer: "最大限割引の御見積書を作成しお送り", kind: "question" },
    { quote: "ペットは大丈夫？", route: "reply", answer: "資料にペット可", kind: "question" },
    { quote: "よろしくお願いします", route: "none", kind: "feeling" },
  ], feeling: { kind: "anxious", acknowledge: true }, must_not: [], proposals: [], close_only: false } };
  const n = buildAixContractNote({ meta, action: "property_send", messages: msgs, env: {} });
  t("返信・約束の依頼はこの文で触れない（中身は渡さない）", n.includes("この文では触れない依頼") && n.includes("初期費用はどれくらい？」（約束で受ける）") && n.includes("ペットは大丈夫？」（返信で答える）") && !n.includes("最大限割引"), n);
  t("触れない（none）", n.includes("触れない: 「よろしくお願いします」"), n);
  t("気持ち（不安）を一言で受ける", n.includes("不安") && n.includes("一言で受ける"), n);
}
// ⑦ ✨ の戦略の注記: 本質がある時は宣言1文の強制を材料に下げる
{
  const meta = { winning_pattern: "内覧で決まる", closing_strategy: "内覧に誘う" };
  const forced = buildBrainStrategyNote(meta as never, { fresh: true });
  const soft = buildBrainStrategyNote(meta as never, { fresh: true, contractPresent: true });
  t("本質なし: 旧の宣言1文", forced.includes("1文だけ**入れる"), forced);
  t("本質あり: 宣言の強制を出さない", !soft.includes("1文だけ**入れる") && soft.includes("ブレインが読んだこの番】に合う時だけ"), soft);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
