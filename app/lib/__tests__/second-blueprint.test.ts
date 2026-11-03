// app/lib/__tests__/second-blueprint.test.ts — 2通目を設計図の型に乗せる（純関数・文は作り物）
import { secondBlueprintOn, intentFromAppealJudge, secondBlueprint, secondBlueprintNote } from "../second-blueprint";
import type { AppealJudge } from "../second-appeal-judge";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const DATA = { forms: {}, examples: [{ scene: "物件オススメ・新規ピックアップ", els: ["shikirei"], body: "手本 敷金礼金なしで初期費用を抑える事ができ、YUMAさんにかなりオススメ出来るお部屋となります！！", sent_on: "2026-10-01" }] };
const j: AppealJudge = { first: { text: "敷金礼金なしで初期費用を抑えられる", why: "費用を気にされている" }, second: { text: "梅田まで乗り換えなし", why: "通勤" }, count: 2, form: "〇〇さんにかなりオススメ出来るお部屋", closing: "apply", closingWhy: "入居が近い" };

t("既定 off", !secondBlueprintOn({}) && secondBlueprintOn({ AIX_SECOND_BLUEPRINT: "on" }));
const it = intentFromAppealJudge(j);
t("意図に移す（訴求・物件が主語・申込の締め・添え1つ）", it.purpose === "appeal" && it.main.subject === "property" && it.closing === "apply_cta" && it.adds.join() === "appeal", it);
t("ご査収・内覧の締め", intentFromAppealJudge({ ...j, closing: "receipt" }).closing === "receipt" && intentFromAppealJudge({ ...j, closing: "viewing" }).closing === "viewing_cta");
const bp = secondBlueprint(j);
t("並び（挨拶なし→メイン→添え→誘い）", bp.parts.map((p) => p.role).join(">") === "main>add>cta", bp.parts);
t("誘いは申込の文", /お申込しお部屋抑え/.test(bp.parts[2].say));
t("確かめ OK", bp.check.mainOnPurpose && bp.check.addsNotEatingMain, bp.check);
const one = secondBlueprint({ ...j, second: null, count: 1, closing: "receipt" });
t("1つだけの時は添えなし・ご査収", one.parts.map((p) => p.role).join(">") === "main>close", one.parts);
const note = secondBlueprintNote(j, "物件オススメ・新規ピックアップ", DATA);
t("注記に設計図・締めの理由・手本", /文の設計図/.test(note) && /締めの理由: 入居が近い/.test(note) && /2通目の手本/.test(note), note);

console.log(`second-blueprint: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
