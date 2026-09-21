// 画像の保存期間（3か月）で消える予定の物を確かめる（読み取りのみ・消さない）
// 2026-09-22 竹内「保存期間を3ヶ月とかにしている方が良い。公式LINEのように」
// 実行: npx tsx --env-file=.env.local scripts/peek-image-retention.ts [--days=90]
import { createClient } from "@supabase/supabase-js";

// /api/cleanup-images と同じ接続（公開キー）で呼ぶ
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=90").split("=")[1]);

async function main() {
  const { data, error } = await sb.rpc("expired_line_upload_objects", { p_days: DAYS, p_limit: 100000 });
  if (error) { console.log("⚠", error.message); return; }
  const rows = (data ?? []) as Array<{ name: string; size: number | null; created_at: string }>;
  const mb = rows.reduce((n, r) => n + (r.size ?? 0), 0) / 1024 / 1024;
  const byFolder = new Map<string, number>();
  for (const r of rows) {
    const f = /^[0-9a-f]{8}-/.test(r.name) ? "(会話ID)" : r.name.split("/")[0];
    byFolder.set(f, (byFolder.get(f) ?? 0) + 1);
  }
  console.log(`=== アップロードから${DAYS}日を過ぎた送信用の画像: ${rows.length}ファイル・${mb.toFixed(0)}MB ===`);
  for (const [f, n] of byFolder) console.log(`  ${f}: ${n}`);
  console.log(`  最古 ${rows[0]?.created_at?.slice(0, 10) ?? "-"} ／ 最新 ${rows.at(-1)?.created_at?.slice(0, 10) ?? "-"}`);
  console.log(`  1晩500件ずつ消すので、今ある分は ${Math.ceil(rows.length / 500)} 晩で片付く`);
}
main().catch((e) => { console.error(e); process.exit(1); });
