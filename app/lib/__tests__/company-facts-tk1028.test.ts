// app/lib/__tests__/company-facts-tk1028.test.ts — 竹内さんの実送信から取った会社の事実3つ（COMPANY_FACT_TK1028）
import { matchCompanyFacts } from "../company-facts";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const IDS = ["second_place_apply", "vacating_move_in", "estimate_all_inclusive"];
const ids = (s: string) => matchCompanyFacts(s).map((f) => f.id).filter((i) => IDS.includes(i));
const on = <T,>(f: () => T): T => f(); // 既定 on
const off = <T,>(f: () => T): T => { process.env.COMPANY_FACT_TK1028 = "off"; try { return f(); } finally { delete process.env.COMPANY_FACT_TK1028; } };
t("off は渡さない", off(() => ids("2番手ってどういうことですか？")).length === 0);
t("既定は渡す", ids("2番手ってどういうことですか？").length === 1);
t("2番手の問い", JSON.stringify(on(() => ids("2番手ってどういうことですか？"))) === JSON.stringify(["second_place_apply"]));
t("繰り上がり", on(() => ids("繰り上がる可能性ってありますか？")).includes("second_place_apply"));
t("退去予定の部屋はいつ住めるか", on(() => ids("退去予定ってことはいつから住めますか？")).includes("vacating_move_in"));
t("自分の退去の話には出さない", !on(() => ids("今の家の退去っていつ言えばいいですか？")).includes("vacating_move_in"));
t("他社の金額との比べ", on(() => ids("他社さんだと初期費用10万以内って言われたんですけど")).includes("estimate_all_inclusive"));
t("初期費用はこれで全部か", on(() => ids("初期費用はこれで全部込みですか？")).includes("estimate_all_inclusive"));
t("画像の書き起こしには出さない", on(() => ids("[画像] 2番手 申込")).length === 0);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
