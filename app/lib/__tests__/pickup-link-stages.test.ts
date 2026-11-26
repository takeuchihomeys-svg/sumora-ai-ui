// app/lib/__tests__/pickup-link-stages.test.ts — 物件を選んだ理由の連携の段（2026-11-26 作業員A）
//   実行: npx tsx app/lib/__tests__/pickup-link-stages.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PICKUP_LINK_STAGES, pendingMatchedOf, pickupWhyPendingMatchOn } from "../pickup-link-stages";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("段は6つ・どの段も決まり・材料・物差しの欄がある", PICKUP_LINK_STAGES.length === 6 && PICKUP_LINK_STAGES.every((s) => s.rule && s.material && s.metric));
t("つなぎ: 送った AIX の物件名に入っている pending だけ（全角空白・表記ゆれを寄せる）", pendingMatchedOf([{ property_name: "アーバン 本町" }, { property_name: "別の物件" }], ["アーバン本町"]).length === 1);
t("既定 off", !pickupWhyPendingMatchOn({}) && pickupWhyPendingMatchOn({ PICKUP_WHY_PENDING_MATCH: "on" }));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ・印 pickup_why_pending", bc.includes("plm.pickupWhyPendingMatchOn()") && bc.includes("materialMarks.pickup_why_pending"));
console.log(`pickup-link-stages: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
