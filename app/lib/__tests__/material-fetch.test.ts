// app/lib/__tests__/material-fetch.test.ts — 足りない事実を取りに行く段（S4）の表（実行: npx tsx app/lib/__tests__/material-fetch.test.ts）
//   実物: 見張り 12548（11/08 床の色・他の号室）・12838（11/09「オートロック有無の資料」「管理費込10万円内の新規候補」）・12643（11/09「シェモワアサヒの初期費用」「…の現況・募集状況」）
import { fetchSourceOf, materialFetchPlan, pickDocLines, fetchedMaterialText, materialFetchDigest, materialFetchOn } from "../material-fetch";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d = "") => { if (ok) pass++; else { fail++; console.log(`NG ${n} ${d}`); } };

t("既定 off", !materialFetchOn({}) && materialFetchOn({ BRAIN_MATERIAL_FETCH: "on" }));
// 取り先の表
t("12548 床の色＝物件の資料", fetchSourceOf("床の色（資料）") === "property_doc");
t("12548 他の号室の資料＝物件の資料", fetchSourceOf("他の号室の資料（間取り・家賃）") === "property_doc");
t("他の号室の空き（募集状況）はスタッフだけ", fetchSourceOf("他の号室の空き") === null);
t("12838 オートロック有無の資料＝物件の資料", fetchSourceOf("オートロック有無の資料") === "property_doc");
t("12838 管理費込10万円内の新規候補＝送れる候補", fetchSourceOf("管理費込10万円内の新規候補") === "pickup_ready");
t("12643 初期費用＝送った御見積書", fetchSourceOf("シェモワアサヒの初期費用") === "estimate_sheet");
t("12643 現況・募集状況＝スタッフだけ（管理会社の結果）", fetchSourceOf("シェモワアサヒの現況・募集状況") === null);
t("代表の割引可否＝スタッフだけ", fetchSourceOf("代表の割引可否") === null);
t("会社の方針＝会社の事実", fetchSourceOf("入居時期から逆算した探し始めの時期(会社の方針)") === "company_facts");
// 資料の行を拾う
const rows = [
  { property_name: "ルミエール", room_no: "301", lines: ["床: ダークブラウンのフローリング", "設備: オートロック・宅配BOX"] },
  { property_name: "ルミエール", room_no: "502", lines: ["床: ホワイト系"] },
];
const pFloor = materialFetchPlan(["床の色（資料）"])[0];
t("床の色の行を拾う", pickDocLines(rows, pFloor).length === 2 && pickDocLines(rows, pFloor)[0].includes("ダークブラウン"), JSON.stringify(pickDocLines(rows, pFloor)));
const pRooms = materialFetchPlan(["他の号室の資料（間取り・家賃）"])[0];
t("他の号室＝同じ物件の号室の一覧", pickDocLines(rows, pRooms)[0] === "ルミエール: 資料のある号室 301・502", JSON.stringify(pickDocLines(rows, pRooms)));
const pLock = materialFetchPlan(["オートロック有無の資料"])[0];
t("オートロックの行", pickDocLines(rows, pLock).length === 1 && pickDocLines(rows, pLock)[0].includes("オートロック"));
// 渡す事実の欄と記録
const res = [
  { label: "床の色（資料）", source: "property_doc" as const, facts: ["ルミエール 301: 床: ダークブラウンのフローリング"] },
  { label: "シェモワアサヒの現況・募集状況", source: null, facts: [] },
  { label: "管理費込10万円内の新規候補", source: "pickup_ready" as const, facts: [] },
];
const txt = fetchedMaterialText(res);
t("取れた物だけを事実の欄に", !!txt && txt.includes("ダークブラウン") && !txt.includes("募集状況"), String(txt));
t("記録: 取れた／取り先はあるが無い／スタッフだけ", JSON.stringify(materialFetchDigest(res)) === JSON.stringify(["床の色（資料）|property_doc|got", "シェモワアサヒの現況・募集状況|-|staff", "管理費込10万円内の新規候補|pickup_ready|none"]), JSON.stringify(materialFetchDigest(res)));
t("何も取れなければ事実の欄は無い", fetchedMaterialText([{ label: "x", source: null, facts: [] }]) === null);
t("同じ名前は1つ・6つまで", materialFetchPlan(["a床", "a床", "b床", "c床", "d床", "e床", "f床", "g床"]).length === 6);
console.log(`material-fetch: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
