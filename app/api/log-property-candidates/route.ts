import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { enrichCandidate, clipRawForStorage, FACTS_VERSION } from "@/app/lib/candidate-facts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const maxDuration = 10;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { property_customer_id, customer_name, site, candidates } = body as {
      property_customer_id?: string | null;
      customer_name?: string | null;
      site?: string | null;
      // 2026-09-25: 拡張は家賃・管理費・敷礼・間取り・㎡・築年月・駅と徒歩・所在地・号室・AD・資料URL と生の文字（cells/bld_text/summary）も付けてくる
      candidates: Array<Record<string, unknown> & { rank: number; name: string }>;
    };

    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
      return NextResponse.json({ ok: false, error: "candidates required" }, { status: 400, headers: CORS });
    }

    // 2026-09-25 竹内「候補の記憶を太くする」: 1件ごとに、拡張の値が無い項目を同じ1件の生の文字から埋める（candidate-facts.ts・純関数）。
    //   既存の鍵（rent・floor_plan・walk_minutes・ad_months・ad_yen）の名前と意味は変えない。読めなくても記録は止めない（元のまま入れる）
    let rows: unknown[] = candidates;
    try {
      rows = candidates.map((c) => clipRawForStorage(enrichCandidate(c)));
    } catch (e) {
      console.warn("[log-property-candidates] enrich failed:", e instanceof Error ? e.message : e);
    }
    const insert = (withVersion: boolean) => supabase.from("property_candidate_pools").insert({
      property_customer_id: property_customer_id || null,
      customer_name: customer_name || null,
      site: site || null,
      candidates: rows,
      ...(withVersion ? { facts_version: FACTS_VERSION } : {}),
    });
    let { error } = await insert(true);
    // 列 facts_version がまだ無い DB（migrate 前）でも記録は残す
    if (error && /facts_version/.test(error.message)) ({ error } = await insert(false));

    if (error) throw error;

    return NextResponse.json({ ok: true, count: candidates.length }, { headers: CORS });
  } catch (e) {
    console.error("[log-property-candidates]", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: CORS }
    );
  }
}
