// 2026-11-20: 束を書く直前の整え（名前を外す・手順書を付ける）。DB を使わない。
// 実行: npx tsx app/lib/__tests__/bundle-write-prepare.test.ts
import { prepareBundleForWrite } from "../bundle-write-prepare";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

console.log("■ 書く直前に名前が外れ、手順書が付く（写真学習・cron の経路と同じ）");
{
  const b: Record<string, unknown> = {
    next: { "今の客:fill_start 平田敏也": { n: 7, next: "今の客:fill_start 平田敏也", total: 24 } },
    scene_flows: [{ scene: "area", runs: 6, steps: ["所在地絞り込み＋", "city_code[]"] }],
  };
  const r = prepareBundleForWrite(b);
  const dump = JSON.stringify(b);
  ok("名前が残らない", !/今の客:[A-Za-z_]+\s+[^"\\]+/.test(dump), dump.slice(0, 200));
  ok("名前を外したと返す", r.names_stripped === true);
  ok("手順書が付く", r.playbook_ok === true && typeof b.playbook === "object" && b.playbook !== null);
}

console.log("■ 名前の無い束は変えずに手順書だけ付く");
{
  const b: Record<string, unknown> = { next: { id: { n: 2 } } };
  const r = prepareBundleForWrite(b);
  ok("名前を外していないと返す", r.names_stripped === false);
  ok("それでも手順書は付く", r.playbook_ok === true);
}

console.log(`\n結果: ${pass} 通過 / ${fail} 失敗`);
if (fail) process.exitCode = 1;
