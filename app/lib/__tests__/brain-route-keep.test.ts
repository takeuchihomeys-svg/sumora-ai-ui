// app/lib/__tests__/brain-route-keep.test.ts — 2026-10-16 方向が空の取り直しで最初の答えの道を残す
//   実行: npx tsx app/lib/__tests__/brain-route-keep.test.ts
import { mergeEmptyDirectionRetry, emptyDirectionKeepRouteEnabled, guardViewingKeepSearchPromise } from "../brain-route-keep";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

const first = { aix: null, reply_mode: "auto_reply", reply_direction: "", turn_contract: { asks: [{ route: "reply" }] }, key_topics: [], current_property: "A 101" };
const retry = { aix: "estimate_sheet", reply_mode: "aix", reply_direction: "見積書を送る", turn_contract: { asks: [{ route: "aix" }] }, key_topics: ["見積"], current_property: "B 202", latent_intent: "費用の不安" };
const m = mergeEmptyDirectionRetry(first, retry);
t("道（aix null）は最初の答えのまま", m.aix === null && m.reply_mode === "auto_reply");
t("turn_contract も最初の答えのまま", JSON.stringify(m.turn_contract) === JSON.stringify(first.turn_contract));
t("方向は取り直しから", m.reply_direction === "見積書を送る");
t("空の欄は取り直しで埋める", JSON.stringify(m.key_topics) === JSON.stringify(["見積"]) && m.latent_intent === "費用の不安");
t("埋まっている欄は最初の答えのまま", m.current_property === "A 101");
t("既定 on・off で戻す", emptyDirectionKeepRouteEnabled({}) && !emptyDirectionKeepRouteEnabled({ BRAIN_EMPTY_DIRECTION_KEEP_ROUTE: "off" }));
// 本質と最後の AIX の食い違い（q156・くれあさん 10/13）
{
  const { tcLeadAix } = require("../brain-route-keep") as typeof import("../brain-route-keep");
  const norm = (k: unknown) => (typeof k === "string" && k.trim() ? k.trim() : null);
  t("AIX の依頼が1種類で最後の欄と違う → 本質にそろえる", tcLeadAix("application_push", { asks: [{ route: "aix", aix: "viewing_invite" }] }, norm) === "viewing_invite");
  t("先に答える依頼が AIX ならその AIX（最後の欄が本質の依頼に無い時）", tcLeadAix("application_push", { lead_with: 1, asks: [{ route: "reply" }, { route: "aix", aix: "cost_breakdown" }, { route: "aix", aix: "viewing_invite" }] }, norm) === "cost_breakdown");
  t("最後の欄も本質の依頼の1つ（q048: 見積と待ち合わせ場所）→ 触らない", tcLeadAix("meeting_place", { lead_with: 0, asks: [{ route: "aix", aix: "estimate_sheet" }, { route: "aix", aix: "meeting_place" }] }, norm) === null);
  t("AIX の依頼が2種類で先が無い → 触らない", tcLeadAix("viewing_invite", { asks: [{ route: "aix", aix: "cost_breakdown" }, { route: "aix", aix: "viewing_invite" }] }, norm) === null);
  t("最後の欄が null（2段）→ 触らない", tcLeadAix(null, { asks: [{ route: "aix", aix: "viewing_invite" }] }, norm) === null);
  t("同じなら触らない", tcLeadAix("viewing_invite", { asks: [{ route: "aix", aix: "viewing_invite" }] }, norm) === null);
}
{
  const { promiseAixFromContract } = require("../brain-route-keep") as typeof import("../brain-route-keep");
  t("約束が見積 → estimate_sheet", promiseAixFromContract({ asks: [{ route: "promise", aix: null, answer: "敷金礼金無しで" }, { route: "promise", aix: "estimate_sheet" }] }) === "estimate_sheet");
  t("約束が確認（答えの文）→ property_check_result", promiseAixFromContract({ asks: [{ route: "promise", answer: "お子様の入居可否を管理会社に確認" }] }) === "property_check_result");
  t("確認と見積の両方 → 確認が先", promiseAixFromContract({ asks: [{ route: "promise", aix: "estimate_sheet" }, { route: "promise", aix: "property_check_result" }] }) === "property_check_result");
  t("ピックアップの約束・返信だけ・閉じる番は null", promiseAixFromContract({ asks: [{ route: "promise", answer: "ご条件でピックアップしお送り" }] }) === null && promiseAixFromContract({ asks: [{ route: "reply" }] }) === null && promiseAixFromContract({ close_only: true, asks: [{ route: "promise", aix: "estimate_sheet" }] }) === null);
}
{
  // 2026-10-18 弱い所B（q174）: 内覧誤提案ガードの差し替え先
  const g = guardViewingKeepSearchPromise;
  const q174 = { asks: [{ route: "reply", aix: "viewing_invite", about: "viewing_day" }, { route: "promise", about: "search_condition", polarity: "add", answer: "駅近の候補を探してお送り" }] };
  t("q174: 他の候補を探す約束がある → 申込へにしない", g(q174, {}) === true);
  t("約束の中身が「ピックアップ」（about なし）も", g({ asks: [{ route: "promise", answer: "他の候補をピックアップしお送り" }] }, {}) === true);
  t("内覧の希望だけ・確認の約束だけ → 今まで通り申込へ", g({ asks: [{ route: "aix", aix: "viewing_invite" }] }, {}) === false && g({ asks: [{ route: "promise", answer: "募集状況を確認" }] }, {}) === false);
  t("止めれば旧", g(q174, { GUARD_VIEWING_KEEP_SEARCH_PROMISE: "off" }) === false);
}
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
