// GET /api/property-pickups/prerender
// パソコン（拡張・MS ゴシックあり）が「お客様に送る画像」を先に作っておく行の一覧。
// 2026-09-27 竹内「なぜ送れないのか？画像をそのままの蓮産業の画像で保存していたらそのまま使える。ここちゃんとできるようにする」:
//   リアプロの資料は MS ゴシックを埋め込んでいないので、元の見た目の画像は Windows の Chrome でしか作れない（サーバー・iPhone では作らない）。
//   → 資料が届いた後にパソコンの拡張が裏で /pickup-prerender を開き、この一覧の行を描いて /api/property-pickups/trim（images）に置く。
//     スマホで AIX を押した時は保存済みの trim_image_url をそのまま使う（PickupReview の noImage は画像のある行を描かない）。
//   ?count=1 … 数だけ（認証なし・拡張の background が「作る物があるか」を見るだけ。行の中身は返さない）
//   それ以外 … 行（id・pdf_blob_url・物件名）。内部認証が要る。?ids=1,2 で行を指定・?limit=
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { needsPrerender, PRERENDER_MAX_AGE_DAYS, PRERENDER_BATCH } from "@/app/lib/pickup-send-image";

export const dynamic = "force-dynamic";

type Row = { id: number; created_at: string; status: string; expired_at: string | null; pdf_blob_url: string | null; trim_image_url: string | null; property_name: string; room_no: string | null; site: string | null };

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const countOnly = sp.get("count") === "1";
  if (!countOnly) {
    const authError = requireInternalAuth(req);
    if (authError) return authError;
  }
  const ids = (sp.get("ids") ?? "").split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 50);
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? PRERENDER_BATCH) || PRERENDER_BATCH, 1), 30);
  const since = new Date(Date.now() - PRERENDER_MAX_AGE_DAYS * 86_400_000).toISOString();
  let q = supabase.from("property_pickups")
    .select("id, created_at, status, expired_at, pdf_blob_url, trim_image_url, property_name, room_no, site")
    .is("trim_image_url", null).not("pdf_blob_url", "is", null).eq("status", "pending");
  q = ids.length > 0 ? q.in("id", ids) : q.gte("created_at", since);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(300);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const now = Date.now();
  // ids 指定の時は日数で切らない（スクリプト・手で埋める時）
  const rows = ((data ?? []) as Row[]).filter((r) => ids.length > 0 ? !!r.pdf_blob_url && !r.trim_image_url && r.status === "pending" && !r.expired_at : needsPrerender(r, now));
  if (countOnly) return NextResponse.json({ ok: true, count: rows.length }, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({
    ok: true, count: rows.length,
    items: rows.slice(0, limit).map((r) => ({ id: r.id, pdf_blob_url: r.pdf_blob_url, property_name: r.property_name, room_no: r.room_no, site: r.site })),
  }, { headers: { "Cache-Control": "no-store" } });
}
