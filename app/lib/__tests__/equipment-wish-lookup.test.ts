// 設備の希望の言い方も送った物件の設備の読みに通す（2026-11-18 作業員H・EQUIPMENT_WISH_LOOKUP・既定 off・q439）
// 実行: npx tsx app/lib/__tests__/equipment-wish-lookup.test.ts
import { detectEquipmentQuestion, equipmentWishLookupOn } from "../equipment-question";
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
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
