// scripts/fix-image-details-vacancy-lines.ts — 保存済みの資料の画像の中身の行（image_details.lines）に、現況・入居可能日・退去予定の整え（normalizeVacancyLines・決定論・LLM なし）を当てる
// 2026-10-13 竹内さん承認（過去の物件資料の読み直し・本番 DB への書き戻し）。読み直さずに文字で直せる取り違えだけ（「現況: A / B」の分け・「入居可能」の現況・解約予定日・入居予定日の欄の退去予定・同じ値の退去予定）。
// 実行: npx tsx --env-file=.env.local scripts/fix-image-details-vacancy-lines.ts [--since=2026-07-01] [--apply] [--show=10]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];

async function main() {
  const { normalizeVacancyLines } = await import("../app/lib/property-detail-source");
  const apply = process.argv.includes("--apply"), show = Number(arg("show", "10"));
  const rows: Array<{ image_url: string; lines: unknown }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("image_details").select("image_url, lines").gte("read_at", arg("since", "2026-07-01")).range(f, f + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  let changed = 0, written = 0;
  for (const r of rows) {
    const lines = Array.isArray(r.lines) ? (r.lines as string[]) : [];
    const next = normalizeVacancyLines(lines);
    if (JSON.stringify(next) === JSON.stringify(lines)) continue;
    changed++;
    if (changed <= show) console.log(`- ${r.image_url.slice(-30)}\n    前: ${lines.filter((l) => /現況|入居可能|退去/.test(l)).join(" ／ ")}\n    後: ${next.filter((l) => /現況|入居可能|退去/.test(l)).join(" ／ ")}`);
    if (apply) { const { error } = await sb.from("image_details").update({ lines: next }).eq("image_url", r.image_url); if (!error) written++; }
  }
  console.log(`\n中身の行 ${rows.length}・整う ${changed}${apply ? `・書いた ${written}` : "（数えるだけ。書く時は --apply）"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
