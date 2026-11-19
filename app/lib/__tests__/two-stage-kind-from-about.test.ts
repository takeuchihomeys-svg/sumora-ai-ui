// 2026-11-13 作業員7b: ブレインの約束の about が search_condition なら、AIX の欄が物件確認したでもピックアップの約束（TWO_STAGE_KIND_FROM_ABOUT・既定 off）
//   実物: q367（「以前ご依頼した条件でもう一度探していただけませんでしょうか」・route=promise・about=search_condition）・q009
import { resolveTwoStage } from "../two-stage";
// 2026-11-14 作業員D: BRAIN_AIX_FOLLOWS_CONTRACT（③ を同じく当てる）が既定 on になったので、この試験は古いスイッチだけを見るため off にしておく
process.env.BRAIN_AIX_FOLLOWS_CONTRACT = "off";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const base = { decisionSource: "llm", pickupReady: false, postApply: false, finalAix: "property_check_result", askAbout: "search_condition", customerText: "以前ご依頼した条件でもう一度探していただけませんでしょうか" };
const run = (env: string | undefined, extra: Record<string, unknown> = {}) => { if (env === undefined) delete process.env.TWO_STAGE_KIND_FROM_ABOUT; else process.env.TWO_STAGE_KIND_FROM_ABOUT = env; return resolveTwoStage({ ...base, ...extra } as Parameters<typeof resolveTwoStage>[0]); };
t("既定 off は今まで通り確認の約束", run(undefined)?.kind === "check");
delete process.env.BRAIN_AIX_FOLLOWS_CONTRACT;
t("BRAIN_AIX_FOLLOWS_CONTRACT が既定 on（11/14）なので、古いスイッチが無くても探す約束（pickup）", run(undefined)?.kind === "pickup");
process.env.BRAIN_AIX_FOLLOWS_CONTRACT = "off";
const on = run("on");
t("on: 探す約束（pickup）", on?.kind === "pickup" && on.source === "rule:two_stage_promise(pickup)" && /ピックアップ/.test(on.direction));
t("on でも about が空き（vacancy）なら確認の約束", run("on", { askAbout: "vacancy", customerText: "まだ空いてますか？" })?.kind === "check");
t("on でも費用も聞いた番は今まで通り", run("on", { asksCost: true })?.kind === "check");
t("on でも持ち込みの番は今まで通り", run("on", { brought: { ask: "vacancy", count: 1 } })?.kind !== "pickup");
// 配線: brain-core が resolveTwoStage にブレインの turn_contract の先の依頼の about を渡している
const bc = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "brain-core.ts"), "utf8") as string;
t("配線: brain-core の askAbout（turn_contract の先の依頼の about）", bc.includes("askAbout: (() => {") && bc.includes("return lead?.about ?? null;"));
delete process.env.TWO_STAGE_KIND_FROM_ABOUT; delete process.env.BRAIN_AIX_FOLLOWS_CONTRACT;
console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
