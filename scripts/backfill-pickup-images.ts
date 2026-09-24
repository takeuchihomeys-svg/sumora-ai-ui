// scripts/backfill-pickup-images.ts — 売上サポの文字抜け画像を、直した描画で作り直す（一回きり）
//
// 2026-09-24 竹内「文字が反映されていないバグも起きている。原因見つけて改善する」:
//   本番では pdfjs に cMapUrl が渡っておらず（require.resolve が Turbopack で数値に置き換わった・app/lib/pdfjs-assets.ts）、
//   画像の機能が入った 9/24 09:45 JST（676e3332）以降の property_pickups の page_image_url（1ページ目）と agent_image_url（2ページ目）は
//   表・設備欄・備考の文字が全部抜けていた。文字層（pdf_text・pdf_has_text）も同じ原因で空。
//   → pdf_blob_url の PDF を直した renderPdfPageToPng・extractPdfText でもう一度描き、新しい Blob に置いて行を更新する。
//   trim_image_url（画面で描いた物）は正常なので触らない。
//
// 実行:
//   npx tsx --env-file=.env.local scripts/backfill-pickup-images.ts                 # dry-run（件数と、作り直した画像の文字の数を見るだけ・書き込まない）
//   npx tsx --env-file=.env.local scripts/backfill-pickup-images.ts --out=<dir>     # dry-run で作り直した画像を <dir> に保存（目で確かめる）
//   npx tsx --env-file=.env.local scripts/backfill-pickup-images.ts --apply         # 本当に作り直す（BLOB_READ_WRITE_TOKEN が要る）
//     --reset-analysis  文字の無い画像で出した「画像で分析」の結果（image_analysis）を空にする（ボタンを押し直してもらう・DeepSeek は呼ばない）
//     --delete-old      古い画像の Blob を消す
//     --since=ISO       対象の始まり（既定 2026-09-24T00:45:00Z＝09:45 JST）  --ids=1,2,3  特定の行だけ  --limit=N
//
// ⚠ 本番が直ってから（pdfjs-assets.ts のデプロイが READY で、本番ログの property-pickups:record に withText>0・noTextDraw=0 が出てから）--apply する
// ⚠ ローカルで描く。同梱の Noto Sans JP（public/fonts）に置き換えて描くので OS のフォントには逃げないが、--out で数枚を目で確かめてから --apply
// ⚠ 認証情報は環境変数だけ（NEXT_PUBLIC_SUPABASE_URL・SUPABASE_SERVICE_ROLE_KEY か NEXT_PUBLIC_SUPABASE_ANON_KEY・BLOB_READ_WRITE_TOKEN）
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderPdfPageToPng } from "../app/lib/pdf-render";
import { extractPdfText } from "../app/lib/pdf-text";
import { CUSTOMER_PAGE, AGENT_PAGE } from "../app/lib/property-pickups";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const flag = (k: string) => process.argv.includes(`--${k}`);
const APPLY = flag("apply");
const RESET_ANALYSIS = flag("reset-analysis");
const DELETE_OLD = flag("delete-old");
const SINCE = arg("since") ?? "2026-09-24T00:45:00Z";
const IDS = (arg("ids") ?? "").split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
const LIMIT = Number(arg("limit") ?? "500");
const OUT = arg("out");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type Row = { id: number; created_at: string; batch_id: string; rank: number; property_name: string; pdf_blob_url: string | null; page_image_url: string | null; agent_image_url: string | null; pdf_has_text: boolean | null; image_analysis: unknown };

