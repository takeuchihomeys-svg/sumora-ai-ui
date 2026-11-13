// 2026-11-13 作業員7b: ブレインの出力の中の食い違いを本質（turn_contract）の側に寄せる（BRAIN_AIX_FOLLOWS_CONTRACT・既定 off）
//   実物（試験の答案の生の出力）: q431 fc15-fc3a#1・q092 proc-on-dig-1110b#1・q001 w16-nl-on2-p2・q367 w7-ppw-on3#2・q009 focus-cond-q009-dig#2
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alignAixToContract, brainAixFollowsContractOn, replyPlanAfterFollow } from "../aix-follows-contract";
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
// 2026-11-13 作業員C: q431 の悪化（w7b-t3-on3 の答案の生の出力そのまま）＝道は返信に寄ったが方向は「ピックアップを実行して届ける」のまま
const q431 = replyPlanAfterFollow({ direction: "内覧のお礼を受け止め、約束した2LDKの物件ピックアップを実行して届ける", keyTopics: [], avoidTopics: [], openPickupPromise: true });
t("q431 方向: 今送る向きを外す", q431.changed && !/実行して届ける/.test(q431.direction) && /出次第随時お送り/.test(q431.direction));
t("q431 key_topics に約束を続ける事", q431.keyTopics.some((k) => /出次第随時お送り/.test(k)));
t("q431 avoid_topics に今送ったように書かない", q431.avoidTopics.includes("新しい物件を今送ったかのように書く"));
const noPromise = replyPlanAfterFollow({ direction: "お礼を受け、物件をお送りする", keyTopics: ["新しい物件を送る"], avoidTopics: ["値段の話"], openPickupPromise: false });
t("約束が無い番は締めだけ（出次第の約束を足さない）", noPromise.changed && !/出次第/.test(noPromise.direction) && noPromise.keyTopics.length === 0 && noPromise.avoidTopics[0] === "値段の話");
const already = replyPlanAfterFollow({ direction: "内覧後のお礼への感謝を受け止め、新着のオススメの2LDKを出次第お送りする約束で穏やかに締める", keyTopics: ["感謝"], avoidTopics: [], openPickupPromise: true });
t("もう受けて締める方向（本番の prodBrain）は変えない", !already.changed && already.direction.startsWith("内覧後のお礼"));
t("後で送る約束（お部屋が出次第お送りする）は今送る向きと読まない", !replyPlanAfterFollow({ direction: "お礼を受け、オススメできるお部屋が出次第随時お送りすると伝える", keyTopics: ["お部屋が出次第お送りする"], avoidTopics: [], openPickupPromise: true }).changed);
t("配線: ① の返信で方向を揃える", bc.includes("replyPlanAfterFollow({ direction:") && bc.indexOf("replyPlanAfterFollow({ direction:") > i && bc.indexOf("replyPlanAfterFollow({ direction:") < j);
console.log(`aix-follows-contract: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
