// app/lib/__tests__/concern-subtopic.test.ts — 懸念の2段（実行: npx tsx app/lib/__tests__/concern-subtopic.test.ts）
//   文は本番の LINE にある形（個人情報なし）: 鍵交換の費用・日割・礼金の質問、エアコン・カウンターキッチン・床の色の質問、号室の違い
import { concernSub, roomsIn, concernDetail, concernSubtopicOn } from "../concern-subtopic";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d = "") => { if (ok) pass++; else { fail++; console.log(`NG ${n} ${d}`); } };

t("既定 off", !concernSubtopicOn({}) && concernSubtopicOn({ BRAIN_CONCERN_SUBTOPIC: "on" }));
t("費用→鍵交換", concernSub("費用", "鍵交換代っていくらかかりますか？") === "鍵交換");
t("費用→日割", concernSub("費用", "日割り家賃は入りますか") === "日割家賃");
t("費用→礼金", concernSub("費用", "礼金なしにできますか") === "礼金");
t("費用→総額（項目が無い時）", concernSub("費用", "初期費用どれくらいですか") === "総額");
t("設備→エアコン（11932 の形）", concernSub("設備", "コーポ加島の部屋にはエアコンは付いておりますでしょうか？") === "エアコン");
t("設備→キッチン", concernSub("設備", "カウンターキッチンですか？") === "キッチン");
t("設備→床・内装", concernSub("設備", "床の色は何色ですか") === "床・内装");
t("費用・設備以外は下の段なし", concernSub("階数", "3階以上がいい") === null);
t("号室を拾う（全角も）", JSON.stringify(roomsIn("掲載は203号室で、見積は２０５号室になってます")) === JSON.stringify(["203", "205"]));
const d = concernDetail({ topic: "費用", object: "205号室の礼金" }, "203号室の掲載と見積の号室が違います", { listedRoom: "203", estimateRoom: "205号室" });
t("号室の違い（掲載 203・見積 205）", !!d && d.roomMismatch?.listed === "203" && d.roomMismatch?.estimate === "205" && d.sub === "礼金", JSON.stringify(d));
t("同じ号室なら違いは無い", concernDetail({ topic: "費用", object: "礼金" }, "", { listedRoom: "203", estimateRoom: "203" })?.roomMismatch === null);
t("懸念が無ければ null", concernDetail(null, "x") === null);
console.log(`concern-subtopic: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
