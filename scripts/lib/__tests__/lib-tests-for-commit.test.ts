// npx tsx scripts/lib/__tests__/lib-tests-for-commit.test.ts
// 2026-11-27 作業員L（pre-commit の試験の選び・統括役の決め）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { selectTests } = require("../../hooks/lib-tests-for-commit.cjs") as { selectTests: (s: string[], t: Record<string, string>, k: Record<string, unknown>, m?: Set<string>) => { run: string[]; knownHit: string[] } };
const tests: Record<string, string> = {
  "hold-soft-next.test.ts": `import { x } from "../hold-soft-next";`,
  "hold-soft-next-extra.test.ts": `// 名前で始まる`,
  "hold-soft-next-line.test.ts": `// 別の部品 hold-soft-next-line の試験`,
  "uses-path.test.ts": `readFileSync("app/lib/brain-core.ts")`,
  "imports-at.test.ts": `import { y } from "@/app/lib/hold-soft-next";`,
  "other.test.ts": `import { z } from "../other";`,
  "slow.test.ts": `import { q } from "../hold-soft-next";`,
  "known.test.ts": `import { q } from "../hold-soft-next";`,
};
const known = { slow: [{ file: "slow.test.ts", sec: 12 }], needsEnv: [], knownFail: [{ file: "known.test.ts", owner: "統括役", ledger: 826 }] };
const mods = new Set(["hold-soft-next", "hold-soft-next-line", "brain-core", "other"]);
const r = selectTests(["app/lib/hold-soft-next.ts"], tests, known, mods);
assert.deepEqual(r.run, ["hold-soft-next-extra.test.ts", "hold-soft-next.test.ts", "imports-at.test.ts"]);
assert.deepEqual(r.knownHit, ["known.test.ts", "slow.test.ts"], "遅い・知っている落ちは流さず1行");
assert.deepEqual(selectTests(["app/lib/brain-core.ts"], tests, known, mods).run, ["uses-path.test.ts"], "パスを文字列で読む試験");
assert.deepEqual(selectTests(["app/lib/__tests__/other.test.ts", "memory/x.md"], tests, known, mods).run, ["other.test.ts"], "入る試験そのもの");
assert.deepEqual(selectTests(["scripts/x.ts", "memory/y.md"], tests, known, mods).run, [], "app の外だけなら流さない");
// 表の形
const j = JSON.parse(readFileSync("scripts/hooks/lib-tests-known.json", "utf8")) as { knownFail: Array<{ file: string; owner: string; ledger: number }>; slow: unknown[]; needsEnv: string[] };
assert.ok(j.knownFail.length > 0 && j.knownFail.every((x) => x.file.endsWith(".test.ts") && x.ledger > 0 && x.owner), "知っている落ちは持ち主と台帳の番号つき");
console.log("lib-tests-for-commit: ok");
