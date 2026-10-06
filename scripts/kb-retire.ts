// scripts/kb-retire.ts — 設計知見を非現行にする（CLAUDE.md「古い知見が上書きされたら is_current=false」）
//
// 2026-09-21 追加: 同じセッション内で知見を書き直したい事が多い（実測が進んで結論が変わる）。
//   消すのではなく非現行にして履歴を残す。書き直した物は kb-insert.ts で入れ直す。
// 2026-10-06（⑯・竹内「設計知見の更新や成長はツールを完成させるにあたってかなり重要」）: 理由と上書きした新しい行も残す
//   （retired_reason・superseded_by・retired_at・retired_by。列は migrate-schema・scripts/apply-design-knowledge-curation.ts）。
//   決まりを変える知見を入れたら、同じ手順で古い行をこれで退役する。
//
// 実行: npx tsx --env-file=.env.local scripts/kb-retire.ts "<タイトル（完全一致）>" [--by=<新しい行の id>] [--reason=<理由>]
//       npx tsx --env-file=.env.local scripts/kb-retire.ts --id=<古い行の id> --by=<新しい行の id> --reason=<理由>
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=");
const id = arg("id");
const by = arg("by");
const reason = arg("reason");
const title = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!id && !title) { console.error('使い方: npx tsx --env-file=.env.local scripts/kb-retire.ts "<タイトル>" [--by=<新しい行の id>] [--reason=<理由>]  または --id=<id>'); process.exit(1); }

async function main() {
  if (by) {
    const { data: nb, error: e1 } = await sb.from("system_design_thinking").select("id, title, is_current").eq("id", by).maybeSingle();
    if (e1 || !nb) { console.error(`上書きした行が見つかりません: ${by}`); process.exit(1); }
    if (!(nb as { is_current: boolean }).is_current) console.warn(`⚠ 上書きした行 ${by} は非現行です`);
  }
  let q = sb.from("system_design_thinking")
    .update({
      is_current: false,
      retired_reason: reason || (by ? `新しい行 ${by} に上書きされた` : "非現行にした"),
      superseded_by: by || null,
      retired_at: new Date().toISOString(),
      retired_by: "kb-retire",
    })
    .eq("is_current", true);
  q = id ? q.eq("id", id) : q.eq("title", title as string);
  const { data, error } = await q.select("id, title");
  if (error) { console.error("UPDATE 失敗:", error.message); process.exit(1); }
  const rows = (data ?? []) as Array<{ id: string; title: string }>;
  if (rows.length === 0) { console.error(`現行の知見が見つかりません: ${id || title}`); process.exit(1); }
  for (const r of rows) console.log(`非現行にしました: ${r.title}（${r.id}）${by ? ` → ${by}` : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
