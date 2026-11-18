/**
 * 束の solid 引き継ぎ関所
 * 実行: npx tsx app/lib/__tests__/learn-bundle-preserve.test.ts
 */
import {
  countLearnedSolid,
  hasStationTransitSteps,
  inheritLinkFoundations,
  INHERIT_LOOKBACK_DEFAULT,
} from "../learn-bundle-preserve";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail ?? ""); }
}

function learnedSolidN(n: number) {
  const learned: Record<string, Array<{ name: string; n: number; x: number; y: number }>> = {};
  for (let i = 0; i < n; i++) {
    learned[`f${i}`] = [{ name: `f${i}`, n: 3, x: 10 + i, y: 20 + i }];
  }
  return { shots: { learned, in_storage: 100 } };
}

function mockSb(byScope: Record<string, Array<{ bundle: unknown; created_at: string }>>) {
  return {
    from() {
      const state = { scope: "" as string };
      const api = {
        select() { return api; },
        eq(_c: string, v: string) { state.scope = v; return api; },
        order() { return api; },
        limit(n: number) {
          const rows = byScope[state.scope] || [];
          return Promise.resolve({ data: rows.slice(0, n), error: null });
        },
      };
      return api;
    },
  };
}

void (async () => {
  console.log("■ countLearnedSolid / transit");
  ok("0は0", countLearnedSolid({}).solid === 0);
  ok("96相当", countLearnedSolid(learnedSolidN(96)).solid === 96);
  ok("駅遷移あり", hasStationTransitSteps({
    scene_flows: [{ scene: "station", steps: ["駅の設定へ進む｜span"] }],
  }) === true);
  ok("既定lookback>=80", INHERIT_LOOKBACK_DEFAULT >= 80);

  // ★ 2026-11-19 「1は危ない」: site 別は all から位置を継がない（自前の履歴だけ）
  console.log("\n■ inherit: realpro は自前の履歴から（all から混ぜない）");
  {
    const own: Record<string, unknown> = { shots: { in_storage: 50 } };
    const prOwn = await inheritLinkFoundations(
      mockSb({
        realpro: [
          { bundle: { shots: { learned: {} } }, created_at: "2026-11-18T03:00:00Z" },
          { bundle: learnedSolidN(96), created_at: "2026-11-17T23:00:00Z" },
        ],
      }) as never,
      own,
      "realpro",
      { lookback: 80, minSolid: 30 },
    );
    ok("自前の履歴から solid≥30 を継ぐ", prOwn.solid >= 30 && prOwn.preserved === true, prOwn);
    ok("束に learned", !!(own.shots as { learned?: unknown })?.learned);

    const onlyAll: Record<string, unknown> = { shots: { in_storage: 50 } };
    const prAll = await inheritLinkFoundations(
      mockSb({
        realpro: [{ bundle: { shots: { learned: {} } }, created_at: "2026-11-18T03:00:00Z" }],
        all: [{ bundle: learnedSolidN(96), created_at: "2026-11-17T23:00:00Z" }],
      }) as never,
      onlyAll,
      "realpro",
      { lookback: 80, minSolid: 30 },
    );
    ok("自前が空なら all の位置は継がない（混ぜない）", prAll.preserved === false && prAll.solid === 0, prAll);
  }

  console.log("\n■ inherit: lookback溢れでも best 救出");
  {
    const zeros = Array.from({ length: 10 }, (_, i) => ({
      bundle: { shots: { learned: {} } },
      created_at: `2026-11-18T0${i}:00:00Z`,
    }));
    const zero: Record<string, unknown> = { shots: { in_storage: 1 } };
    const pr2 = await inheritLinkFoundations(
      mockSb({
        realpro: [...zeros, { bundle: learnedSolidN(96), created_at: "2026-11-01T00:00:00Z" }],
      }) as never,
      zero,
      "realpro",
      { lookback: 3, minSolid: 30 },
    );
    ok("best救出 solid≥30", pr2.solid >= 30, pr2);
    ok("safe", pr2.safe_to_write === true, pr2);
  }

  console.log("\n■ inherit: 履歴読めず solid不足 → 拒否");
  {
    const sbErr = {
      from() {
        const api = {
          select() { return api; },
          eq() { return api; },
          order() { return api; },
          limit() { return Promise.resolve({ data: null, error: { message: "JWT" } }); },
        };
        return api;
      },
    };
    const thin: Record<string, unknown> = { shots: {} };
    const pr = await inheritLinkFoundations(sbErr as never, thin, "all", { minSolid: 30 });
    ok("safe_to_write=false", pr.safe_to_write === false, pr);
    ok("read_error", !!pr.read_error, pr);
  }

  console.log(`\n■ 結果: ${pass} ok, ${fail} fail`);
  if (fail) process.exit(1);
})();
