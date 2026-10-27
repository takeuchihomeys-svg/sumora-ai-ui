// 節約①: 場面で決まる材料のブロックを会話ごとの材料の前に置く（2026-10-27）のテスト
// 実行: npx tsx app/lib/__tests__/brain-cache-order.test.ts
import { withSceneBlock, brainCacheOrderOn, type UserBlock } from "../brain-cache-order";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d?: unknown) => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${JSON.stringify(d)}`); } };
const A: UserBlock = { type: "text", text: "A", cache_control: { type: "ephemeral", ttl: "1h" } };
const B: UserBlock = { type: "text", text: "B", cache_control: { type: "ephemeral" } };
const C: UserBlock = { type: "text", text: "会話の材料" };
const r1 = withSceneBlock([C], "一覧", 2);
t("場面のブロックが先頭・区切りつき・中身はそのまま", r1.length === 2 && r1[0].text === "一覧" && !!r1[0].cache_control && r1[1].text === "会話の材料");
const r2 = withSceneBlock([A, B, C], "一覧", 2);
t("区切りが4を超える時は後ろの B から外す", r2.filter((b) => b.cache_control).length === 2 && !!r2[1].cache_control && !r2[2].cache_control, r2);
t("元の配列は変えない", !!B.cache_control);
t("場面の文が空なら今のまま", withSceneBlock([C], "  ", 2).length === 1);
t("文字の集まりは同じ（並びだけ）", withSceneBlock([A, C], "一覧", 2).map((b) => b.text).sort().join() === ["一覧", "A", "会話の材料"].sort().join());
t("既定 off", !brainCacheOrderOn({}) && brainCacheOrderOn({ BRAIN_CACHE_ORDER: "on" }));
console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
