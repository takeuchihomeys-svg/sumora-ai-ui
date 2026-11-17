// この物件で審査に通りそうかの問い → 材料の1行（竹内さんの決定 a0c5ecf0・SCREENING_PROSPECT_GUARANTOR_LINE・既定 off）
// 実行: npx tsx app/lib/__tests__/screening-prospect-guarantor.test.ts
import { screeningProspectTurn, screeningPhoneTurnLine, SCREENING_PROSPECT_GUARANTOR_LINE, screeningProspectGuarantorEnabled } from "../screening-phone-material";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const on = { SCREENING_PROSPECT_GUARANTOR_LINE: "on" };
t("既定 off", !screeningProspectGuarantorEnabled({}) && screeningProspectGuarantorEnabled(on));
// 実物（q333＝10/20 竹内さんの決定の番）
t("q333「ここって私、審査的には通りそうですかね」→ 網に掛かる", screeningProspectTurn("ここって私、審査的には通りそうですかね?！😭"));
t("off は材料に出さない", screeningPhoneTurnLine("ここって私、審査的には通りそうですかね", {}) === "");
t("on は材料の1行", screeningPhoneTurnLine("ここって私、審査的には通りそうですかね", on) === SCREENING_PROSPECT_GUARANTOR_LINE);
// 掛けない（本番の言い方・screening-phone-material の注記の5つ）
t("傷を言った相談（彼氏名義で審査落ちてて）→ 掛けない", !screeningProspectTurn("彼氏との同棲で家探してて、ここ住みたかったんですけど、彼氏名義で審査落ちててここって厳しいですよね？？"));
t("物件の噂（審査厳しいって聞いた）→ 掛けない", !screeningProspectTurn("ここの物件が審査厳しいって聞いたんですけど"));
t("先の話（こっちの審査落ちたら）→ 掛けない", !screeningProspectTurn("こっちの審査落ちたらこっちに行きたい"));
t("探す依頼（前の物件が審査落ち）→ 掛けない", !screeningProspectTurn("前の物件が審査落ちした為新たに物件を紹介してほしい"));
t("通りませんでした → 掛けない", !screeningProspectTurn("1番手の保証会社のところは審査通りませんでした"));
t("審査の期間の問い → 掛けない", !screeningProspectTurn("審査通るまでどのくらいの期間見といたらいいですか？"));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
