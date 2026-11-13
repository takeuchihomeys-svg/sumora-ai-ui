// 2026-11-13 作業員7b: ブレインの出力の中の食い違いを本質（turn_contract）の側に寄せる（BRAIN_AIX_FOLLOWS_CONTRACT・既定 off）
//   実物（試験の答案の生の出力）: q431 fc15-fc3a#1・q092 proc-on-dig-1110b#1・q001 w16-nl-on2-p2・q367 w7-ppw-on3#2・q009 focus-cond-q009-dig#2
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alignAixToContract, brainAixFollowsContractOn } from "../aix-follows-contract";
import { resolveTwoStage } from "../two-stage";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${n}`); } else { fail++; console.log(`  NG  ${n}`); } };

t("既定 off", !brainAixFollowsContractOn({}) && brainAixFollowsContractOn({ BRAIN_AIX_FOLLOWS_CONTRACT: "on" }));
// ① q431: 送った物件のお礼だけ（route none）なのに物件の AIX
t("① q431 → 返信", alignAixToContract({ finalAix: "property_send", rawAix: "property_send", asks: [{ route: "none", about: "reaction_to_sent", aix: null }] })?.to === "reply");
// ② q092#1: ブレインの aix の欄は空・依頼に確認の AIX（入居の最短の問い）・物件の AIX は合図から
const q092 = alignAixToContract({ finalAix: "property_send", rawAix: null, asks: [{ route: "aix", about: "procedure", aix: "property_check_result" }, { route: "promise", about: "search_condition", aix: null }] });
t("② q092#1 → AIX【物件確認した】", q092?.to === "aix" && q092.aix === "property_check_result");
t("② ブレインが自分で物件の AIX を書いた番は②にしない", alignAixToContract({ finalAix: "property_send", rawAix: "property_send", asks: [{ route: "aix", about: "procedure", aix: "property_check_result" }] }) === null);
// q001: 探す約束と物件の AIX が揃っている（出し切りの左右は別の決まり）＝触らない
t("q001 は触らない", alignAixToContract({ finalAix: "property_send", rawAix: "property_send", asks: [{ route: "promise", about: "search_condition", aix: "property_send" }] }) === null);
t("物件の AIX でない番は触らない", alignAixToContract({ finalAix: "viewing_invite", rawAix: "viewing_invite", asks: [{ route: "none" }] }) === null && alignAixToContract({ finalAix: null, rawAix: null, asks: [{ route: "none" }] }) === null);
t("依頼が無い番は触らない", alignAixToContract({ finalAix: "property_send", rawAix: null, asks: [] }) === null);
// ③ q367・q009: 探す約束なのに AIX の欄が物件確認した → ピックアップの約束（新しいスイッチでも古いスイッチでも）
const base = { decisionSource: "llm", pickupReady: false, postApply: false, finalAix: "property_check_result", askAbout: "search_condition", customerText: "以前ご依頼した条件でもう一度探していただけませんでしょうか" } as Parameters<typeof resolveTwoStage>[0];
delete process.env.TWO_STAGE_KIND_FROM_ABOUT; delete process.env.BRAIN_AIX_FOLLOWS_CONTRACT;
t("③ 両方 off は確認の約束（今まで通り）", resolveTwoStage(base)?.kind === "check");
process.env.BRAIN_AIX_FOLLOWS_CONTRACT = "on";
t("③ q367 BRAIN_AIX_FOLLOWS_CONTRACT=on → ピックアップの約束", resolveTwoStage(base)?.kind === "pickup");
t("③ q009（言い直し・探す約束）も同じ", resolveTwoStage({ ...base, customerText: "もう少し広めで探してもらえますか？" })?.kind === "pickup");
delete process.env.BRAIN_AIX_FOLLOWS_CONTRACT; process.env.TWO_STAGE_KIND_FROM_ABOUT = "on";
t("③ 古いスイッチ TWO_STAGE_KIND_FROM_ABOUT=on でも同じ", resolveTwoStage(base)?.kind === "pickup");
delete process.env.TWO_STAGE_KIND_FROM_ABOUT;
// 配線
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
const i = bc.indexOf("alignAixToContract({ finalAix,"), j = bc.indexOf("const twoStageArgs: Parameters<typeof resolveTwoStageOrDirect>[0] = {");
t("配線: brain-core は2段の前で揃える", i > 0 && j > i && bc.includes("brainAixFollowsContractOn() && !isPostApplyStatus(convStatus)"));
console.log(`aix-follows-contract: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
