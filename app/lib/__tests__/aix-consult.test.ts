// app/lib/__tests__/aix-consult.test.ts — 逆向きの相談（2026-11-03）
//   実行: npx tsx app/lib/__tests__/aix-consult.test.ts
import { aixDeskConsultMode, consultTriggers, consultCandidates, parseConsultAnswer, AIX_CONSULT_SYSTEM } from "../aix-commander";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, v?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(v)); } };
t("既定は off", aixDeskConsultMode({}) === "off" && aixDeskConsultMode({ AIX_DESK_CONSULT: "shadow" }) === "shadow");
t("お礼だけは相談しない", consultTriggers({ contractAsksAixOrPromise: false, sceneUncertain: true, noGround: false, turnText: "ありがとうございます！" }).length === 0);
t("空きの質問は相談", consultTriggers({ contractAsksAixOrPromise: false, sceneUncertain: false, noGround: false, turnText: "ここまだ空いてますか？" }).includes("staff_only_cue"));
t("本質に AIX の依頼", consultTriggers({ contractAsksAixOrPromise: true, sceneUncertain: false, noGround: false, turnText: "了解です" })[0] === "contract_aix");
t("根拠なし", consultTriggers({ contractAsksAixOrPromise: false, sceneUncertain: false, noGround: true, turnText: "了解" }).includes("no_ground"));
const keys = ["property_check_result/available", "estimate_sheet/single", "meeting_place", "viewing_invite/通常"];
const c = consultCandidates(["property_check_result"], keys);
t("候補: 場面のボタン＋組の相手", c[0] === "property_check_result/available" && c.includes("estimate_sheet/single"), c);
t("答え: 鍵", parseConsultAnswer({ answer: "estimate_sheet/single" }, c).answer === "aix");
t("答え: promise", parseConsultAnswer({ answer: "promise" }, c).answer === "promise");
t("答え: 候補に無い物は keep", parseConsultAnswer({ answer: "phone_call" }, c).answer === "keep");
t("system: 迷う時は keep", AIX_CONSULT_SYSTEM.includes("迷う時は keep"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
