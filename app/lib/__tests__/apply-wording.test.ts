// app/lib/__tests__/apply-wording.test.ts — 申込へ はお客様の言い方に合わせる（陽菜 #21）
import { applyPushWordingLine, applyWording1028On } from "../aix-brain-contract";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("既定 off", applyWording1028On({}) === false);
const a = applyPushWordingLine(["こちらで審査かけたいです！"]);
t("審査 → 審査かけさせて頂きます", /お申込し審査かけさせて頂きます/.test(a) && /お部屋お申込し審査かけさせて頂きます/.test(a), a);
t("抑えたい → お部屋抑えさせて頂きます", /お申込しお部屋抑えさせて頂きます/.test(applyPushWordingLine(["とりあえず抑えたいです"])));
t("言い方が無ければ空", applyPushWordingLine(["お願いします"]) === "");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
