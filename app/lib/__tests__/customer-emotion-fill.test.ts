// app/lib/__tests__/customer-emotion-fill.test.ts — 気持ちの欄を空にしない（BRAIN_EMOTION_FILL）
import { fillCustomerEmotion, provisionalEmotion, brainEmotionFillOn } from "../customer-emotion-fill";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("既定 on・off で止まる", brainEmotionFillOn({}) && !brainEmotionFillOn({ BRAIN_EMOTION_FILL: "off" }));
t("① ブレインの気持ち", fillCustomerEmotion({ meta: { customer_emotion: "刺さっている" } })?.source === "brain");
t("② 気持ちの要約", JSON.stringify(fillCustomerEmotion({ meta: { customer_emotion: null, customer_mindset: { state: "安くしたい" } } })) === JSON.stringify({ value: "安くしたい", source: "mindset" }));
t("③ 前の判断の引き継ぎ", fillCustomerEmotion({ meta: null, prevMeta: { customer_mindset: { state: "審査不安" } } })?.source === "inherited");
t("④ 言葉の仮の値", JSON.stringify(fillCustomerEmotion({ meta: {}, customerText: "初期費用かなり抑えていただけて嬉しいです！" })) === JSON.stringify({ value: "前向き", source: "provisional" }));
t("言葉が無ければ空", fillCustomerEmotion({ meta: {}, customerText: "了解です" }) === null);
t("仮: 不安", provisionalEmotion("審査通るか不安です😭") === "迷い・不安");
t("仮: 急ぎ", provisionalEmotion("今月中に急ぎで探してます") === "急いでいる");
t("仮: 画像の書き起こしは見ない", provisionalEmotion("[画像] 嬉しい") === null);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
