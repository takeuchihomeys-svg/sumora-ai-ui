// app/lib/__tests__/conductor-turn-vectors.test.ts — 近い過去の番の表の1行（状況の文・一手・当たり・書き手）
//   実行: npx tsx app/lib/__tests__/conductor-turn-vectors.test.ts
import { turnSituationText, actualOf, hitsOf, turnVectorRow, conductorTurnVectorsOn, APPLY_DOCS_RE, SITUATION_CUSTOMER_MAX } from "../conductor-turn-vectors";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const s = turnSituationText({ scene: "AIX:property_check_result", stage: "proposing", customerMasked: "あ".repeat(300), lastStaffKind: "AIX:property_send" });
t("状況の文: 場面・段階・直前のこちら・お客様（120字まで）", s.startsWith("場面: AIX:property_check_result\n段階: proposing\n直前のこちら: AIX:property_send\nお客様: ") && s.split("お客様: ")[1].length === SITUATION_CUSTOMER_MAX);
t("無い物は「不明」「なし」", turnSituationText({ scene: null, stage: null, customerMasked: "x", lastStaffKind: null }).includes("場面: 不明") && turnSituationText({ scene: null, stage: null, customerMasked: "x", lastStaffKind: null }).includes("直前のこちら: なし"));
t("一手: AIX は種類とピッカー・返信は route だけ", JSON.stringify(actualOf({ isAix: true, aixType: "property_check_result", checkPattern: "available" })) === JSON.stringify({ route: "aix", aix: "property_check_result", picker: "available" }) && actualOf({ isAix: false, aixType: null, checkPattern: null }).route === "reply");
const a = actualOf({ isAix: true, aixType: "estimate_sheet", checkPattern: null });
t("当たり: 見張りの番が無ければ空・道と種類", Object.keys(hitsOf(a, null)).length === 0 && hitsOf(a, { brainMode: "aix", brainAction: "estimate_sheet" }).aix === true && hitsOf(a, { brainMode: "auto_reply", brainAction: "" }).judge === false);
const r = turnVectorRow({ sendId: "m1", conversationId: "c1", propertyCustomerId: null, scene: null, stage: null, customerMasked: "x", lastStaffKind: null, fp: [], actual: a, hits: {}, writer: "takeuchi", turnAt: "2026-11-01T00:00:00Z" });
t("行: source_key は msg:<送信の id>・書き手は takeuchi/employee/unknown", r.source_key === "msg:m1" && r.source === "messages" && r.writer === "takeuchi" && turnVectorRow({ ...{ sendId: "m2", conversationId: "c", propertyCustomerId: null, scene: null, stage: null, customerMasked: "x", lastStaffKind: null, fp: [], actual: a, hits: {}, turnAt: "x" }, writer: null }).writer === "unknown");
t("申込の書類の手前まで（免許証・申込書 等の番は入れない）", APPLY_DOCS_RE.test("免許証の写真送ります") && APPLY_DOCS_RE.test("申込書") && !APPLY_DOCS_RE.test("内覧したいです"));
t("2026-11-04 既定 on・=off で止まる", conductorTurnVectorsOn({}) === true && conductorTurnVectorsOn({ CONDUCTOR_TURN_VECTORS: "off" }) === false);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
