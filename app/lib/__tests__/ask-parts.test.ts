// 2026-11-13 作業員7b: 1つの依頼を今言える部分と確認が要る部分に分ける（turn_contract.asks[].parts・ASK_PARTS_SPLIT・既定 off）
//   実例 12643（鍵交換は必須か＝資料で返信／外せるか＝管理会社で AIX）・12548（色・空室＝資料で返信／白基調の代わり＝AIX）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askPartsSplitOn, askPartsRule, normalizeAskParts, askIsSplit, partsAllNow, toComposeSource, ASK_PARTS_FIELD } from "../ask-parts";
import { resolveTwoStage } from "../two-stage";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${n}`); } else { fail++; console.log(`  NG  ${n}`); } };
t("既定 off", !askPartsSplitOn({}) && askPartsRule({}) === "");
const rule = askPartsRule({ ASK_PARTS_SPLIT: "on" });
t("on で決まりの1行（鍵交換の実例）", rule.startsWith("- ★") && rule.includes("鍵交換") && rule.endsWith("\n"));
t("欄の名前は作業員16・22 と同じ", ASK_PARTS_FIELD.includes("material_value|company_fact|staff_only|none") && ASK_PARTS_FIELD.includes("assertable|basically|needs_check") && ASK_PARTS_FIELD.includes("mgmt|rep|phone"));
// 12643
const p12643 = normalizeAskParts([
  { part: "鍵交換は必須か", source: "material_value", certainty: "assertable", route: "reply" },
  { part: "鍵交換を外せるか", source: "staff_only", who: "mgmt", certainty: "needs_check", route: "aix" },
]);
t("12643: 2つの部分に分かれる", p12643?.length === 2 && p12643[1].who === "mgmt");
t("12643: 今言える部分と確認が要る部分の両方", askIsSplit(p12643));
t("12643: 全部今言える、ではない", partsAllNow([{ parts: p12643 }]) === false);
// 12548
const p12548 = normalizeAskParts([
  { part: "色", source: "material_value", certainty: "assertable", route: "reply" },
  { part: "空室", source: "material_value", certainty: "basically", route: "reply" },
  { part: "白基調の代わりの部屋", source: "staff_only", certainty: "needs_check", route: "aix" },
]);
t("12548: 3つの部分・確認が要る部分あり", p12548?.length === 3 && askIsSplit(p12548));
t("形が崩れた部分は落とす・出所の無い certainty は既定", normalizeAskParts([{ part: "x", source: "conversation", route: "reply" }, { part: "y", source: "staff_only", route: "promise" }])?.map((p) => `${p.source}/${p.certainty}`).join(",") === "staff_only/needs_check");
t("部分が無ければ分からない（null）", partsAllNow([{}]) === null && normalizeAskParts([]) === undefined);
t("文の側の名前への読み替え", toComposeSource("material_value") === "material" && toComposeSource("none") === "general");
// 2段: 部分が全部 今言える持ち込みは、持ち込みの網を当てない（on の時だけ）
const base = { decisionSource: "llm", pickupReady: false, postApply: false, finalAix: "property_check_result", customerText: "こちら鍵交換は必須ですか？", brought: { ask: "other" as const, count: 1 }, askPartsAllNow: true } as unknown as Parameters<typeof resolveTwoStage>[0];
delete process.env.ASK_PARTS_SPLIT;
t("off は今まで通り持ち込みの約束", /brought/.test(resolveTwoStage(base)?.source ?? ""));
process.env.ASK_PARTS_SPLIT = "on";
t("on: 全部今言える持ち込みは約束にしない", resolveTwoStage(base) === null);
t("on: 確認が要る部分がある持ち込みは今まで通り", /brought/.test(resolveTwoStage({ ...base, askPartsAllNow: false })?.source ?? ""));
delete process.env.ASK_PARTS_SPLIT;
// 配線
const tc = readFileSync(join(__dirname, "..", "turn-contract.ts"), "utf8"), bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: turn_contract の欄・決まり・正規化", tc.includes("${askPartsSplitOn() ? `, ${ASK_PARTS_FIELD}` : \"\"}") && tc.includes("${askPartsRule()}") && tc.includes("normalizeAskParts((a as { parts?: unknown })?.parts)"));
t("配線: brain-core が2段に渡す", bc.includes("askPartsAllNow: askPartsSplitOn() ? partsAllNow("));
console.log(`ask-parts: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
