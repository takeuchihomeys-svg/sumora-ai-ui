// 2026-10-21 竹内さんの答え（A1・A2・B8・C8）の純関数のテスト（LLM なし）
// 実行: npx tsx app/lib/__tests__/owner-answers-1021.test.ts
import { resolveTwoStage, resolveTwoStageOrDirect, answerableDirectAix, type TwoStageInput } from "../two-stage";
import { isLikeThenHereQuestion, isLookElsewhereForConditions } from "../other-agent-viewing";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, info?: unknown) { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info ?? ""); } }
const base: TwoStageInput = { finalAix: null, decisionSource: "llm", pickupReady: false, postApply: false, ackOnly: false };

console.log("A1 管理会社に確かめれば分かる問いは AIX 直接");
{
  const vac = resolveTwoStageOrDirect({ ...base, finalAix: "property_check_result", customerText: "ここまだ空いてますか？" });
  t("空きの問い → 物件確認した直接", vac.direct === "property_check_result" && vac.verdict === null, vac);
  const est = resolveTwoStageOrDirect({ ...base, finalAix: "estimate_sheet", customerText: "初期費用いくらですか？" });
  t("見積の問い → 見積書送る直接", est.direct === "estimate_sheet" && est.verdict === null, est);
  const eq = resolveTwoStageOrDirect({ ...base, finalAix: "property_check_result", customerText: "エアコンは何台ついてますか？" });
  t("設備の問い（check_question）→ 2段のまま（答えがあれば答える・無ければ確認の約束）", eq.direct === null && /check_question/.test(eq.verdict?.source ?? ""), eq);
  const prevQ = process.env.TWO_STAGE_ANSWERABLE_DIRECT_QUESTION; process.env.TWO_STAGE_ANSWERABLE_DIRECT_QUESTION = "on";
  const eqOn = resolveTwoStageOrDirect({ ...base, finalAix: "property_check_result", customerText: "エアコンは何台ついてますか？" });
  if (prevQ === undefined) delete process.env.TWO_STAGE_ANSWERABLE_DIRECT_QUESTION; else process.env.TWO_STAGE_ANSWERABLE_DIRECT_QUESTION = prevQ;
  t("TWO_STAGE_ANSWERABLE_DIRECT_QUESTION=on で設備の問いも物件確認した直接", eqOn.direct === "property_check_result" && /check_question/.test(eqOn.coreSource ?? ""), eqOn);
  const ack = resolveTwoStageOrDirect({ ...base, finalAix: "acknowledge_check", decisionSource: "correction:ack_to_check", customerText: "マイナンバー以外で審査できますか" });
  t("元が確認します（ack_to_check・費用なし）の聞かれた事は2段のまま", ack.direct === null && ack.verdict?.kind === "check", ack);
  const fc = resolveTwoStageOrDirect({ ...base, finalAix: "estimate_sheet", firstContact: true, customerText: "初期費用いくらですか？" });
  t("真の初回（firstContact）は約束のまま", fc.direct === null && fc.verdict?.kind === "estimate", fc);
  const br = resolveTwoStageOrDirect({ ...base, finalAix: "property_check_result", customerText: "見積もり出してもらえますか？", brought: { ask: "cost", count: 2 } });
  t("持ち込みで費用だけ → 見積書送る直接（B1 brought_estimate の AIX）", br.direct === "estimate_sheet", br);
  const brv = resolveTwoStageOrDirect({ ...base, finalAix: "property_check_result", customerText: "ここ空いてますか？", brought: { ask: "vacancy", count: 1 } });
  t("持ち込みで空き → 物件確認した直接", brv.direct === "property_check_result", brv);
  const first = resolveTwoStageOrDirect({ ...base, finalAix: "property_check_result", decisionSource: "guard:first_contact", brought: { ask: "none", count: 1 } });
  t("初回の挨拶の番は約束のまま", first.direct === null && first.verdict?.kind === "check", first);
  const stale = resolveTwoStageOrDirect({ ...base, finalAix: "estimate_sheet", estimateMaterialAgeDays: 9, customerText: "見積お願いします" });
  t("古い資料の見積（10/16 決定）は約束のまま", stale.direct === null && /estimate_stale/.test(stale.verdict?.source ?? ""), stale);
  const work = resolveTwoStageOrDirect({ ...base, finalAix: "property_check_result", customerText: "アリバイ会社って使えますか？" });
  t("お仕事面のサポートは返信のまま", work.direct === null && /work_support/.test(work.verdict?.source ?? ""), work);
  const pick = resolveTwoStageOrDirect({ ...base, finalAix: "property_send", customerText: "2LDKも探してほしいです" });
  t("ピックアップは約束のまま（A1 の外）", pick.direct === null && pick.verdict?.kind === "pickup", pick);
  t("TWO_STAGE_ANSWERABLE_DIRECT=off で2段の約束", answerableDirectAix(resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "空いてますか？" }), base, { TWO_STAGE_ANSWERABLE_DIRECT: "off" }) === null);
  t("resolveTwoStage（監査の道具）は2段の判定のまま", resolveTwoStage({ ...base, finalAix: "property_check_result", customerText: "空いてますか？" })?.kind === "check");
}

console.log("A2 ピックアップの約束の後のお礼だけは物件の AIX");
{
  const v = resolveTwoStage({ ...base, finalAix: "property_send", decisionSource: "promise:pickup", ackOnly: true, ackRightAfterPromise: false, customerText: "ありがとうございます！" });
  t("台帳の最後が約束でなくても、お礼だけ → AIX のまま（null）", v === null, v);
  const prev = process.env.ACK_AFTER_PROMISE_REPLY; process.env.ACK_AFTER_PROMISE_REPLY = "on";
  const old = resolveTwoStage({ ...base, finalAix: "property_send", decisionSource: "promise:pickup", ackOnly: true, ackRightAfterPromise: false, customerText: "ありがとうございます！" });
  if (prev === undefined) delete process.env.ACK_AFTER_PROMISE_REPLY; else process.env.ACK_AFTER_PROMISE_REPLY = prev;
  t("ACK_AFTER_PROMISE_REPLY=on で旧（ピックアップの約束の返信）", old?.kind === "pickup", old);
}

console.log("B8 気に入ればこちらで / C8 条件が合わず他で探す");
t("B8 他社で内覧＋こちらでお願いできるか", isLikeThenHereQuestion("明日スーモに乗せていた不動産屋さんに依頼して内覧予定になってるんですが気に入ればそのままこちらでお願いとかもできますか？"));
t("B8 気に入ったらそちらで契約できますか", isLikeThenHereQuestion("気に入ったらそちらで契約できますか？"));
t("B8 ただのお礼は外", !isLikeThenHereQuestion("ありがとうございます！気に入りました"));
t("C8 条件が合わないので他で探します", isLookElsewhereForConditions("条件が合わないので他で探してみます"));
t("C8 予算的に厳しいので他社も当たってみます", isLookElsewhereForConditions("予算的に厳しいので他社さんも当たってみます"));
t("C8 他社で契約が決まった（C7）は外", !isLookElsewhereForConditions("条件合う物件が他社で見つかって契約が決まりました"));
t("C8 ただの他社の話は外", !isLookElsewhereForConditions("他社でも見積もらいました"));
t("C8 LOOK_ELSEWHERE_PICKUP=off", !isLookElsewhereForConditions("条件が合わないので他で探してみます", { LOOK_ELSEWHERE_PICKUP: "off" }));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
