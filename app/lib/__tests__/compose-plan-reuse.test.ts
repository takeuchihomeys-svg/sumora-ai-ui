// 設計図を使い回した判断の番でも作るか（app/lib/compose-plan-reuse.ts）
// 実行: npx tsx app/lib/__tests__/compose-plan-reuse.test.ts（全 PASS で exit 0）
import { composePlanGate, composePlanReuseMode, composePlanForWriter } from "../compose-plan-reuse";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const g = composePlanGate;
ok("既定は shadow（=off で止まる）", composePlanReuseMode({}) === "shadow" && composePlanReuseMode({ COMPOSE_PLAN_REUSE: "off" }) === "off" && composePlanReuseMode({ COMPOSE_PLAN_REUSE: " ON " }) === "on" && composePlanReuseMode({ COMPOSE_PLAN_REUSE: "cached" }) === "cached");
ok("新しい判断は今まで通り作る（off でも）", g({ fresh: true, cached: false, hasMeta: true }, "off").ok && g({ fresh: true, cached: false, hasMeta: true }, "off").reused === null);
ok("off の時は使い回さない（今と同じ）", !g({ fresh: true, cached: true, hasMeta: true }, "off").ok && !g({ fresh: false, cached: false, hasMeta: true }, "off").ok);
ok("cached: 同じ番の取り置きだけ使い回す", g({ fresh: true, cached: true, hasMeta: true }, "cached").reused === "cached" && !g({ fresh: false, cached: false, hasMeta: true }, "cached").ok);
ok("on: 前の発言の判断も使い回す（stale の印）", g({ fresh: false, cached: true, hasMeta: true }, "on").reused === "stale" && g({ fresh: false, cached: false, hasMeta: true }, "on").reused === "stale");
ok("判断の meta が無ければ作らない", !g({ fresh: true, cached: false, hasMeta: false }, "on").ok);

ok("shadow: 取り置き・前の発言の判断の番も作る（書き手に渡さないのは route 側）", composePlanReuseMode({ COMPOSE_PLAN_REUSE: "shadow" }) === "shadow" && g({ fresh: true, cached: true, hasMeta: true }, "shadow").reused === "cached" && g({ fresh: false, cached: false, hasMeta: true }, "shadow").reused === "stale");
{
  // 返信の文が1字も変わらない: 書き手に渡す設計図は、shadow の時は今（使い回しの前）と同じ
  const plan = { rows: [1] };
  const fresh = g({ fresh: true, cached: false, hasMeta: true }, "shadow");
  ok("新しい判断の番は作った設計図をそのまま渡す（今と同じ）", composePlanForWriter(plan, fresh, "shadow") === plan);
  for (const c of [{ fresh: true, cached: true }, { fresh: false, cached: false }, { fresh: false, cached: true }]) {
    const sh = g({ ...c, hasMeta: true }, "shadow"), off = g({ ...c, hasMeta: true }, "off");
    ok(`使い回しの番（${JSON.stringify(c)}）: shadow で書き手に渡す物は off の時と同じ null（作るのは印のためだけ）`, sh.ok && composePlanForWriter(plan, sh, "shadow") === null && !off.ok);
  }
  ok("cached・on の時は使い回しの設計図を渡す", composePlanForWriter(plan, g({ fresh: true, cached: true, hasMeta: true }, "cached"), "cached") === plan);
}
console.log(`compose-plan-reuse: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
