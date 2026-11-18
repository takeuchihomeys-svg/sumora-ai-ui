/**
 * 学習方法の強化
 * 実行: npx tsx app/lib/__tests__/learn-method-strengthen.test.ts
 */
import { strengthenLearnMethod } from "../learn-method-strengthen";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log("  ✓", name);
  else {
    failed++;
    console.log("  ✗", name, detail || "");
  }
}

console.log("learn-method-strengthen");

{
  const m = strengthenLearnMethod({
    before: { pointPct: 14, readCount: 0, aimHitPct: 0 },
    after: { pointPct: 14, readCount: 0, aimHitPct: 0, shortGapPct: 45, reflectOk: 0 },
    usedKinds: ["photo_learn"],
    didFlash: true,
    bottleneckN: 5,
    unreadNormal: 0,
  });
  ok("flash偏重→関所優先", m.upgrades.some((u) => u.id === "order_reload_before_flash"));
  ok("周回継続", m.continue_loop);
  ok("次の学び方がある", /再読込|関所/.test(m.next_method_line), m.next_method_line);
}

{
  const m = strengthenLearnMethod({
    before: { pointPct: 14, readCount: 0 },
    after: { pointPct: 14, readCount: 0, aimHitPct: 0 },
    didFlash: true,
    usedKinds: ["photo_learn"],
  });
  ok("効果が0なら1つずつ", m.upgrades.some((u) => u.id === "one_by_one_button" || u.id === "verify_then_relearn"));
}

{
  const m = strengthenLearnMethod({
    before: { pointPct: 50, readCount: 1, aimHitPct: 50, shortGapPct: 8, nearnessScore: 70 },
    after: { pointPct: 65, readCount: 3, aimHitPct: 55, shortGapPct: 8, nearnessScore: 72, reflectOk: 2 },
    usedKinds: ["need_ext_reload", "need_auto_run"],
    didFlash: false,
    bottleneckN: null,
  });
  ok("達成寄りなら大きな修正なしor少", m.upgrades.length <= 2, String(m.upgrades.length));
}

if (failed) {
  console.log("FAILED", failed);
  process.exit(1);
}
console.log("OK");
