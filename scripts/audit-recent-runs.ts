/**
 * 直近の検索で「実際に何が押されたか」を点検（2026-11-14）
 *   竹内さん「なぜか地域を都島区を押してしまっている」「検索ボタンも押していなかった」
 * 実行: npx tsx scripts/audit-recent-runs.ts
 */
void (async () => {
  const url = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
  const r = await fetch(url + "/api/human-motion?summary=1");
  console.log("summary:", r.status, (await r.text()).slice(0, 500));

  const r2 = await fetch(url + "/api/human-learn-profile?fresh=1");
  const j2 = (await r2.json()) as Record<string, unknown>;
  const b = (j2.bundle ?? j2) as Record<string, unknown>;
  const pts = (b.points ?? {}) as Record<string, { x: number; y: number; n: number; w?: string }>;
  console.log("\n=== 学んだ押す位置のうち「区」に関係する物 ===");
  for (const [k, v] of Object.entries(pts)) {
    if (/one_city|区/.test(k)) console.log(`  ${k} → 横${Math.round(v.x * 100)}% 縦${Math.round(v.y * 100)}% (${v.n}回 / ${v.w ?? "-"})`);
  }
  console.log("\n=== 学んだ順番のうち「地域まわり」 ===");
  const nx = (b.next ?? {}) as Record<string, { next: string; n: number; total: number }>;
  for (const [k, v] of Object.entries(nx)) {
    if (/one_city|区|絞り込み|検索|確定|town/.test(k) || /one_city|区|絞り込み|検索|確定|town/.test(v.next)) {
      console.log(`  ${k} → ${v.next}（${v.n}/${v.total}）`);
    }
  }
  console.log("\n=== 開き方（opens） ===");
  const op = (b.opens ?? {}) as Record<string, { opens: string; n: number; guessed?: boolean }>;
  for (const [k, v] of Object.entries(op)) {
    if (/one_city|絞り込み|検索|確定/.test(k)) console.log(`  ${k} → ${v.opens}（${v.guessed ? "推測" : v.n + "回"}）`);
  }
})();
