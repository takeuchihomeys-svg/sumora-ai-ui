// 設備の希望の言い方も送った物件の設備の読みに通す（2026-11-18 作業員H・EQUIPMENT_WISH_LOOKUP・既定 off・q439）
// 実行: npx tsx app/lib/__tests__/equipment-wish-lookup.test.ts
import { detectEquipmentQuestion, equipmentWishLookupOn, equipmentWishBrainLine, equipAnswerPlan, type EquipVerdict, type EquipPropertyAnswer } from "../equipment-question";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const on = { EQUIPMENT_WISH_LOOKUP: "on" };
// 実物（q439＝見張り 12838 のお客様の文）
const q439 = "ありがとうございます！\n旦那と2人暮らしの予定で、\nできればカウンターキッチンだと\n嬉しいんです。";
t("既定 off", !equipmentWishLookupOn({}) && equipmentWishLookupOn(on));
t("off は今まで通り（希望は読まない）", detectEquipmentQuestion(q439, {}) === null);
const r = detectEquipmentQuestion(q439, on);
t("on・q439 → カウンターキッチンの希望として読む", !!r && r.topics.includes("counter_kitchen") && r.wish === true, r);
t("on・今までの質問は今まで通り（wish なし）", (() => { const x = detectEquipmentQuestion("ガスコンロはついてないのですか？", on); return !!x && x.topics.includes("gas_stove") && !x.wish; })());
t("on・探す条件（〜の部屋ありますか）は読まない", detectEquipmentQuestion("オートロックの部屋ありますか？", on) === null);
t("on・希望でも設備の語が無ければ読まない", detectEquipmentQuestion("できれば駅近だと嬉しいです", on) === null);
t("off・カウンターキッチンの質問は今まで通り読まない（話題を足すのは on だけ）", detectEquipmentQuestion("カウンターキッチンですか？", {}) === null);
// 2026-11-21 作業員K2（#132）: 希望の番のブレインへの1行を、送った物件の資料の答えで3つに分ける（q439＝送った5件の資料の文字にカウンターキッチンの記載が無い＝分からない）
{
  const ans = (verdict: EquipVerdict) => [{ topic: "counter_kitchen" as const, verdict, detail: null, basis: [] }] as unknown as EquipPropertyAnswer["answers"];
  const prop = (name: string, verdict: EquipVerdict): EquipPropertyAnswer => ({ name, roomNo: "101", by: "same_batch", answers: ans(verdict), materialRead: true });
  const unknown5 = equipmentWishBrainLine(equipAnswerPlan(["A", "B", "C", "D", "E"].map((n) => prop(n, "unknown"))));
  // 2026-11-21 竹内さんの決定: 設備の希望の番はどれも「探す約束の返信→次は AIX（2段:pickup）」。資料の答えは事実として添えるだけ
  t("q439 型（全部分からない）: 探す約束の返信→次は AIX", /探す約束を返信/.test(unknown5) && /2段:pickup/.test(unknown5) && /分からない/.test(unknown5) && !/探す約束にしない/.test(unknown5), unknown5);
  const oneYes = equipmentWishBrainLine(equipAnswerPlan([prop("A", "unknown"), prop("B", "yes")]));
  t("1件が資料で有る: それでも探す約束（名前は手がかりとして添える）", /B 101/.test(oneYes) && /当てはまる部屋があっても同じ/.test(oneYes) && !/送った物件から答えて勧める番/.test(oneYes), oneYes);
  const allNo = equipmentWishBrainLine(equipAnswerPlan([prop("A", "no"), prop("B", "no")]));
  t("全部が資料に無い: 探す約束", /探す約束を返信/.test(allNo) && /無いと書いてある/.test(allNo), allNo);
  const mixed = equipmentWishBrainLine(equipAnswerPlan([prop("A", "no"), prop("B", "unknown")]));
  t("無いと分からないが混ざる: 探す約束", /探す約束を返信/.test(mixed) && !/探す約束にしない/.test(mixed), mixed);
}
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
