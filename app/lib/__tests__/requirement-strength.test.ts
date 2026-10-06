// app/lib/__tests__/requirement-strength.test.ts — 要望の強さ（絶対／強い希望／できれば）と判定の札（実行: npx tsx app/lib/__tests__/requirement-strength.test.ts）
// 2026-10-06 ⑫ 竹内さん（ゆいと 10月後半入居）「10月入居っていう希望が今回の場合は絶対となる…状況によって決めきるようにする」
import { buildMustSendNote, readRequirementStrengths, moveInStrengthOf, petStrengthOf, rentStrengthOf, areaStrengthOf, strengthCodes, mustSendLine, hasStrengthSignal } from "../requirement-strength";
import { requirementStrengthsOfCustomer, DROP_REASON_CODES, HOLD_REASON_CODES, reasonPoints } from "../property-brain";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// ゆいとの実物（古い順）
const Y = [
  { text: "何度もすみません。\nここも出してもらっていいですか？\nそろそろ決めないと時間的に厳しいので一週間以内決めたいと思ってます", at: "2026-10-02T09:51:00Z" },
  { text: "見てきました。\nここは最短11月中旬でしょうか？", at: "2026-10-03T06:20:00Z" },
  { text: "10月後半くらいに入れるところとかありますか？", at: "2026-10-03T06:20:30Z" },
  { text: "なるべく豊中でお願いしたいです🙇", at: "2026-10-03T06:42:00Z" },
];
{
  const s = readRequirementStrengths(Y);
  t("ゆいと: 急ぎの後の「10月後半くらいに入れるところ」→ 入居時期は絶対", s.move_in?.strength === "must", JSON.stringify(s));
  t("ゆいと: 「なるべく豊中で」→ エリアはできれば", s.area?.strength === "nice", JSON.stringify(s.area));
  t("送付文はスタッフの言い方「10月後半ご入居可能なお部屋を優先して」", mustSendLine(s, "10月後半") === "10月後半ご入居可能なお部屋を優先して");
}
t("急ぎが無い「10月後半くらいに入れるところありますか」だけは強い希望", moveInStrengthOf("10月後半くらいに入れるところとかありますか？") === "strong");
t("「11月中に引っ越さないといけない」→ 絶対", moveInStrengthOf("更新の関係で11月中には引っ越さないといけないです") === "must");
t("「できれば年内に入居したい」→ できれば", moveInStrengthOf("できれば年内に入居したいです") === "nice");
t("入居の話でない文は読まない", moveInStrengthOf("内見いつ行けますでしょうか？") === null);
t("ペット: 今飼っている → 絶対", petStrengthOf("猫を2匹飼っています") === "must");
t("ペット: 将来的に飼いたい → できれば（ゆいとの条件の欄）", petStrengthOf("将来的にペット飼いたい") === "nice");
t("家賃: これ以上は無理 → 絶対", rentStrengthOf("家賃8万これ以上は無理です") === "must");
t("家賃: 多少オーバーしても → できれば", rentStrengthOf("家賃は多少オーバーしても大丈夫です") === "nice");
t("エリア: 保育園の関係で → 絶対", areaStrengthOf("保育園の関係で東成区じゃないと厳しいです") === "must");
t("手がかりの入口", hasStrengthSignal("そろそろ決めないと時間的に厳しいので一週間以内決めたい") && !hasStrengthSignal("ありがとうございます"));

// 判定の札
const must = { move_in: { strength: "must" as const, evidence: "" } };
t("絶対の入居 × 遅い → MOVE_IN_LATE_MUST（外す候補＝送らない）", strengthCodes(["MOVE_IN_LATE"], must).includes("MOVE_IN_LATE_MUST") && DROP_REASON_CODES.has("MOVE_IN_LATE_MUST"));
t("絶対の入居 × 分からない → MOVE_IN_UNKNOWN_MUST（保留＝スタッフが確かめる）", strengthCodes(["MOVE_IN_UNKNOWN"], must).includes("MOVE_IN_UNKNOWN_MUST") && HOLD_REASON_CODES.has("MOVE_IN_UNKNOWN_MUST"));
t("絶対の入居 × 間に合う → MOVE_IN_OK_MUST（+15・決めきる並び）", strengthCodes(["MOVE_IN_OK"], must).includes("MOVE_IN_OK_MUST") && reasonPoints("MOVE_IN_OK_MUST") === 15);
t("強い希望の入居 × 遅い → 今まで通り（保留の MOVE_IN_LATE だけ）", strengthCodes(["MOVE_IN_LATE"], { move_in: { strength: "strong", evidence: "" } }).length === 0);
t("今飼っているペット × ペット不可 → 外す候補", strengthCodes(["EQUIP_PET_NG"], { pet: { strength: "must", evidence: "" } }).includes("PET_NG_MUST"));
t("絶対の家賃の上限 × 1割超 → 外す候補", strengthCodes(["RENT_OVER_110"], { rent_max: { strength: "must", evidence: "" } }).includes("RENT_OVER_MUST"));

// ゆいとの実際の送付（10/04）: フィユフラッツ豊中末広町＝MOVE_IN_UNKNOWN（資料「相談」）・ディアコート曽根 302＝MOVE_IN_OK（即入居）
t("ゆいと 送付①フィユフラッツ（入居 相談）→ 保留でスタッフが入居日を確かめる", strengthCodes(["MOVE_IN_UNKNOWN"], readRequirementStrengths(Y)).join() === "MOVE_IN_UNKNOWN_MUST");
t("ゆいと 送付②ディアコート曽根302（即入居）→ 決めにいく物件", strengthCodes(["MOVE_IN_OK"], readRequirementStrengths(Y)).join() === "MOVE_IN_OK_MUST");

// 保存の値と条件の欄
t("お客様の行: 保存の値（LINE から）が勝ち、条件の欄から埋める", (() => {
  const s = requirementStrengthsOfCustomer({ requirement_strength: { move_in: { strength: "must", evidence: "x" } }, preferences: "将来的にペット飼いたい", move_in_time: "10月" });
  return s.move_in?.strength === "must" && s.pet?.strength === "nice";
})());
t("AIX の注記: 絶対の入居時期がある時だけ・スタッフの言い方", buildMustSendNote(readRequirementStrengths(Y), "10月後半").includes("10月後半ご入居可能なお部屋を優先して") && buildMustSendNote({}, "10月後半") === "");
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
