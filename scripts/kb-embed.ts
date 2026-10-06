// scripts/kb-embed.ts — 設計知見の埋め込みを作る（無い・文が変わった現行の行だけ）
// 2026-10-06 竹内「設計知見ひっぱるときRAG検索いれたらどうか」（⑯）。文は 題＋本文＋根拠＋札（design-knowledge-rag.ts kbEmbeddingInput）
// 実行: npx tsx --env-file=.env.local scripts/kb-embed.ts            … 数えるだけ（費用の見積もり）
//       npx tsx --env-file=.env.local scripts/kb-embed.ts --apply    … 埋めて書く
import { createClient } from "@supabase/supabase-js";
import { embedKbRows } from "../app/lib/design-knowledge-rag-server";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  const apply = process.argv.includes("--apply");
  const t0 = Date.now();
  const r = await embedKbRows(sb, { dry: !apply });
  console.log(`=== 設計知見の埋め込み（${apply ? "書いた" : "数えただけ"}）`);
  console.log(`対象 ${r.target}行・埋めた ${r.embedded}行・トークン ${r.tokens || "-"}（見積もり ${r.estTokens}）・費用 $${r.usd.toFixed(4)}・${((Date.now() - t0) / 1000).toFixed(1)}秒`);
})().catch((e) => { console.error(e); process.exit(1); });
