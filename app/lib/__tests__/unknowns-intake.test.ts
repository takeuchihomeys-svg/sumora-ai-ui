// app/lib/__tests__/unknowns-intake.test.ts — 分からない事の表の抜けていた入口（npx tsx app/lib/__tests__/unknowns-intake.test.ts）
import { prodMissHits, selfReportHits, examRegressionHits, moveFamily, type ProdTurn } from "../unknowns-intake";
import { weaknessKeyForUnknown, isWeaknessKey } from "../brain-weaknesses";
import { aggregateUnknowns } from "../brain-unknowns";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log("FAIL", name); } };

// 本番の番の実物（11/05 竹内さんの35番の数え）
const base = { conversationId: "c-1", at: "2026-10-28T10:55:54Z", twoChoice: false, staffWriter: "takeuchi" } as const;
const turns: ProdTurn[] = [
  { ...base, turnId: 8950, brainAction: "property_send", staffMove: { kind: "reply", aix: null } },            // 外れ（物件→返信）
  { ...base, turnId: 9237, brainAction: "property_send", twoChoice: true, staffMove: { kind: "reply", aix: null } }, // 2択で竹内さんは返信＝外れにしない
  { ...base, turnId: 8931, brainAction: "property_check_result", staffMove: { kind: "aix", aix: "estimate_sheet" } }, // 外れ（確認→見積）
  { ...base, turnId: 10513, brainAction: "property_check_result", staffMove: { kind: "aix", aix: "aix_unknown" } }, // 比べられない
  { ...base, turnId: 8778, brainAction: "property_send", staffMove: { kind: "aix", aix: "property_send" } },     // 当たり
  { ...base, turnId: 1, brainAction: "property_send", staffWriter: "employee", staffMove: { kind: "reply", aix: null } }, // 竹内さんでない
  { ...base, turnId: 2, brainAction: "", staffMove: null },                                                    // 送信なし
];
const hits = prodMissHits(turns);
t("本番の外れ: 竹内さんの番だけ・2択と比べられない番は入れない", JSON.stringify(hits.map((h) => h.ref.turn_id)) === "[8950,8931]");
t("本番の外れ: 鍵は系統の組", hits[0].key === "物件→返信" && hits[1].key === "確認→見積" && hits[0].kind === "prod_miss");
t("系統: 2段・返信の空は返信", moveFamily("") === "返信" && moveFamily(null) === "返信" && moveFamily("cost_explain") === "見積");

const sr = selfReportHits([
  { conversationId: "c-2", at: "2026-11-04T01:00:00Z", mm: ["送った物件の現況", "送った物件の現況", "保証会社の審査の流れ"], mx: ["sentProps"] },
  { at: "2026-11-04T02:00:00Z", mm: [], mx: [] },
]);
t("自己申告: 同じ判断の同じ名前は1回・材料と知識に分ける", sr.filter((h) => h.key === "mm:送った物件の現況").length === 1
  && sr.find((h) => h.key === "mm:保証会社の審査の流れ")?.kind === "knowledge_gap" && sr.find((h) => h.key === "mm:送った物件の現況")?.kind === "material_missing");
t("自己申告: 読めなかった材料は mx: の鍵", sr.some((h) => h.key === "mx:sentProps" && h.kind === "material_missing"));

const er = examRegressionHits({ label: "grp-x", switch: "COMPOSE_TAG_CLOSE_V2,OTHER", at: "2026-11-04T06:55:56Z", worseSure: [{ id: "q053", why: "合格 前 3/4 → 今 0/4" }] });
t("試験の悪化: 鍵はスイッチの最初と問題", er.length === 1 && er[0].key === "COMPOSE_TAG_CLOSE_V2:q053" && er[0].ref.qid === "q053" && er[0].ref.exam_label === "grp-x");

// 弱い所への寄せ（鍵が台帳の鍵の形に収まるか）
const ws = ["prod_miss:物件→返信", "material_missing:mm:送った物件の現況", "knowledge_gap:mm:流れ", "exam_regression:COMPOSE_TAG_CLOSE_V2:q053"].map((s) => { const [k, ...r] = s.split(":"); return weaknessKeyForUnknown(k, r.join(":")); });
t("弱い所: 4つの型とも台帳の鍵の形", ws.every((w) => w && isWeaknessKey(w.key)));
t("弱い所: 本番の外れは系統の組ごと（日本語を英字に）", ws[0]?.key === "prod-miss:property-to-reply" && ws[3]?.key === "exam-regression:compose_tag_close_v2");
t("弱い所: 「今の版:」の印の付いた本番の外れも同じ系統の組に寄せる", weaknessKeyForUnknown("prod_miss", "今の版:確認→見積")?.key === "prod-miss:check-to-estimate");
t("弱い所: 日本語だけの試験の名前も鍵の形に収まる", (() => { const w = weaknessKeyForUnknown("exam_regression", "ブレインの判断の組:q015"); return !!w && isWeaknessKey(w.key) && /^exam-regression:j[0-9a-z]+$/.test(w.key); })());
t("まとめ: 型×鍵で数える", aggregateUnknowns(hits).length === 2);

console.log(`unknowns-intake: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
