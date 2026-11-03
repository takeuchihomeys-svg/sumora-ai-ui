// app/lib/__tests__/aix-first-blueprint.test.ts — AIX の1通目の設計図の骨組み（純関数・札は作り物）
import { aixFirstBlueprintOn, readDeskCard, aixFirstIntent, aixFirstBlueprint } from "../aix-first-blueprint";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const card = "■担当 property_check_result/available｜物件確認した → 物件あった\n送る中身（スタッフだけが知る事）: 管理会社に確認した募集中の結果\n使う場面: 確認の約束の後\n似たボタンとの線: 結果がまだ無い時は確認の約束の返信\n目的: 内覧へつなぐ";
t("既定 off", !aixFirstBlueprintOn({}) && aixFirstBlueprintOn({ AIX_FIRST_BLUEPRINT: "on" }));
const c = readDeskCard(card);
t("札を読む", c.sends === "管理会社に確認した募集中の結果" && c.purpose === "内覧へつなぐ" && /確認の約束/.test(c.line ?? ""), c);
const it = aixFirstIntent({ key: "property_check_result/available", cardText: card });
t("意図（案内・物件が主語・送る中身がメイン）", it.purpose === "inform" && it.main.subject === "property" && it.main.what === c.sends, it);
const bp = aixFirstBlueprint({ key: "property_check_result/available", cardText: card, hasFixedBlock: true });
t("定型の塊はメインの後ろの材料", bp.parts.some((p) => p.from === "material") && bp.parts.findIndex((p) => p.from === "material") > bp.parts.findIndex((p) => p.role === "main"), bp.parts);
t("似たボタンとの線を見張りに", bp.check.issues.some((x) => x.startsWith("似たボタンとの線")));
t("知らないボタンでも作れる", aixFirstIntent({ key: "unknown/x" }).confidence === "low");
console.log(`aix-first-blueprint: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
