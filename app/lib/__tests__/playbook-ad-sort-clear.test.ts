/**
 * 手順書に AD 並べ替え（①並べ替え→②AD→③高→低→④PDF）がわかりやすく載るか
 * npx tsx app/lib/__tests__/playbook-ad-sort-clear.test.ts
 */
import {
  PLAYBOOK_BUILD_V,
  PLAYBOOK_FLOW_SERIES,
  PLAYBOOK_LIST_AD_SORT_STEPS,
  PLAYBOOK_MAX_STEPS,
  buildPlaybook,
} from "../action-playbook";
import { AUTO_RULES } from "../auto-procedure-rules";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(PLAYBOOK_BUILD_V >= 8, "build_v >= 8");
assert(PLAYBOOK_LIST_AD_SORT_STEPS.length === 4, "4 AD steps");
assert(PLAYBOOK_LIST_AD_SORT_STEPS[0].includes("並べ替え"), "step1");
assert(PLAYBOOK_LIST_AD_SORT_STEPS[1].includes("AD"), "step2");
assert(PLAYBOOK_LIST_AD_SORT_STEPS[2].includes("高→低"), "step3");
assert(PLAYBOOK_LIST_AD_SORT_STEPS[3].includes("印刷用PDF"), "step4");

const sortAd = PLAYBOOK_FLOW_SERIES.find((p) => p.id === "sort_ad");
assert(!!sortAd, "flow has sort_ad");
assert(/①並べ替え→②AD→③高→低/.test(String(sortAd?.label || "")), "sort_ad label clear");

const after = PLAYBOOK_FLOW_SERIES.find((p) => p.id === "after_search");
assert(!!after && after.next === "sort_ad", "after_search → sort_ad");

const adRule = AUTO_RULES.find((r) => r.id === "ad_sort_hover");
assert(!!adRule, "ad_sort_hover rule");
assert(/①/.test(String(adRule?.text)) && /②/.test(String(adRule?.text)) && /③/.test(String(adRule?.text)), "rule numbered");
assert(/検索把握/.test(String(adRule?.text)) && /物件取得の前/.test(String(adRule?.text)), "rule places in flow");

const pb = buildPlaybook({
  generated_at: new Date().toISOString(),
  scene_flows: [
    { scene: "list", runs: 5, ops: 5, steps: ["印刷用PDF🧠88通す", "印刷用PDF"], variants: 1 },
    { scene: "search", runs: 5, ops: 2, steps: ["検索"], variants: 1 },
  ],
  points: { "左の高→低｜span.sort_detail": { x: 0.15, y: 0.47, n: 5 } },
  opens: {},
  next: {},
});
assert(pb.build_v >= 8, "pb build");
const list = pb.scenes.find((s) => s.scene === "list");
assert(!!list, "list scene");
assert(list!.steps.some((t) => /①並べ替え/.test(t)), "list has ①");
assert(list!.steps.some((t) => /②.*AD/.test(t)), "list has ②AD");
assert(list!.steps.some((t) => /③.*高→低/.test(t)), "list has ③");
assert(list!.steps.length <= PLAYBOOK_MAX_STEPS, "within max");
assert(list!.rules.includes("ad_sort_hover"), "list rules ad_sort_hover");
assert(pb.rules.some((r) => r.id === "ad_sort_hover"), "playbook rules include ad_sort");
assert(pb.flow_series.some((p) => p.id === "sort_ad"), "flow_series sort_ad");

// 長い list でも上限を守る
const long = buildPlaybook({
  scene_flows: [{ scene: "list", runs: 4, ops: 30, steps: Array.from({ length: 40 }, (_, i) => `s${i}`), variants: 1 }],
});
assert(long.scenes[0].steps.length === PLAYBOOK_MAX_STEPS, "long list capped");
assert(long.scenes[0].steps[0].includes("①並べ替え"), "AD guide stays first");

console.log("playbook-ad-sort-clear.test OK");
