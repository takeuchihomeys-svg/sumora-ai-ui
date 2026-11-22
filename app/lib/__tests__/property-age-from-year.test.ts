// 物件の資料の築年を年から数える（2026-11-21 作業員G・#447・PROPERTY_AGE_FROM_YEAR・既定 off）
// 実行: npx tsx app/lib/__tests__/property-age-from-year.test.ts
import { ageFromBuiltYear, propertyAgeFromYearOn, factsFromPropertyText } from "../customer-sent-property";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const now = new Date("2026-11-21T03:00:00+09:00");
t("既定 off", !propertyAgeFromYearOn({}) && propertyAgeFromYearOn({ PROPERTY_AGE_FROM_YEAR: "on" }));
// 実物の形（60日の物件の資料の画像の行・物件名なし）
t("築年:2015年03月 → 11", ageFromBuiltYear("建築構造:鉄筋コンクリート造 地上14階\n築年:2015年03月", now) === 11);
t("【築年】1995年04月 → 31", ageFromBuiltYear("【築年】1995年04月", now) === 31);
t("竣工:1994年10月 → 32", ageFromBuiltYear("竣工:1994年10月", now) === 32);
t("築年月 2023年10月 → 3", ageFromBuiltYear("築年月 2023年10月", now) === 3);
t("築年数:2019年4月 → 7", ageFromBuiltYear("築年数:2019年4月", now) === 7);
t("2023年築 → 3", ageFromBuiltYear("・2023年築", now) === 3);
t("今の月より後の月は1引く（2024年12月 → 1）", ageFromBuiltYear("築年:2024年12月", now) === 1);
t("建つ前（2027年築）→ 0", ageFromBuiltYear("2027年築", now) === 0);
t("読み違い（2139年）は取らない", ageFromBuiltYear("【築年】2139年(10月)", now) === null);
t("年の無い「築年月」だけは取らない", ageFromBuiltYear("築年月", now) === null);
process.env.PROPERTY_AGE_FROM_YEAR = "on";
t("on: factsFromPropertyText が年から築年数を入れる", factsFromPropertyText("賃料 7.2万円 1K 25.5m2\n築年:2015年03月").ageYears != null);
t("on: 「築12年」の形は今まで通り", factsFromPropertyText("7.2万円 1K 築12年").ageYears === 12);
process.env.PROPERTY_AGE_FROM_YEAR = "off";
t("off: 年の形は今まで通り取らない", factsFromPropertyText("賃料 7.2万円 1K 25.5m2\n築年:2015年03月").ageYears === null);
delete process.env.PROPERTY_AGE_FROM_YEAR;
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
