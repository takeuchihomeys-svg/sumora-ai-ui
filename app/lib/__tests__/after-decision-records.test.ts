// app/lib/__tests__/after-decision-records.test.ts — 判断の後の記録（入居の期限・次に来やすい通・2026-11-27 作業員A）
//   実行: npx tsx app/lib/__tests__/after-decision-records.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moveInFitOf, nextLineTopOf, buildAfterRecords, afterDecisionRecordsOn, NEXT_LINE_TABLE } from "../after-decision-records";
import { toFreshDigest } from "../brain-layers";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
// 入居 12/26 → 申込の目安 11/26〜12/12
t("入居の期限: 目安の前は余裕あり", moveInFitOf({ moveInYmd: "2026-12-26", todayYmd: "2026-11-20", finalAix: null }) === "余裕あり");
t("入居の期限: 目安の内で申込へ向かう一手＝期限に向く", moveInFitOf({ moveInYmd: "2026-12-26", todayYmd: "2026-11-27", finalAix: "viewing_invite" }) === "期限に向く");
t("入居の期限: 目安の内で返信・物件を送る＝期限の内で外れ", moveInFitOf({ moveInYmd: "2026-12-26", todayYmd: "2026-11-27", finalAix: null }) === "期限の内で外れ" && moveInFitOf({ moveInYmd: "2026-12-26", todayYmd: "2026-11-27", finalAix: "property_send" }) === "期限の内で外れ");
t("入居の期限: 目安を過ぎた", moveInFitOf({ moveInYmd: "2026-12-26", todayYmd: "2026-12-20", finalAix: "application_push" }) === "期限を過ぎて向く" && moveInFitOf({ moveInYmd: "2026-12-26", todayYmd: "2026-12-20", finalAix: null }) === "期限を過ぎた");
t("入居の期限: 入居が分からない＝期限なし", moveInFitOf({ moveInYmd: null, todayYmd: "2026-11-27", finalAix: "viewing_invite" }) === "期限なし");
t("次の通: 細かい節があればそれ・無ければ駅に戻る・駅も無ければ null", nextLineTopOf("分:brought_property", "brought_vacancy")?.key === "分:brought_property > brought_vacancy" && nextLineTopOf("proposing", "x_unknown")?.key === "proposing" && nextLineTopOf("no_station", null) === null);
t("表は n≥5 の節だけ・上位2つ", Object.values(NEXT_LINE_TABLE).every((v) => v.n >= 5 && v.top.length <= 2));
const ar = buildAfterRecords({ moveInYmd: "2026-12-26", todayYmd: "2026-11-27", finalAix: "viewing_invite", station: "proposing", sub: null });
const dg = toFreshDigest({ action: "viewing_invite", after_records: ar }, null) as Record<string, unknown>;
t("digest に1語と上位2つ（mif・nl）", dg.mif === "期限に向く" && dg.nl === "質問・返事なし");
t("記録が無ければ digest に付かない", !("mif" in (toFreshDigest({ action: "x" }, null) as Record<string, unknown>)));
t("既定 off", !afterDecisionRecordsOn({}) && afterDecisionRecordsOn({ AFTER_DECISION_RECORDS: "on" }));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: 判断の後（return の前）に on の時だけ作る・ブレインの出力の欄にはしない", bc.includes("adr.afterDecisionRecordsOn()") && bc.includes("after_records: afterRecords") && !/after_records[^\n]{0,40}parsed/.test(bc));
console.log(`after-decision-records: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
