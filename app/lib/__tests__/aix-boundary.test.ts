// app/lib/__tests__/aix-boundary.test.ts — AIX と返信の境目の表（2026-11-26 作業員A・#688）
//   実行: npx tsx app/lib/__tests__/aix-boundary.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIX_BOUNDARIES, boundariesFor, aixBoundaryLine, aixBoundaryLineOn } from "../aix-boundary";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("表: 確認の約束の4つ・探す約束の後のお礼2つ・一般の説明1つ", AIX_BOUNDARIES.length === 7 && AIX_BOUNDARIES.every((b) => b.source && b.when && b.take));
t("確認の約束の後のお礼だけ → 物件確認した の境目", boundariesFor({ checkScene: "ack_wait", pickupScene: null, customerAsked: false }).map((b) => b.id).join() === "check_ack_wait");
t("探す約束の後のお礼・候補あり／なし", boundariesFor({ checkScene: null, pickupScene: "ack_ready", customerAsked: false })[0]?.id === "pickup_ack_ready" && boundariesFor({ checkScene: null, pickupScene: "ack_not_ready", customerAsked: false })[0]?.id === "pickup_ack_not_ready");
t("約束の場面が無い問いだけ → 一般の説明は返信", boundariesFor({ checkScene: null, pickupScene: null, customerAsked: true })[0]?.id === "general_explain");
t("場面が無くお礼だけ → 何も出さない", aixBoundaryLine(boundariesFor({ checkScene: null, pickupScene: null, customerAsked: false })) === "");
t("1行: 竹内さんの決め・決めるのはあなた", aixBoundaryLine(boundariesFor({ checkScene: "ack_wait", pickupScene: null, customerAsked: false })).includes("決めるのはあなた"));
t("既定 off", !aixBoundaryLineOn({}) && aixBoundaryLineOn({ AIX_BOUNDARY_LINE: "on" }));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ・控えの行に登録", bc.includes("ab.aixBoundaryLineOn() && !isPostApplyStatus(convStatus)") && bc.includes('key: "aix_boundary"') && bc.includes("materialMarks.aix_boundary"));
console.log(`aix-boundary: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