async function main() {
  if (APPLY && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error("--apply には BLOB_READ_WRITE_TOKEN が要る");
  let q = sb.from("property_pickups").select("id, created_at, batch_id, rank, property_name, pdf_blob_url, page_image_url, agent_image_url, pdf_has_text, image_analysis")
    .or("page_image_url.not.is.null,agent_image_url.not.is.null").order("id", { ascending: true }).limit(LIMIT);
  q = IDS.length ? q.in("id", IDS) : q.gte("created_at", SINCE);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  const analyzed = rows.filter((r) => r.image_analysis).length;
  console.log(`対象 ${rows.length}行（${SINCE} 以降・画像あり）／ PDF あり ${rows.filter((r) => r.pdf_blob_url).length} ／ 文字層なし ${rows.filter((r) => !r.pdf_has_text).length} ／ 画像で分析済み ${analyzed}`);
  console.log(APPLY ? `▶ 書き込む（reset-analysis=${RESET_ANALYSIS} delete-old=${DELETE_OLD}）` : "▶ dry-run（書き込まない）");
  if (OUT) mkdirSync(OUT, { recursive: true });
  const { put, del } = APPLY ? await import("@vercel/blob") : { put: null, del: null };
  let ok = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    if (!r.pdf_blob_url) { skipped++; console.log(`  #${r.id} PDF が無い → 飛ばす`); continue; }
    try {
      const res = await fetch(r.pdf_blob_url);
      if (!res.ok) throw new Error(`PDF を取れない HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const [t, p1, p2] = await Promise.all([
        extractPdfText(bytes.slice(), { maxPages: 2, maxChars: 8000 }),
        r.page_image_url ? renderPdfPageToPng(bytes.slice(), { page: CUSTOMER_PAGE, scale: 1.5 }) : Promise.resolve(null),
        r.agent_image_url ? renderPdfPageToPng(bytes.slice(), { page: AGENT_PAGE, scale: 1.5 }) : Promise.resolve(null),
      ]);
      const line = `  #${r.id} 【${r.rank}】${r.property_name}  文字層 ${t.hasText ? `${t.text.length}字` : "なし"}  p1 文字 ${p1?.textDraws ?? "-"}  p2 文字 ${p2?.textDraws ?? "-"}`;
      // 文字層があるのに描いた文字が 0 なら、まだ直っていない（作り直さない）
      if (t.hasText && ((r.page_image_url && !p1?.textDraws) || (r.agent_image_url && !p2?.textDraws))) { failed++; console.log(`${line}  ⚠ 文字が描けていない → 飛ばす`); continue; }
      if (OUT) {
        if (p1) writeFileSync(join(OUT, `pk${r.id}_p1.png`), p1.png);
        if (p2) writeFileSync(join(OUT, `pk${r.id}_p2.png`), p2.png);
      }
      if (!APPLY || !put) { ok++; console.log(`${line}  （dry-run）`); continue; }
      const stamp = Date.now();
      const base = `pickups/${r.batch_id.replace(/\.pdf$/i, "")}_${r.rank}_${stamp}_fix`;
      const up: Record<string, unknown> = { pdf_text: t.text || null, pdf_has_text: t.hasText };
      if (p1) up.page_image_url = (await put(`${base}_p1.png`, p1.png, { access: "public", contentType: "image/png" })).url;
      if (p2) up.agent_image_url = (await put(`${base}_p2.png`, p2.png, { access: "public", contentType: "image/png" })).url;
      if (RESET_ANALYSIS && r.image_analysis) up.image_analysis = null;
      const { error: uErr } = await sb.from("property_pickups").update(up).eq("id", r.id);
      if (uErr) throw new Error(uErr.message);
      if (DELETE_OLD && del) {
        const old = [p1 ? r.page_image_url : null, p2 ? r.agent_image_url : null].filter((u): u is string => !!u);
        if (old.length) await del(old).catch((e) => console.warn(`  #${r.id} 古い Blob を消せない:`, e instanceof Error ? e.message : String(e)));
      }
      ok++;
      console.log(`${line}  ✓ 更新`);
    } catch (e) {
      failed++;
      console.log(`  #${r.id} 失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${APPLY ? "作り直した" : "作り直せる"} ${ok}行 ／ 飛ばした ${skipped} ／ 失敗 ${failed}${OUT ? ` ／ 画像は ${OUT}` : ""}`);
  if (!APPLY && analyzed > 0) console.log(`※ 画像で分析済みの ${analyzed}行は文字の無い画像で出した結果。--apply --reset-analysis で空にして、ボタンを押し直してもらう（DeepSeek 約0.25円/件）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
