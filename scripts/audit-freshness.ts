/** 「最新の学びが反映されるまで」の各段を実測（2026-11-14）
 *   竹内さん「最新の学びが反映されるようになっているのか」
 *  実行: npx tsx scripts/audit-freshness.ts */

function ago(iso: string | null | undefined): string {
  if (!iso) return "(無し)";
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return "(読めない)";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${m % 60}分前`;
  return `${Math.floor(h / 24)}日前`;
}

function nkeys(o: unknown): number {
  return o && typeof o === "object" ? Object.keys(o as object).length : 0;
}

void (async () => {
  const url = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";

  console.log("=== ① 記録（DBに入った最新） ===");
  const r1 = await fetch(url + "/api/human-motion?shots=1");
  const j1 = (await r1.json()) as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rows = (Array.isArray(j1) ? j1 : (j1.rows ?? [])) as Array<Record<string, unknown>>;
  if (rows.length) {
    const newest = rows[0];
    console.log(`  最新の記録: ${ago(String(newest.created_at))}（版 ${String(newest.ext_version)} / ${String(newest.mode ?? "(空)")}）`);
    const byVer: Record<string, number> = {};
    for (const x of rows) { const v = String(x.ext_version ?? "").trim() || "(空)"; byVer[v] = (byVer[v] ?? 0) + 1; }
    console.log("  直近の版:", JSON.stringify(byVer));
  } else console.log("  記録が返りませんでした");

  console.log("\n=== ② 学習の束（保存版） ===");
  const r2 = await fetch(url + "/api/human-learn-profile");
  const j2 = (await r2.json()) as Record<string, unknown>;
  const b = (j2.bundle ?? j2) as Record<string, unknown>;
  const s = (b.source ?? {}) as Record<string, unknown>;
  console.log(`  作られた時刻: ${ago(String(b.generated_at))}`);
  console.log(`  元にした記録: ${String(s.rows)}件 / 新しい記録は ${ago(String(s.to))}`);
  console.log(`  材料（操作の並び）がある: ${String(s.with_ops ?? "-")}件`);
  const vers = (s.versions ?? null) as Record<string, number> | null;
  if (vers) {
    const top = Object.entries(vers).sort((a, x) => x[1] - a[1]).slice(0, 4);
    console.log(`  版の内訳（上位）: ${top.map(([v, n]) => `${v} ${n}件`).join("・")}`);
  } else console.log("  版の内訳: (まだ入っていない＝旧サーバー)");
  console.log(`  next ${nkeys(b.next)}通り / points ${nkeys(b.points)}個 / opens ${nkeys(b.opens)}個`);
  const guessed = Object.entries((b.opens ?? {}) as Record<string, { guessed?: boolean }>).filter(([, v]) => v && v.guessed).length;
  console.log(`  うち名前から推測した開き方: ${guessed}個`);

  console.log("\n=== ③ 自動検索までの遅れ（決まり） ===");
  console.log("  記録 → DB      : 人が操作した直後〜5分（その場で送る口あり）");
  console.log("  束の作り直し   : 30分たっていれば GET のたび / fresh=1 で即 / 毎晩 JST 0:10");
  console.log("  拡張が取り込む : 5分ごとに版を確認（変わった時だけ通信）");
  console.log("  storage → 使用 : 30秒（page-script が読み直す間隔）");
  console.log("  → 学んだ直後から最大でも 約5分半 で自動検索に入る");
})();
