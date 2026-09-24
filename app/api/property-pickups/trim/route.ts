// POST /api/property-pickups/trim  { item_ids: number[] }
// 選んだ物件の PDF 1ページ目（弊社に帯替えした面）を、お客様に実際に送っている形（下の会社の帯を落とす）にトリミングして
// Blob に置き、property_pickups.trim_image_url に残す。送る時（/send）はこの画像を優先して使う。
// 2026-09-24 竹内「画像トリミングボタンを付ける。押すと選択している物件の PDF 1枚目がトリミングされて画像となって送られる」
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { renderPdfPageToPng } from "@/app/lib/pdf-render";
import { trimSheetImage } from "@/app/lib/pdf-trim";
import { CUSTOMER_PAGE } from "@/app/lib/property-pickups";

export const maxDuration = 60;
const MAX_ITEMS = 10;

type Row = { id: number; batch_id: string; pdf_blob_url: string | null; page_image_url: string | null; trim_image_url: string | null };

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = await req.json().catch(() => ({})) as { item_ids?: number[]; force?: boolean };
  const ids = Array.isArray(body.item_ids) ? body.item_ids.filter((n) => Number.isFinite(n)).slice(0, MAX_ITEMS) : [];
  if (ids.length === 0) return NextResponse.json({ ok: false, error: "item_ids が要ります" }, { status: 400 });

  const { data, error } = await supabase.from("property_pickups").select("id, batch_id, pdf_blob_url, page_image_url, trim_image_url").in("id", ids);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const rows = (data ?? []) as Row[];
  const { put } = await import("@vercel/blob");
  const stamp = Date.now();

  const results = await Promise.all(rows.map(async (r) => {
    if (r.trim_image_url && !body.force) return { id: r.id, trim_image_url: r.trim_image_url, reused: true };
    try {
      // 元は PDF（Blob）。無ければ1ページ目の画像から切る
      let source: Buffer | null = null;
      if (r.pdf_blob_url) {
        const res = await fetch(r.pdf_blob_url, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
          const png = await renderPdfPageToPng(b64, { page: CUSTOMER_PAGE, scale: 2, maxPixels: 4_000_000 });
          if (png) source = png.png;
        }
      }
      if (!source && r.page_image_url) {
        const res = await fetch(r.page_image_url, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) source = Buffer.from(await res.arrayBuffer());
      }
      if (!source) return { id: r.id, trim_image_url: null, error: "資料の画像を作れない（PDF も画像も無い）" };
      const trimmed = await trimSheetImage(source);
      if (!trimmed) return { id: r.id, trim_image_url: null, error: "トリミングに失敗" };
      const blob = await put(`pickups/trim/${r.batch_id.replace(/\.pdf$/i, "")}_${r.id}_${stamp}.jpg`, trimmed.jpeg, { access: "public", contentType: "image/jpeg" });
      const { error: uErr } = await supabase.from("property_pickups").update({ trim_image_url: blob.url }).eq("id", r.id);
      if (uErr) console.warn("[property-pickups/trim] 保存できない:", uErr.message);
      return { id: r.id, trim_image_url: blob.url, width: trimmed.width, height: trimmed.height };
    } catch (e) {
      return { id: r.id, trim_image_url: null, error: e instanceof Error ? e.message : String(e) };
    }
  }));
  const okCount = results.filter((x) => x.trim_image_url).length;
  console.log(JSON.stringify({ tag: "property-pickups:trim", requested: ids.length, ok: okCount, errors: results.filter((x) => "error" in x && x.error).map((x) => (x as { error?: string }).error) }));
  return NextResponse.json({ ok: okCount > 0, items: results, trimmed: okCount });
}
