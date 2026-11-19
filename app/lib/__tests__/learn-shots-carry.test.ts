// 2026-11-19 タクヤ audit #1513（learn_warm screen=0）: 本番の作り直しが shots.learned を落とす穴。DB も LLM も使わない。
// 実行: npx tsx app/lib/__tests__/learn-shots-carry.test.ts
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { carryLearnedShots, countLearnedPositions } from "../learn-shots-carry";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

type Row = { id: number; scope: string; learned?: unknown; learned_scene?: unknown };
function fakeSb(rows: Row[], counter: { rowReads: number; scopesAsked: string[] }) {
  return {
    from() {
      const st: { cols: string; eq: Record<string, unknown>; limit: number } = { cols: "", eq: {}, limit: 1000 };
      const api = {
        select(c: string) { st.cols = c; return api; },
        eq(k: string, v: unknown) { st.eq[k] = v; return api; },
        order() { return api; },
        limit(n: number) {
          st.limit = n;
          if (st.cols === "id") {
            counter.scopesAsked.push(String(st.eq.scope));
            const data = rows.filter((r) => r.scope === st.eq.scope).sort((a, b) => b.id - a.id).slice(0, n).map((r) => ({ id: r.id }));
            return Promise.resolve({ data, error: null });
          }
          counter.rowReads++;
          const r = rows.find((x) => x.id === st.eq.id);
          return Promise.resolve({ data: r ? [{ learned: r.learned ?? null, learned_scene: r.learned_scene ?? null }] : [], error: null });
        },
      };
      return api;
    },
  } as unknown as SupabaseClient;
}

(async () => {
  const L = { form: [{ name: "賃料", kind: "select", n: 5, x: 0.4, y: 0.3 }, { name: "区", kind: "check", n: 1, x: 0.2, y: 0.5 }, { name: "x無し", kind: "btn", n: 9 }] };
  ok("数え方: x,y がある物だけ・n≥3 が solid", JSON.stringify(countLearnedPositions(L)) === JSON.stringify({ positions: 2, solid: 1 }));

  // #2413〜#2420 の形: 新しい束は total/with_ops だけ・同じ scope の直前（#2410）に learned
  const rows: Row[] = [
    { id: 2414, scope: "realpro" }, { id: 2413, scope: "realpro" },
    { id: 2412, scope: "all", learned: { form: [{ name: "all側", kind: "x", n: 9, x: 0.9, y: 0.9 }] } },
    { id: 2410, scope: "realpro", learned: L, learned_scene: { station: [{ name: "駅", kind: "check", n: 3, x: 0.1, y: 0.1 }] } },
  ];
  let c = { rowReads: 0, scopesAsked: [] as string[] };
  const b: Record<string, unknown> = { shots: { total: 10, with_ops: 8 } };
  const r = await carryLearnedShots(fakeSb(rows, c), "realpro", b);
  const shots = b.shots as Record<string, unknown>;
  ok("同じ scope の直近の learned を継ぐ（#2410）", r.carried && r.from_id === 2410 && JSON.stringify(shots.learned) === JSON.stringify(L), JSON.stringify(r));
  ok("learned_scene も継ぐ", !!shots.learned_scene);
  ok("元の total / with_ops は残す", shots.total === 10 && shots.with_ops === 8);
  ok("束の一番上に screen_solid / screen_positions", b.screen_solid === 1 && b.screen_positions === 2);
  ok("別の scope（all）は聞かない・混ぜない", c.scopesAsked.every((s) => s === "realpro") && !JSON.stringify(shots.learned).includes("all側"));

  // 自前の learned がある時は継がない（DB を読まない）
  c = { rowReads: 0, scopesAsked: [] };
  const own: Record<string, unknown> = { shots: { learned: { form: [{ name: "自前", kind: "x", n: 3, x: 0.5, y: 0.5 }] } } };
  const r2 = await carryLearnedShots(fakeSb(rows, c), "realpro", own);
  ok("自前があれば継がない・DB を読まない", !r2.carried && r2.why === "own" && c.scopesAsked.length === 0 && own.screen_solid === 1);

  // 履歴に1つも無い → 0 を置いて書ける
  c = { rowReads: 0, scopesAsked: [] };
  const none: Record<string, unknown> = { shots: { total: 1, with_ops: 1 } };
  const r3 = await carryLearnedShots(fakeSb([{ id: 1, scope: "itandi" }], c), "itandi", none);
  ok("履歴に無ければ 0 を置く（書くのは止めない）", !r3.carried && none.screen_solid === 0 && r3.why === "none_in_history");

  {
    const route = readFileSync("app/api/human-learn-profile/route.ts", "utf8");
    const cron = readFileSync("app/api/cron/human-learn-brain/route.ts", "utf8");
    ok("配線: 版の確認は数だけ読む（束の全体を読まない）", /generated_at:bundle->>generated_at, screen_solid:bundle->>screen_solid/.test(route));
    ok("配線: API の作り直しは insert の前に継ぐ", route.indexOf("carryLearnedShots(supabase, scope, bundle)") > 0 && route.indexOf("carryLearnedShots(supabase, scope, bundle)") < route.indexOf('from("human_learn_profile").insert('));
    ok("配線: cron も insert の前に継ぐ", cron.indexOf("carryLearnedShots(supabase, p.scope, p.bundle)") > 0 && cron.indexOf("carryLearnedShots(supabase, p.scope, p.bundle)") < cron.indexOf('from("human_learn_profile").insert('));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
