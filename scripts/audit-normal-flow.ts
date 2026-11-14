/**
 * 新しい通常モードの記録から「できていない部分」を洗い出す（2026-11-14）
 *   竹内さん「今新しく通常で一連の流れをおこなった。データベースからできていない部分学習するようにする」
 * 実行: npx tsx scripts/audit-normal-flow.ts
 */
type FlowRec = Record<string, unknown>;

void (async () => {
  const url = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
  const r = await fetch(url + "/api/human-motion?shots=1&limit=200");
  const j = (await r.json()) as { rows?: FlowRec[] } | FlowRec[];
  const rows = (Array.isArray(j) ? j : (j.rows ?? [])) as FlowRec[];
  const fresh = rows.filter((x) => String(x.ext_version ?? "") === "2.7.34");
  console.log(`直近 ${rows.length}行 / うち 2.7.34: ${fresh.length}行`);

  const withOps = fresh.filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).length > 0);
  console.log(`操作の並び（shot_ops）がある: ${withOps.length}行`);

  console.log("\n=== ① 最新の録画の一連の流れ（操作の並び） ===");
  const latest = withOps[0];
  if (latest) {
    console.log(`時刻: ${String(latest.created_at)} / mode: ${String(latest.mode)}`);
    const ops = latest.shot_ops as FlowRec[];
    for (const o of ops) {
      const k = String(o.k ?? ""), f = String(o.f ?? ""), w = String(o.w ?? "");
      if (!f && k === "scroll") continue;
      console.log(`    ${k.padEnd(7)} ${f}${w ? " [" + w + "]" : ""}`);
    }
  } else console.log("  操作の並びがある記録がありません");

  console.log("\n=== ② 押した欄（種類つき）＝学びの材料 ===");
  const seen = new Map<string, { w: string; n: number }>();
  for (const x of fresh) {
    const pf = x.point_fields as Record<string, FlowRec> | null;
    if (!pf) continue;
    for (const [k, v] of Object.entries(pf)) {
      const cur = seen.get(k) ?? { w: String(v.w ?? "?"), n: 0 };
      cur.n += Number(v.n) || 0;
      if (v.w) cur.w = String(v.w);
      seen.set(k, cur);
    }
  }
  console.log(`  押された欄: ${seen.size}種類`);
  for (const [k, v] of [...seen.entries()].slice(0, 25)) console.log(`    ${k} [${v.w}] ${v.n}回`);

  console.log("\n=== ③ 種類が「other」のまま（ボタンかプルダウンか決まっていない） ===");
  const other = [...seen.entries()].filter(([, v]) => v.w === "other");
  if (other.length) for (const [k, v] of other.slice(0, 20)) console.log(`    ${k} ${v.n}回`);
  else console.log("  ✓ ありません");

  console.log("\n=== ④ 統括の判断（できていない部分） ===");
  const rp = await fetch(url + "/api/human-learn-profile?fresh=1");
  const jp = (await rp.json()) as Record<string, unknown>;
  const b = (jp.bundle ?? jp) as Record<string, unknown>;
  const lp = (b.learn_plan ?? {}) as Record<string, unknown>;
  for (const x of ((lp.mode_plan ?? []) as FlowRec[])) {
    console.log(`  ${String(x.mode)}: ${String(x.verdict)} → ${String(x.action)}`);
  }
  const weak = (b.weak ?? []) as FlowRec[];
  console.log(`\n  弱い所 ${weak.length}件:`);
  for (const w of weak.slice(0, 10)) console.log(`    ・${String(w.kind)} / ${String(w.name)}`);
})();
