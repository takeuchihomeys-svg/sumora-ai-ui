// app/lib/__tests__/check-question-brain-first.test.ts — 実行: npx tsx app/lib/__tests__/check-question-brain-first.test.ts
//   試験の答案の実物（ブレインの生の aix と turn_contract の依頼）をそのまま使う
import { readFileSync } from "node:fs";
import { checkQuestionBrainFirstOn, checkQuestionBrainRoute, contractHasCheckPromise } from "../check-question-brain-first";
import { brainContractPromisesPickup } from "../override-demote";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.error(`NG ${name}`); } };
const route = (rawAix: unknown, asks: unknown[]) => { const c = { asks }; return checkQuestionBrainRoute({ rawAix, contract: c, promisesPickup: brainContractPromisesPickup(c, {}) }); };

t("既定 off", !checkQuestionBrainFirstOn({}) && checkQuestionBrainFirstOn({ TWO_STAGE_CHECK_QUESTION_BRAIN_FIRST: "on" }));
// 直す番
t("q009 ピックアップの約束→pickup", route(undefined, [{ route: "promise", about: "search_condition", answer: "家賃上限を上げた条件で他の部屋をピックアップしてお送りする" }]) === "pickup");
t("q090 ピックアップの約束（aix 付き）→pickup", route(null, [{ route: "promise", aix: "property_send", about: "search_condition", answer: "カウンターキッチン付き物件を探し、新着で出次第お送りする約束をする" }]) === "pickup");
t("q145 依頼が全部 reply→reply", route(undefined, [{ route: "reply", about: "viewing_day", answer: "12月中以降の内覧案内済み。入居は内覧後になるため11月中旬は難しい" }]) === "reply");
// 守り
t("q177 ブレインが物件確認したを選んだ番は触らない", route("property_check_result", [{ route: "aix", aix: "property_check_result" }]) === null);
t("q092 ブレインが内覧調整を選んだ番は触らない", route("viewing_invite", [{ route: "reply", answer: "最短11月中旬ごろのご入居" }, { route: "promise", answer: "10月後半入居可能な物件を探してお送りする" }]) === null);
t("q088 確認の約束がある番は触らない", route(undefined, [{ route: "promise", answer: "畳交換が可能か管理会社に確認し、結果を報告する約束" }]) === null);
t("q100 aix=物件確認した の約束も確認", contractHasCheckPromise([{ route: "promise", aix: "property_check_result", answer: "代理契約可能か確認させて頂きます" }]));
t("q114 募集状況確認と見積の約束→触らない", route(undefined, [{ route: "reply", about: "reaction_to_sent" }, { route: "promise", about: "search_condition", answer: "物件URLが届き次第、募集状況確認と最大限割引した御見積書をお送りする旨を約束す" }]) === null);
t("依頼が空は触らない", route(undefined, []) === null);
t("aix=none の文字は空と読む", route("none", [{ route: "reply" }]) === "reply");
// 配線（brain-core が check_question の後に読む）
const core = readFileSync("app/lib/brain-core.ts", "utf8");
t("brain-core に配線", core.includes("checkQuestionBrainFirstOn() && twoStage && /check_question/.test(twoStage.source)") && core.includes("checkQuestionBrainRoute({ rawAix: (parsed as { aix?: unknown }).aix"));

console.log(`check-question-brain-first: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
