// CELL_AVOID_CONFLICT が実際にどこで起きているかを見る（読み取りのみ）
// 2026-09-21 竹内「これはどこの部分か」
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const convs = await page("conversations", "id, ai_draft_check, suggested_aix_meta, updated_at", "updated_at", Number(process.env.DAYS ?? 30));
  const hits: Array<{ id: string; msg: string; ev: string; avoid: string[]; dir: string }> = [];
  for (const c of convs) {
    const chk = c.ai_draft_check as { issues?: Array<Record<string, unknown>> } | null;
    if (!chk?.issues) continue;
    for (const i of chk.issues) {
      if (String(i.code) !== "CELL_AVOID_CONFLICT") continue;
      const m = (c.suggested_aix_meta ?? {}) as Record<string, unknown>;
      hits.push({
        id: String(c.id).slice(0, 8),
        msg: String(i.message ?? ""),
        ev: String(i.evidence ?? ""),
        avoid: (m.avoid_topics as string[] | undefined) ?? [],
        dir: String(m.reply_direction ?? ""),
      });
    }
  }
  console.log(`=== CELL_AVOID_CONFLICT の実物 ${hits.length}件 ===\n`);
  // 同じセル×同じ avoid の組で集計
  const g = new Map<string, number>();
  for (const h of hits) {
    const cell = h.msg.match(/セル\s*([A-Z_0-9]+)/)?.[1] ?? "?";
    const el = h.msg.match(/必須要素「([^」]+)」/)?.[1] ?? "?";
    const av = h.msg.match(/avoid_topics「([^」]+)」/)?.[1] ?? "?";
    const cls = h.msg.match(/意味クラス:\s*([a-z_]+)/)?.[1] ?? "?";
    g.set(`${cell} ｜ 必須「${el}」 × 避ける「${av}」 ｜ ${cls}`, (g.get(`${cell} ｜ 必須「${el}」 × 避ける「${av}」 ｜ ${cls}`) ?? 0) + 1);
  }
  for (const [k, c] of [...g.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(c).padStart(3)}件  ${k}`);

  console.log(`\n=== 1件ずつの中身（最大6件）===`);
  for (const h of hits.slice(0, 6)) {
    console.log(`${"─".repeat(74)}`);
    console.log(`   会話 ${h.id}`);
    console.log(`   指摘: ${h.msg}`);
    console.log(`   ブレインの返信方向: ${h.dir.slice(0, 100)}`);
    console.log(`   ブレインの避ける話題: ${h.avoid.join(" / ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
