// 返信の番の方向の文に継続の約束（2026-11-06 作業員9・弱い所 322・REPLY_DIRECTION_KEEP）
// 実行: npx tsx app/lib/__tests__/reply-direction-keep.test.ts
import { replyDirectionWithKeep, replyDirectionKeepOn } from "../reply-direction-keep";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const on = { REPLY_DIRECTION_KEEP: "on" };
const dir = "神崎川を外した条件でピックアップしてお送りすると約束する返信にする";
t("既定 off", !replyDirectionKeepOn({}) && replyDirectionWithKeep({ direction: dir, scene: "conditions", customerText: "神崎川は住んでいたが不便だった", staffToday: [] }, {}) === dir);
const a = replyDirectionWithKeep({ direction: dir, scene: "conditions", customerText: "神崎川は住んでいたが不便だった", staffToday: [] }, on);
t("条件の番（q008）→ 竹内さんの形の継続の約束", !!a && a.includes("全力でサポートさせて頂きます"), a);
t("了承の番は入れない", replyDirectionWithKeep({ direction: dir, scene: "ack", customerText: "ありがとうございます", staffToday: [] }, on) === dir);
t("物件への感想（q174 一旦見てみたい）は入れない", replyDirectionWithKeep({ direction: dir, scene: "conditions", customerText: "広くて綺麗ですね！一旦見てみたいです！他にも候補ありましたら", staffToday: [] }, on) === dir);
t("今日もう言っていれば入れない", replyDirectionWithKeep({ direction: dir, scene: "conditions", customerText: "家賃上げてもいいです", staffToday: ["〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！"] }, on) === dir);
t("方向が無ければ何もしない", replyDirectionWithKeep({ direction: null, scene: "conditions", customerText: "x", staffToday: [] }, on) === null);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
