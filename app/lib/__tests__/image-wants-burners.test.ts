// app/lib/__tests__/image-wants-burners.test.ts — 「三口ガスコンロ」を画像で確かめたい希望に出す（ロト #9・IMAGE_WANT_BURNERS）
import { extractImageWants, imageAnalysisNeed, burnersLabel } from "../image-wants";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const withEnv = <T>(v: string | undefined, f: () => T): T => { const o = process.env.IMAGE_WANT_BURNERS; if (v === undefined) delete process.env.IMAGE_WANT_BURNERS; else process.env.IMAGE_WANT_BURNERS = v; try { return f(); } finally { if (o === undefined) delete process.env.IMAGE_WANT_BURNERS; else process.env.IMAGE_WANT_BURNERS = o; } };
const pref = "独立洗面台・浴室トイレ別・エアコン付き・ペット相談可・三口ガスコンロ・カウンターキッチン・カウンターキッチン[希望]";
const wants = extractImageWants({ conditions: { preferences: pref } } as never);
const off = withEnv(undefined, () => imageAnalysisNeed(wants));
const on = withEnv("on", () => imageAnalysisNeed(wants));
t("既定 off: 今まで通り（コンロは出ない）", !off.labels.some((l) => /コンロ/.test(l)), off);
t("on: ガスコンロ3口が出る", on.labels.includes("ガスコンロ3口"), on);
t("ラベル", burnersLabel("三口ガスコンロ") === "ガスコンロ3口" && burnersLabel("2口コンロ希望") === "コンロ2口");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
