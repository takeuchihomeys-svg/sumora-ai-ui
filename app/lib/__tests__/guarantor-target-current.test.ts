// app/lib/__tests__/guarantor-target-current.test.ts — 保証会社について は今話している物件だけ（#29）
import { narrowToCurrentProperty, guarantorTargetCurrentOn } from "../guarantor-target";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const two = ["ALEGRIA尼崎 103号室", "Leaf Maison 大物 0203号室"];
t("既定 off", guarantorTargetCurrentOn({}) === false);
t("ブレインの注目物件が束にあれば1件", JSON.stringify(narrowToCurrentProperty(two, { currentProperty: "Leaf Maison 大物 203号室" }).names) === JSON.stringify(["Leaf Maison 大物 0203号室"]));
t("直近の会話で1件だけ名前が出た", narrowToCurrentProperty(two, { recentTexts: ["①ALEGRIA尼崎 103号室\n②Leaf Maison 大物 0203号室", "Leaf Maison大物の保証会社ってどこですか？"] }).names[0] === "Leaf Maison 大物 0203号室");
t("決まらなければそのまま", narrowToCurrentProperty(two, { recentTexts: ["保証会社はどこですか？"] }).names.length === 2);
t("束を並べた通で止める（その前の名前を拾わない）", narrowToCurrentProperty(two, { recentTexts: ["ALEGRIA尼崎いいですね", "①ALEGRIA尼崎 103号室\n②Leaf Maison 大物 0203号室", "保証会社は？"] }).names.length === 2);
t("号室が違う注目物件は当てない", narrowToCurrentProperty(two, { currentProperty: "Leaf Maison 大物 0505号室" }).names.length === 2);
t("1件ならそのまま", narrowToCurrentProperty(["A棟 101"], { currentProperty: "B" }).names.length === 1);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
