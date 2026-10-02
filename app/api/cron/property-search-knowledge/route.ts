// GET /api/cron/property-search-knowledge  （Vercel Cron・毎週月曜 JST 4:20＝日曜 19:20 UTC）
//   ?dry=1 … 数えるだけ（DB に書かない）
// 物件検索の整理済みの知識（property_search_knowledge）を作り直して整理する（決定論・LLM なし・費用0）:
//   希望の駅・区 → スタッフが実際にお客様へ届けた駅・区（人数・申込に進んだ人）／エリアの言い直し／区のまとめ（相場・電車の最短・届け先）
//   → 統合・退役（消さない）・食い違い（届け先の1番の駅の入れ替わり）・読まれない物の報告
// 2026-10-02 竹内「物件検索のところちゃんと知識積み重なるようになっているのか」「知識溜まってもちゃんと整理するような環境もつくる」（⑯ 手順5）
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { runKnowledgeCycle } from "@/app/lib/property-search-knowledge-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const logId = dry ? null : await startCronLog("property-search-knowledge");
  try {
    const r = await runKnowledgeCycle(supabase, { dry });
    await finishCronLog(logId, true, r);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
