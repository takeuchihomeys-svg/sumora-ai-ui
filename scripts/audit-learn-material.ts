/**
 * 学習の「材料」がどれだけ揃っているか（API 経由・RLS を避ける）
 * 実行: npx tsx --env-file=.env.local scripts/audit-learn-material.ts
 */
const BASE = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";

void (async () => {
  const r = await fetch(BASE + "/api/human-motion?shots=1");
  const j = (await r.json()) as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rows = (Array.isArray(j) ? j : (j.rows ?? [])) as Array<Record<string, unknown>>;
  const N = rows.length;
  console.log(`API から読めた記録: ${N}行`);
  if (!N) { console.log("行が返りませんでした:", JSON.stringify(j).slice(0, 300)); return; }

  const cnt = (f: (r: Record<string, unknown>) => boolean) => rows.filter(f).length;
  const pct = (n: number) => `${n}件（${Math.round((n / Math.max(1, N)) * 100)}%）`;

  console.log("\n=== ① 学習の材料が入っているか ===");
  console.log("  操作の並び（shot_ops）  :", pct(cnt((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).length > 0)));
  console.log("  写真から読んだ種類      :", pct(cnt((x) => !!x.shot_learn)));
  console.log("  押した欄（point_fields）:", pct(cnt((x) => !!x.point_fields)));
  console.log("  押した数（points_n>0）  :", pct(cnt((x) => Number(x.points_n) > 0)));

  console.log("\n=== ② モードの内訳 ===");
  const byMode: Record<string, number> = {};
  for (const x of rows) { const m = String(x.mode ?? "").trim() || "(空)"; byMode[m] = (byMode[m] ?? 0) + 1; }
  console.log("  " + JSON.stringify(byMode));

  console.log("\n=== ③ 版の内訳 ===");
  const byVer: Record<string, number> = {};
  for (const x of rows) { const v = String(x.ext_version ?? "").trim() || "(空)"; byVer[v] = (byVer[v] ?? 0) + 1; }
  for (const [v, n] of Object.entries(byVer).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${v}: ${n}件`);

  console.log("\n=== ④ 操作の並びがある記録のモード別（順番を学べる物） ===");
  const hasOps = rows.filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).length > 0);
  const opsByMode: Record<string, number> = {};
  for (const x of hasOps) { const m = String(x.mode ?? "").trim() || "(空)"; opsByMode[m] = (opsByMode[m] ?? 0) + 1; }
  console.log("  " + JSON.stringify(opsByMode) + `（合計 ${hasOps.length}件）`);

  console.log("\n=== ⑤ 学べない記録 ===");
  console.log(`  操作の並びが無い: ${cnt((x) => !Array.isArray(x.shot_ops) || (x.shot_ops as unknown[]).length === 0)}件 → 「押す順番」を学べない`);
  console.log(`  押した欄が無い  : ${cnt((x) => !x.point_fields)}件 → 「押す位置」を学べない`);
})();
