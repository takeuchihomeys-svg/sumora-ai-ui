// app/api/portal-page-read — お客様が送った SUUMO の URL のページを読む（建物名・家賃・間取り・駅・掲載終了）。LLM なし・決定論の HTML の読み
// 2026-10-14 竹内さん「SUUMO を送ってきた時に中身を読む仕組み…読めていない所をつなぐ」。読み方は app/lib/portal-page-read.ts。
//   1回で開くのは最大3件・1件ずつ（続けて開くと断られる）・同じ URL は 1時間覚える。戻す: PORTAL_PAGE_READ=off
import { NextResponse } from "next/server";
import { readPortalPage, portalPageReadEnabled, portalSiteOf } from "@/app/lib/portal-page-read";

export const maxDuration = 30;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { urls?: unknown } | null;
  const urls = (Array.isArray(body?.urls) ? body!.urls : []).map((u) => String(u ?? "")).filter((u) => portalSiteOf(u) === "suumo").slice(0, 3);
  if (!portalPageReadEnabled() || !urls.length) return NextResponse.json({ pages: [] });
  const pages = [];
  for (const u of urls) pages.push(await readPortalPage(u));
  console.log(JSON.stringify({ tag: "portal-page-read", n: pages.length, statuses: pages.map((p) => p.status), named: pages.filter((p) => p.name).length }));
  return NextResponse.json({ pages });
}
