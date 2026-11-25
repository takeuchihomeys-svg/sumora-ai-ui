// scripts/ext-link-check.ts — 拡張ツールと手順書・本番・DB がちゃんと連動しているかを1回で点検する（2026-11-26）
//
//   npx tsx scripts/ext-link-check.ts          … 手元の点検（DB も本番も読まない・速い）
//   npx tsx --env-file=.env.local scripts/ext-link-check.ts --db   … DB の手順書と本番も読む（読むだけ・書かない）
//
// 改善のたびに（拡張・手順書・決まり・待ち時間・記録を直したら）回す。赤が1つでもあれば、そのまま出さない。
// 赤の中身は「直す／判断を竹内さんに聞く」に分けて報告する（推測で一覧を作り直さない）。
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const TESTS: Array<{ name: string; cmd: "tsx" | "node"; file: string }> = [
  // 手順書（決まりの一覧・版・作り直し・点検の判定）
  { name: "手順書の決まり（一覧・版・拡張との一致）", cmd: "tsx", file: "app/lib/__tests__/auto-procedure-rules.test.ts" },
  { name: "手順書の作り直しの止め方", cmd: "tsx", file: "app/lib/__tests__/playbook-downgrade-guard.test.ts" },
  { name: "区・流れの順の関所", cmd: "tsx", file: "app/lib/__tests__/flow-series-order-gate.test.ts" },
  // 拡張の動き（停止・見張り・区の確認・記録）
  { name: "人の間の印（見張りが止まりと数えない）", cmd: "node", file: "tests/chrome-extension/intent-wait-v2299.test.js" },
  { name: "0件の空回り・停止の安全弁", cmd: "node", file: "tests/chrome-extension/zero-count-and-pause-v2298.test.js" },
  { name: "停止の後の再並べ（1件を捨てない）", cmd: "node", file: "tests/chrome-extension/pause-requeue-v2813.test.js" },
  { name: "手の止まり（人の間・迷い）", cmd: "node", file: "tests/chrome-extension/human-pause-v2611.test.js" },
  { name: "固まり防止（忙しい判定）", cmd: "node", file: "tests/chrome-extension/no-freeze-v268.test.js" },
  { name: "区の確認（キューが空になるまで・上限）", cmd: "node", file: "tests/chrome-extension/area-verify-wait-v2785.test.js" },
  { name: "区レーン", cmd: "node", file: "tests/chrome-extension/ward-lane-v2808.test.js" },
  { name: "静かな窓・版の固定（manifest == page == 手順書）", cmd: "node", file: "tests/chrome-extension/quiet-window-v2295.test.js" },
  { name: "手順書の反映（拡張が読んだか）", cmd: "node", file: "tests/chrome-extension/playbook-reflect-v2297.test.js" },
  { name: "拡張が古い時の案内（再読み込みの忘れを見える化）", cmd: "node", file: "tests/chrome-extension/ext-behind-v28304.test.js" },
  { name: "沈黙の見張り（画面把握→次の手）", cmd: "node", file: "tests/chrome-extension/stuck-retry-bottleneck-v28272.test.js" },
  { name: "一括の流れ（前の客の後に待つ）", cmd: "node", file: "tests/chrome-extension/bulk-loop-sim-v28265.test.js" },
  { name: "リセット後の入力の待ち", cmd: "node", file: "tests/chrome-extension/reset-before-fill-v2296.test.js" },
  { name: "リセット後の次の客の待ち", cmd: "node", file: "tests/chrome-extension/reset-between-customers-v28284.test.js" },
  // 既知の赤: 人の操作の間（クリック・並べ替えの前後）に固定の数字の待ちが残っている（直すのは拡張の動きを変えるので竹内さんの OK 後）
  { name: "人の操作の間の固定の待ち（直すまで赤）", cmd: "node", file: "tests/chrome-extension/human-wait.test.js" },
];

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];

for (const t of TESTS) {
  const r = t.cmd === "tsx"
    ? spawnSync("npx", ["tsx", join(ROOT, t.file)], { encoding: "utf8", shell: true, cwd: ROOT })
    : spawnSync(process.execPath, [join(ROOT, t.file)], { encoding: "utf8", cwd: ROOT });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failed = (out.match(/✗/g) ?? []).length;
  const ok = r.status === 0 && failed === 0;
  const last = out.trim().split("\n").filter(Boolean).pop() ?? "";
  rows.push({ name: t.name, ok, detail: ok ? last.slice(0, 60) : `✗ ${failed} 件（${last.slice(0, 60)}）` });
}

// 2026-11-26: 上の一覧は 15 本だけ。拡張の試験は全部（約 330 本）を回し、基準（未整理の古い赤）より増えた赤だけを失敗にする
{
  const r = spawnSync("npx", ["tsx", join(ROOT, "scripts/ext-test-all.ts")], { encoding: "utf8", shell: true, cwd: ROOT });
  const out = `${r.stdout ?? ""}`;
  const head = out.split("\n").find((l) => l.startsWith("■")) ?? "";
  const stale = out.split("\n").find((l) => l.includes("基準の赤")) ?? "";
  const ok = r.status === 0;
  rows.push({ name: "拡張の試験 全本（新しく壊れた赤が無いか）", ok, detail: ok ? `${head.replace("■ ", "")}／${stale.trim()}`.slice(0, 120) : out.split("\n").filter((l) => /❌|✗/.test(l)).slice(0, 4).join(" / ") });
}

if (process.argv.includes("--db")) {
  const r = spawnSync("npx", ["tsx", "--env-file=.env.local", join(ROOT, "scripts/check-playbook-sync.ts")], { encoding: "utf8", shell: true, cwd: ROOT });
  const out = `${r.stdout ?? ""}`;
  const ok = r.status === 0;
  const bad = out.split("\n").filter((l) => /❌/.test(l)).map((l) => l.trim()).slice(0, 4);
  rows.push({ name: "DB の手順書・本番（check-playbook-sync）", ok, detail: ok ? "揃っている" : bad.join(" / ") });
}

console.log("■ 拡張ツールの連動点検");
for (const r of rows) console.log(`  ${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? (r.name.startsWith("拡張の試験 全本") ? `\n      ${r.detail}` : "") : `\n      ${r.detail}`}`);
const reds = rows.filter((r) => !r.ok).length;
console.log(`\n結論: ${rows.length - reds} 件 OK / ${reds} 件 赤`);
if (!process.argv.includes("--db")) console.log("（DB と本番は見ていない。連動を確かめるなら --db を付ける）");
process.exit(reds ? 1 : 0);
