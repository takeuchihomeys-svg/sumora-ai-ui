// app/lib/__tests__/route-backplan.test.ts — 申込から逆算した計画（2026-11-25 作業員A・#745）
//   実行: npx tsx app/lib/__tests__/route-backplan.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backplanOf, backplanLine, applyRouteBackplanOn, type BackplanFacts } from "../route-backplan";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const base: BackplanFacts = { node: "proposing", focus: false, propertiesSent: 5, estimateSent: false, viewingScheduled: false, viewingDone: false, viewingWish: false, applyIntent: false, screeningConcern: false, moveInYmd: null, todayYmd: "2026-11-25" };
const p1 = backplanOf(base)!;
t("提案中・決め手なし: 内覧ありの本線・この先 3駅", p1.path === "内覧あり" && p1.ahead.length === 3 && p1.ahead[0] === "interested" && p1.ahead[1] === "estimate");
t("2手先へ仕込む一言（見積）", !!p1.plant && p1.plant.includes("御見積書"));
const p2 = backplanOf({ ...base, node: "estimate", estimateSent: true, applyIntent: true })!;
t("見積・申込の意思・内覧の希望なし: 内覧なしの道は内覧の駅を飛ばす", p2.path === "内覧なし" && !p2.ahead.some((n) => n.startsWith("viewing")) && p2.ahead[0] === "apply_prep");
const p3 = backplanOf({ ...base, node: "estimate", estimateSent: true, applyIntent: true, viewingWish: true })!;
t("申込の意思でも内覧の希望があれば内覧あり", p3.path === "内覧あり");
const p4 = backplanOf({ ...base, moveInYmd: "2026-12-31" })!;
t("申込の目安: 入居の3〜4週間前の幅", p4.applyBy === "2026-12-03〜2026-12-10" && backplanLine(p4).includes("目安"));
t("申込以降・駅なしは null", backplanOf({ ...base, node: "applying" }) === null && backplanOf({ ...base, node: null }) === null);
const ln = backplanLine(p1);
t("1行: 道・要る物・この先・道はあなたが決める", ln.includes("道: 内覧あり") && ln.includes("物件が決まる") && ln.includes("この先") && ln.includes("あなたが決める") && backplanLine(null) === "");
t("既定 off", !applyRouteBackplanOn({}) && applyRouteBackplanOn({ APPLY_ROUTE_BACKPLAN: "on" }));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ地図の文の後ろに", bc.includes("bp.applyRouteBackplanOn() && ar.loc?.node") && bc.includes("materialMarks.route_backplan"));
console.log(`route-backplan: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
