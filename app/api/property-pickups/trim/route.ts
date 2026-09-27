// POST /api/property-pickups/trim  { item_ids: number[] } または { images: [{ id, jpeg_base64 }] }
// 選んだ物件の PDF 1ページ目（奇数ページ＝弊社帯の面）を**そのまま**画像にして Blob に置き、property_pickups.trim_image_url に残す。
// お客様に送る画像（AIX【物件ピックアップ】【物件オススメ】・💾 画像保存）はこの画像だけ（pickSendImageUrl・pickup-send-image.ts）。
// 2026-09-24 竹内「画像トリミングボタンを付ける。押すと選択している物件の PDF 1枚目がトリミングされて画像となって送られる」
// 2026-09-27 竹内「物件はいま文字とか入れなおしてるけど、そのままの画像つかったら大丈夫」:
//   切り取らない（ページ全体）。サーバーの予備は「資料の書体のまま描けた時だけ」（itandi＝書体の埋め込みあり）。
//   リアプロの資料（MS ゴシックの埋め込みなし）はサーバーで描くと Noto Sans JP に全部の文字を差し替えるので作らない（画面＝スタッフのパソコンで描く）。
//   旧は page_image_url（サーバーが差し替えて描いた画像）を元に切っていた道もあった → 消した
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { renderPdfPageToPng } from "@/app/lib/pdf-render";
import { trimSheetImage } from "@/app/lib/pdf-trim";
import { SEND_PAGE, serverRenderIsOriginal } from "@/app/lib/pickup-send-image";

export const maxDuration = 60;
const MAX_ITEMS = 10;

type Row = { id: number; batch_id: string; pdf_blob_url: string | null; page_image_url: string | null; trim_image_url: string | null };

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  // images: 画面（スタッフのパソコン）で元の資料を描いて切った JPEG（base64）。あればそれを置くだけ（主経路・元の資料と同じ見た目）
  //   2026-09-24 竹内「元の物件資料をトリミングすれば良いだけ」。サーバーで描く道（下）は画面側が使えない時の予備
  const body = await req.json().catch(() => ({})) as { item_ids?: number[]; force?: boolean; images?: Array<{ id: number; jpeg_base64: string }> };
  const images = Array.isArray(body.images) ? body.images.filter((x) => Number.isFinite(x?.id) && typeof x?.jpeg_base64 === "string" && x.jpeg_base64.length > 100).slice(0, MAX_ITEMS) : [];
  const ids = images.length > 0 ? images.map((x) => x.id) : Array.isArray(body.item_ids) ? body.item_ids.filter((n) => Number.isFinite(n)).slice(0, MAX_ITEMS) : [];
  if (ids.length === 0) return NextResponse.json({ ok: false, error: "item_ids か images が要ります" }, { status: 400 });

  const { data, error } = await supabase.from("property_pickups").select("id, batch_id, pdf_blob_url, page_image_url, trim_image_url").in("id", ids);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const rows = (data ?? []) as Row[];
  const { put } = await import("@vercel/blob");
  const stamp = Date.now();

  if (images.length > 0) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const results = await Promise.all(images.map(async (im) => {
      const r = byId.get(im.id);
      if (!r) return { id: im.id, trim_image_url: null, error: "行が無い" };
      try {
        const jpeg = Buffer.from(im.jpeg_base64, "base64");
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return { id: im.id, trim_image_url: null, error: "JPEG ではない" };
        const blob = await put(`pickups/trim/${r.batch_id.replace(/\.pdf$/i, "")}_${r.id}_${stamp}.jpg`, jpeg, { access: "public", contentType: "image/jpeg" });
        const { error: uErr } = await supabase.from("property_pickups").update({ trim_image_url: blob.url }).eq("id", r.id);
        if (uErr) console.warn("[property-pickups/trim] 保存できない:", uErr.message);
        return { id: r.id, trim_image_url: blob.url, source: "browser" };
      } catch (e) {
        return { id: im.id, trim_image_url: null, error: e instanceof Error ? e.message : String(e) };
      }
    }));
    const okCount = results.filter((x) => x.trim_image_url).length;
    console.log(JSON.stringify({ tag: "property-pickups:trim", source: "browser", requested: images.length, ok: okCount }));
    return NextResponse.json({ ok: okCount > 0, items: results, trimmed: okCount });
  }

  const results = await Promise.all(rows.map(async (r) => {
    if (r.trim_image_url && !body.force) return { id: r.id, trim_image_url: r.trim_image_url, reused: true };
    try {
      // 元は PDF（Blob）だけ。page_image_url（書体を差し替えて描いた画像）からは作らない
      if (!r.pdf_blob_url) return { id: r.id, trim_image_url: null, error: "元の資料（PDF）が無い" };
      const res = await fetch(r.pdf_blob_url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { id: r.id, trim_image_url: null, error: `資料を取れない（HTTP ${res.status}）` };
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      const png = await renderPdfPageToPng(b64, { page: SEND_PAGE, scale: 2, maxPixels: 4_000_000 });
      if (!png) return { id: r.id, trim_image_url: null, error: "資料を画像にできない" };
      if (!serverRenderIsOriginal(png.textDraws)) {
        return { id: r.id, trim_image_url: null, error: "資料の書体（MS ゴシック）がサーバーに無く、元の資料と同じ文字で画像にできません。パソコンで開いて押してください", font_missing: true };
      }
      // JPEG にするだけ（keepRatio 1＝切り取らない）
      const trimmed = await trimSheetImage(png.png, { keepRatio: 1 });
      if (!trimmed) return { id: r.id, trim_image_url: null, error: "画像にできない" };
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
