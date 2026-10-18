// app/lib/__tests__/post-aix-next.test.ts — 2026-10-16 AIX の続きの「次の AIX」（10/16 の事例 a・b）
//   実行: npx tsx app/lib/__tests__/post-aix-next.test.ts
import { nextAixAfterAix, hasSearchConditions, postAixNextEnabled, customerTurnBeforeAix, freshContractAsks } from "../post-aix-turn";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("(a) 物件ピックアップした → 物件オススメ", nextAixAfterAix({ aixType: "property_send", hasConditions: true })?.action === "property_recommendation");
t("(b) 募集に出ていない・条件なし → ヒアリング", nextAixAfterAix({ aixType: "property_check_result", checkPattern: "unavailable", hasConditions: false })?.action === "condition_hearing");
t("(b) 募集に出ていない・条件あり → 新しくピックアップ", nextAixAfterAix({ aixType: "property_check_result", checkPattern: "unavailable", hasConditions: true })?.action === "property_send");
t("募集中の確認結果は今まで通り（null）", nextAixAfterAix({ aixType: "property_check_result", checkPattern: "available", hasConditions: true }) === null);
t("物件オススメは今まで通り（同じテンプレの2通目）", nextAixAfterAix({ aixType: "property_recommendation", hasConditions: true }) === null);
t("条件: エリアと家賃", hasSearchConditions({ desired_area: "心斎橋", rent_max: 150000 }) && !hasSearchConditions({ desired_area: "心斎橋", rent_max: null }) && !hasSearchConditions(null));
t("既定 on", postAixNextEnabled(undefined) && !postAixNextEnabled("off"));
// 2026-10-18 弱い所B-2: 1つの発言に複数の依頼（竹内さん 10/15 a71c2481）
const turn = "プレミアス鳳の内見お願い致します。\n初期費用もお願い致します。";
t("内見＋初期費用: 見積書の後 → 内覧日調整", nextAixAfterAix({ aixType: "estimate_sheet", hasConditions: true, order: { customerTurnText: turn } })?.action === "viewing_invite");
t("内見＋初期費用: 空きの確認の後 → 見積書", nextAixAfterAix({ aixType: "property_check_result", checkPattern: "available", hasConditions: true, order: { customerTurnText: turn } })?.action === "estimate_sheet");
t("初期費用だけ: 見積書の後は今まで通り（null）", nextAixAfterAix({ aixType: "estimate_sheet", hasConditions: true, order: { customerTurnText: "初期費用の見積もりお願いします" } }) === null);
t("内覧日調整の後は次なし", nextAixAfterAix({ aixType: "viewing_invite", hasConditions: true, order: { customerTurnText: turn } }) === null);
t("ブレインの本質の依頼ごとの AIX を順番に（見積書の後 → 内覧日調整）",
  nextAixAfterAix({ aixType: "estimate_sheet", hasConditions: true, order: { contractAsks: [{ route: "aix", aix: "viewing_invite" }, { route: "aix", aix: "estimate_sheet" }, { route: "reply", aix: null }] } })?.action === "viewing_invite");
t("ブレインの本質: 前の段の AIX は出さない（内覧日調整の後に見積書は出さない）",
  nextAixAfterAix({ aixType: "viewing_invite", hasConditions: true, order: { contractAsks: [{ route: "aix", aix: "estimate_sheet" }] } }) === null);
t("募集に出ていない後は順番を使わず (b) のまま", nextAixAfterAix({ aixType: "property_check_result", checkPattern: "unavailable", hasConditions: true, order: { customerTurnText: turn, contractAsks: [{ route: "aix", aix: "viewing_invite" }] } })?.action === "property_send");
t("物件ピックアップした の後は今まで通り物件オススメ", nextAixAfterAix({ aixType: "property_send", hasConditions: true, order: { customerTurnText: turn } })?.action === "property_recommendation");
const msgs = [
  { sender: "staff", text: "前の案内", rawCreatedAt: "2026-10-11T00:00:00Z" },
  { sender: "customer", text: "プレミアス鳳の内見お願い致します。", rawCreatedAt: "2026-10-11T01:00:00Z" },
  { sender: "customer", text: "初期費用もお願い致します。", rawCreatedAt: "2026-10-11T01:00:30Z" },
  { sender: "staff", text: "かしこまりました！！", rawCreatedAt: "2026-10-11T01:10:00Z" },
  { sender: "staff", text: "🌟御見積書…", isAix: true, rawCreatedAt: "2026-10-11T01:20:00Z" },
];
t("お客様の番の連投（手打ちの了承は飛ばす）", customerTurnBeforeAix(msgs, "2026-10-11T01:20:00Z") === "プレミアス鳳の内見お願い致します。\n初期費用もお願い致します。");
t("古い番（24時間より前）は読まない", customerTurnBeforeAix(msgs, "2026-10-13T01:20:00Z") === "");
t("ブレインの判断が今の番を見ていれば依頼を使う", (freshContractAsks({ turn_contract: { asks: [{ route: "aix", aix: "viewing_invite" }] }, analyzed_msg_ts: "2026-10-11T01:00:30Z" }, msgs) ?? []).length === 1);
t("古い判断は使わない", freshContractAsks({ turn_contract: { asks: [] }, analyzed_msg_ts: "2026-10-10T00:00:00Z" }, msgs) === null);
t("NEXT_PUBLIC_POST_AIX_ORDER=off で旧", nextAixAfterAix({ aixType: "estimate_sheet", hasConditions: true, order: { customerTurnText: turn, env: "off" } }) === null);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
