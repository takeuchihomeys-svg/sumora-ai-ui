/**
 * 位置の引き継ぎはその site の履歴だけ（all へ落とさない）を確かめる（2026-11-19）
 * 実行: npx tsx app/lib/__tests__/learn-bundle-no-site-mix.test.ts
 */
import { inheritLinkFoundations, countLearnedSolid } from "../learn-bundle-preserve";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}

function learnedBundle(n: number): Record<string, unknown> {
  const fields = Array.from({ length: n }, (_, i) => ({ name: `f${i}`, kind: "text", n: 5, x: 0.1, y: 0.2 }));
  return { shots: { learned: { form: fields } }, source: { rows: 10 } };
}

/** 最小の偽 Supabase: scope ごとの行を返す。読まれた scope を記録する */
function fakeSb(rowsByScope: Record<string, unknown[]>, read: string[]) {
  return {
    from(_t: string) {
      let scope = "";
      const b = {
        select() { return b; },
        eq(col: string, val: string) { if (col === "scope") scope = val; return b; },
        order() { return b; },
        limit() {
          read.push(scope);
          const data = (rowsByScope[scope] || []).map((bundle) => ({ bundle, created_at: "2026-11-18T00:00:00Z" }));
          return Promise.resolve({ data, error: null });
        },
      };
      return b;
    },
  } as unknown as Parameters<typeof inheritLinkFoundations>[0];
}

async function main() {
  console.log("■ itandi は all の厚い位置を継がない");
  {
    const read: string[] = [];
    const sb = fakeSb({ all: [learnedBundle(40)], itandi: [] }, read);
    const b: Record<string, unknown> = { shots: { total: 84 }, source: { rows: 84 } };
    const r = await inheritLinkFoundations(sb, b, "itandi", { lookback: 80, minSolid: 30 });
    ok("all の行を読みに行かない", !read.includes("all"), read);
    ok("位置は継がれない（solid 0 のまま）", countLearnedSolid(b).solid === 0, countLearnedSolid(b).solid);
    ok("preserved は false", r.preserved === false, r);
  }

  console.log("■ realpro は自前の履歴から継ぐ");
  {
    const read: string[] = [];
    const sb = fakeSb({ realpro: [learnedBundle(40)], all: [] }, read);
    const b: Record<string, unknown> = { shots: { total: 6000 }, source: { rows: 6000 } };
    const r = await inheritLinkFoundations(sb, b, "realpro", { lookback: 80, minSolid: 30 });
    ok("自前（realpro）の行から継ぐ", r.preserved === true && countLearnedSolid(b).solid === 40, r);
    ok("all は読まない", !read.includes("all"), read);
  }

  console.log("■ all は all だけ");
  {
    const read: string[] = [];
    const sb = fakeSb({ all: [learnedBundle(40)] }, read);
    const b: Record<string, unknown> = { shots: { total: 1 }, source: { rows: 1 } };
    await inheritLinkFoundations(sb, b, "all", { lookback: 80, minSolid: 30 });
    ok("all の読みは all のみ", read.every((s) => s === "all"), read);
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
