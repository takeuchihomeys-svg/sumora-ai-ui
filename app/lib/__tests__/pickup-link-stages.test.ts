// app/lib/__tests__/pickup-link-stages.test.ts — 物件を選んだ理由の連携の段（2026-11-26 作業員A）
//   実行: npx tsx app/lib/__tests__/pickup-link-stages.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PICKUP_LINK_STAGES, pendingMatchedOf, pickupWhyPendingMatchOn, splitPropertyName } from "../pickup-link-stages";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("段は6つ・どの段も決まり・材料・物差しの欄がある", PICKUP_LINK_STAGES.length === 6 && PICKUP_LINK_STAGES.every((s) => s.rule && s.material && s.metric));
t("つなぎ: 送った AIX の物件名に入っている pending だけ（全角空白・表記ゆれを寄せる）", pendingMatchedOf([{ property_name: "アーバン 本町" }, { property_name: "別の物件" }], ["アーバン本町"]).length === 1);
// 2026-11-27: 写し（problems.json）の実物の名前の組（建物名は物件の名前・お客様の情報ではない）
const M = (name: string, room: string | null, sent: string[]) => pendingMatchedOf([{ property_name: name, room_no: room }], sent).length === 1;
t("実物: 建物名だけ × 建物名＋号室 で合う（エグゼ堺筋本町 604 × 604号室）", M("エグゼ堺筋本町", "604", ["エグゼ堺筋本町 604号室"]));
t("実物: 頭の0を寄せる（0405 × 405号室）", M("都島北通りマンション", "0405", ["都島北通りマンション 405号室"]));
t("実物: 括弧の旧名を外す（B-RISE弁天(旧:…) × B-RISE弁天 801号室）", M("B-RISE弁天(旧:ルミエール弁天)", "801", ["B-RISE弁天 801号室"]));
t("実物: AIX 側に号室が無い時は建物名で合う（AIA難波南）", M("AIA難波南", "102", ["AIA難波南"]));
t("実物: 階の帯を外し号室で見る（Vinoプレジオ本町　2-8F 0212 × 同 0212）", M("Vinoプレジオ本町　2-8F", "0212", ["Vinoプレジオ本町　2-8F 0212"]));
t("誤一致なし: 同じ建物の別の号室は合わない（Vinoプレジオ本町 0403 × 204号室）", !M("Vinoプレジオ本町　2-8F", "0403", ["Vinoプレジオ本町 204号室"]));
t("誤一致なし: 号室違い（AIA難波南 102 × 101）", !M("AIA難波南", "102", ["AIA難波南 101"]));
t("誤一致なし: 頭だけ同じ別の建物（ハーモニーテラス歌島Ⅴ × Ⅵ）", !M("ハーモニーテラス歌島Ⅴ", "101", ["ハーモニーテラス歌島Ⅵ 101"]));
t("誤一致なし: 頭だけ同じ別の建物（プレジオ難波Asian × プレジオ難波 0506）", !M("プレジオ難波Asian", "0606", ["プレジオ難波 0506"]));
t("誤一致なし: 番号違いの別の建物（Luxe難波西2 × Luxe難波西3）", !M("Luxe難波西2", null, ["Luxe難波西3 1413"]));
t("分け: 建物名と号室", JSON.stringify(splitPropertyName("ハーモニーテラス歌島Ⅵ 101")) === JSON.stringify({ building: "ハーモニーテラス歌島VI", room: "101" }));
t("既定 off", !pickupWhyPendingMatchOn({}) && pickupWhyPendingMatchOn({ PICKUP_WHY_PENDING_MATCH: "on" }));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ・印 pickup_why_pending", bc.includes("plm.pickupWhyPendingMatchOn()") && bc.includes("materialMarks.pickup_why_pending"));
console.log(`pickup-link-stages: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
