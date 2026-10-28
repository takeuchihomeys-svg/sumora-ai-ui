// app/lib/__tests__/equip-burner3.test.ts — コンロ3口を2口以上と別の希望に（ロト #9・EQUIP_BURNER3）
import { parseEquipmentWants, readEquipmentItemsFromText, equipBurner3On } from "../listing-equipment";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const withEnv = <T,>(v: string | undefined, f: () => T): T => { const o = process.env.EQUIP_BURNER3; if (v === undefined) delete process.env.EQUIP_BURNER3; else process.env.EQUIP_BURNER3 = v; try { return f(); } finally { if (o === undefined) delete process.env.EQUIP_BURNER3; else process.env.EQUIP_BURNER3 = o; } };
const pc = { preferences: "独立洗面台・浴室トイレ別・エアコン付き・ペット相談可・三口ガスコンロ・カウンターキッチン[希望]" };
const keysOff = withEnv("off", () => parseEquipmentWants(pc as never).wants.map((w) => w.key));
const keysOn = withEnv(undefined, () => parseEquipmentWants(pc as never).wants.map((w) => w.key));
t("既定 on・off で止まる", equipBurner3On({}) === true && equipBurner3On({ EQUIP_BURNER3: "off" }) === false);
t("off: 今まで通り burner2", keysOff.includes("burner2") && !keysOff.includes("burner3"), keysOff);
t("on: burner3 だけ（2口以上にしない）", keysOn.includes("burner3") && !keysOn.includes("burner2"), keysOn);
t("on: 2口の希望は burner2 のまま", withEnv(undefined, () => parseEquipmentWants({ preferences: "2口コンロ" } as never).wants.map((w) => w.key)).includes("burner2"));
t("資料の文字 3口 → ok", readEquipmentItemsFromText("システムキッチン（3口ガスコンロ）").burner3.status === "ok");
t("資料の文字 2口 → ng", readEquipmentItemsFromText("2口ガスコンロ・グリル付").burner3.status === "ng");
t("資料に口数なし → 記載なし（点にしない）", readEquipmentItemsFromText("ガスコンロ設置可").burner3.status === "unlisted");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
