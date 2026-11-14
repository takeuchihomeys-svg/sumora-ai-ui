/**
 * 「最新の学びが反映されるまで」の各段の遅れを実測（2026-11-14）
 *   竹内さん「最新の学びが反映されるようになっているのか」
 *
 * 段:
 *   ① 記録がDBに入る（拡張→サーバー）      … 5分ごと/その場
 *   ② サーバーが束を作る（fresh=1 / cron）  … その場 または 毎晩 JST 0:10
 *   ③ 拡張が束を取りに行く                  … 1時間ごと（版が変わった時だけ通信）
 *   ④ 拡張がstorageに置く → page-scriptが読む … 30秒
 *   ⑤ 自動検索が使う                        … 次の検索から
 *
 * 実行: npx tsx scripts/audit-freshness.ts
 */
const BASE = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";

const ago = (iso: string | null | undefined) => {
  if (!iso) return "(無し)";
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return "(読めない)";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${m % 60}分前`;
  return `${Math.floor(h / 24)}日前`;
};

void (async () => {
  console.log("=== ① 記録（DBに入った最新） ===");
  const r1 = await fetch(BASE + "/api/human-motion?shots=1");
  const j1 = (await r1.json()) as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rows = (Array.isArray(j1) ? j1 : (j1.rows ?? [])) as Array<Record<string, unknown>>;
  if (rows.length) {
    const newest = rows[0];
    console.log(`  いちばん新しい記録: ${ago(String(newest.created_at))}（${String(newest.created_at)}）`);
    console.log(`  版: ${String(newest.ext_version)} / モード: ${String(newest.mode ?? "(空)")} / サイト: ${String(newest.site)}`);
    const byVer: Record<string, number> = {};
    for (const x of rows) { const v = String(x.ext_version ?? "").trim() || "(空)"; byVer[v] = (byVer[v] ?? 0) + 1; }
    console.log("  版の内訳:", JSON.stringify(byVer));
  } else {
    console.log("  記録が返りませんでした");
  }

  console.log("\n=== ② 学習の束（いつ作られたか） ===");
  const r2 = await fetch(BASE + "/api/human-learn-profile");
  const j2 = (await r2.json()) as Record<string, unknown>;
  const b = (j2.bundle ?? j2) as Record<string, unknown>;
  const src = (b.source ?? {}) as Record<string, unknown>;
  console.log(`  generated_at: ${String(b.generated_at)}（${ago(String(b.generated_at))}）`);
  console.log(`  元にした記録: ${String(src.rows)}件 / 期間 ${String(src.from)} 〜 ${String(src.to)}（新しい方は ${ago(String(src.to))}）`);
  console.log(`  版の内訳: ${JSON.stringify(src.versions ?? "(無し＝まだ新版が読まれていない)")}`);
  console.log(`  材料がある記録: ${String(src.with_ops ?? "-")}件`);
  console.log(`  next ${Object.keys((b.next ?? {}) as object).length}通り / points ${Object.keys((b.points ?? {}) as object).length}個 / opens ${Object.keys((b.opens ?? {}) as object).length}個`);
  const lp = (b.learn_plan ?? {}) as Record<string, unknown>;
  const mp = (lp.mode_plan ?? []) as Array<Record<string, unknown>>;
  console.log("  mode_plan:");
  for (const x of mp) console.log(`    ${String(x.mode)}: ${String(x.verdict)}`);

  console.log("\n=== ③ 保存されている束（DBの human_learn_profile） ===");
  const r3 = await fetch(BASE + "/api/human-learn-profile?history=1&limit=3");
  const j3 = (await r3.json()) as Record<string, unknown>;
  const hist = ((j3.rows ?? j3.history ?? []) as Array<Record<string, unknown>>);
  if (hist.length) {
    for (const h of hist.slice(0, 3)) {
      console.log(`  ${String(h.created_at)}（${ago(String(h.created_at))}）元 ${String(h.source_rows)}件 版 ${String(h.ext_version ?? "-")}`);
    }
  } else console.log("  履歴なし");

  console.log("\n=== ④ 今すぐ作り直した時に何が変わるか（fresh=1） ===");
  const r4 = await fetch(BASE + "/api/human-learn-profile?fresh=1");
  const j4 = (await r4.json()) as Record<string, unknown>;
  const b4 = (j4.bundle ?? j4) as Record<string, unknown>;
  const s4 = (b4.source ?? {}) as Record<string, unknown>;
  console.log(`  fresh の generated_at: ${String(b4.generated_at)}（${ago(String(b4.generated_at))}）`);
  console.log(`  元にした記録: ${String(s4.rows)}件 / 版 ${JSON.stringify(s4.versions ?? {})}`);
  console.log(`  next ${Object.keys((b4.next ?? {}) as object).length}通り / opens ${Object.keys((b4.opens ?? {}) as object).length}個`);

  const stale = Date.parse(String(b.generated_at)) < Date.parse(String(b4.generated_at));
  console.log(`\n  → 保存版は ${stale ? "古い（fresh の方が新しい）" : "新しい（fresh と同じ）"}`);
})();
