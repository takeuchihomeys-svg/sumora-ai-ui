// 設計図を使い回した判断の番でも作るか（app/lib/compose-plan-reuse.ts）
// 実行: npx tsx app/lib/__tests__/compose-plan-reuse.test.ts（全 PASS で exit 0）
import { composePlanGate, composePlanReuseMode } from "../compose-plan-reuse";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const g = composePlanGate;
ok("既定は off", composePlanReuseMode({}) === "off" && composePlanReuseMode({ COMPOSE_PLAN_REUSE: " ON " }) === "on" && composePlanReuseMode({ COMPOSE_PLAN_REUSE: "cached" }) === "cached");
ok("新しい判断は今まで通り作る（off でも）", g({ fresh: true, cached: false, hasMeta: true }, "off").ok && g({ fresh: true, cached: false, hasMeta: true }, "off").reused === null);
ok("off の時は使い回さない（今と同じ）", !g({ fresh: true, cached: true, hasMeta: true }, "off").ok && !g({ fresh: false, cached: false, hasMeta: true }, "off").ok);
ok("cached: 同じ番の取り置きだけ使い回す", g({ fresh: true, cached: true, hasMeta: true }, "cached").reused === "cached" && !g({ fresh: false, cached: false, hasMeta: true }, "cached").ok);
ok("on: 前の発言の判断も使い回す（stale の印）", g({ fresh: false, cached: true, hasMeta: true }, "on").reused === "stale" && g({ fresh: false, cached: false, hasMeta: true }, "on").reused === "stale");
ok("判断の meta が無ければ作らない", !g({ fresh: true, cached: false, hasMeta: false }, "on").ok);

ok("shadow: 取り置き・前の発言の判断の番も作る（書き手に渡さないのは route 側）", composePlanReuseMode({ COMPOSE_PLAN_REUSE: "shadow" }) === "shadow" && g({ fresh: true, cached: true, hasMeta: true }, "shadow").reused === "cached" && g({ fresh: false, cached: false, hasMeta: true }, "shadow").reused === "stale");
console.log(`compose-plan-reuse: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
