// app/lib/__tests__/post-aix-template-rec.test.ts — 2026-10-13 AIX の後の続きのテンプレはブレイン＋集計（Sonnet をやめた）
//   実行: npx tsx app/lib/__tests__/post-aix-template-rec.test.ts
//   候補の名前は本番の templates の実物（10/13）
import { rankPostAixTemplates, sanitizeAfterAixTemplate, matchTemplateByName, brainFollowupFor, brainTemplateRecEnabled } from "../post-aix-template-rec";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

const pickup = [
  { id: "a", label: "物件ピックアップ紹介（後続）", use_count: 0 },
  { id: "b", label: "駅周辺物件ピックアップ（後続）", use_count: 2 },
  { id: "c", label: "複数エリアでピックアップ（後続）", use_count: 5, recommend_shown_count: 10, recommend_picked_count: 1 },
  { id: "d", label: "【現状全部】引き続き新着出たら連絡", use_count: 0 },
];
const est = [
  { id: "e1", label: "【申込誘導】" },
  { id: "e2", label: "【退去予定】1件申込誘導", use_count: 3 },
];

t("既定 on・BRAIN_TEMPLATE_REC=off で戻す", brainTemplateRecEnabled({}) && !brainTemplateRecEnabled({ BRAIN_TEMPLATE_REC: "off" }));
t("整える: 【AIX】と括弧を外す", sanitizeAfterAixTemplate("【AIX】「物件ピックアップ紹介（後続）」") === "物件ピックアップ紹介（後続）");
t("整える: null の文字は無し", sanitizeAfterAixTemplate("null") === undefined && sanitizeAfterAixTemplate("") === undefined && sanitizeAfterAixTemplate(3) === undefined);
t("整える: 【申込誘導】の括弧は残す", sanitizeAfterAixTemplate("【申込誘導】") === "【申込誘導】");
t("名前: 半角の括弧でも当たる", matchTemplateByName("物件ピックアップ紹介(後続)", pickup)?.id === "a");
t("名前: 「申込誘導」は近い長さの【申込誘導】", matchTemplateByName("申込誘導", est)?.id === "e1");
t("名前: 当たらなければ null", matchTemplateByName("ヒアリング締め", pickup) === null);

// ブレインの判断が送った AIX と同じ時だけ使う
const metaSend = { action: "property_send", after_aix_template: "物件ピックアップ紹介（後続）", next_steps: ["Step3: 【AIX】物件ピックアップ紹介（後続）をAI最適化して送る"] };
t("action が違えば使わない", brainFollowupFor("estimate_sheet", [metaSend]).name === null);
t("action が同じなら使う", brainFollowupFor("property_send", [null, metaSend]).name === "物件ピックアップ紹介（後続）");

const r1 = rankPostAixTemplates({ actionType: "property_send", status: "proposing", templates: pickup, brainMetas: [metaSend],
  chainRecommended: { "*|property_send": "b" }, chainTransitions: { b: { next: "c", count: 3 } } });
t("1位はブレインの続き", r1[0]?.id === "a" && r1[0].score === 95);
t("2位は集計の一番", r1[1]?.id === "b" && /集計/.test(r1[1].reason));
t("3位は集計のその次", r1[2]?.id === "c");
t("3件まで", r1.length === 3);

// 状態つきの集計が先
const r2 = rankPostAixTemplates({ actionType: "property_send", status: "hot", templates: pickup, brainMetas: [],
  chainRecommended: { "hot|property_send": "c", "*|property_send": "b" } });
t("状態つきの集計を先に", r2[0]?.id === "c");
t("ブレインが無くても実績で埋める（実績の無い物は入れない）", r2.every((x) => x.id !== "a" && x.id !== "d"));

// 次の手順だけに名前がある
const r3 = rankPostAixTemplates({ actionType: "estimate_sheet", templates: est, brainMetas: [{ action: "estimate_sheet", next_steps: ["Step2: 【AIX】【申込誘導】をAI最適化して送る"] }] });
t("次の手順の名前を使う", r3[0]?.id === "e1" && /次の手順/.test(r3[0].reason));

// 小分けの場面
const r4 = rankPostAixTemplates({ actionType: "property_send", templates: [...pickup, { id: "n", label: "【新着まとめ】新着オススメ" }], brainMetas: [], subCategory: "新着まとめ" });
t("小分けの場面のテンプレを先に", r4[0]?.id === "n");

t("AIX が無ければブレインは使わない", rankPostAixTemplates({ actionType: null, templates: pickup, brainMetas: [metaSend] }).every((x) => x.score < 95));

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
