// app/lib/__tests__/sent-property-pick.test.ts — 竹内さん #8・#18
//   実行: npx tsx app/lib/__tests__/sent-property-pick.test.ts
import { viewingVacancyPickOn, aixToolPickOn, vacateDateFromLines, sameAsPreferred } from "../sent-property-pick";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("スイッチ既定 off", !viewingVacancyPickOn(undefined) && viewingVacancyPickOn("on") && !aixToolPickOn("") && aixToolPickOn("on"));
t("退去予定の字をそのまま", vacateDateFromLines(["物件名: ロンド・エーデルワイス", "現況: 退去予定", "退去予定: 2026年11月下旬"]) === "2026年11月下旬");
t("退去予定日の見出しも読む", vacateDateFromLines(["退去予定日：12/10"]) === "12/10");
t("無ければ空", vacateDateFromLines(["現況: 空室"]) === "" && vacateDateFromLines(null) === "");
t("ブレインの物件と同じ建物・同じ号室", sameAsPreferred("ロンド・エーデルワイス", "105", "ロンド・エーデルワイス 105号室"));
t("号室が違えば違う", !sameAsPreferred("ロンド・エーデルワイス", "201", "ロンド・エーデルワイス 105号室"));
t("号室が片方に無ければ同じ建物で寄せる", sameAsPreferred("ロンド・エーデルワイス", null, "ロンド・エーデルワイス 105号室"));
t("別の建物は違う", !sameAsPreferred("シーズンフラッツ心斎橋EAST", "204", "ロンド・エーデルワイス 105号室"));
t("ブレインの物件が無ければ選ばない", !sameAsPreferred("A", null, null));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
