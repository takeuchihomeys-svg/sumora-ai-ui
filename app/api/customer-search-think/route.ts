/**
 * POST /api/customer-search-think
 * 客ごとの検索思考（決定論・LLMなし・費用0）
 * 拡張が fill 直前に呼ぶ。失敗しても検索は止めない（fail-open）。
 */
import { NextRequest, NextResponse } from "next/server";
import { thinkCustomerSearch } from "@/app/lib/customer-search-think";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 5;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const think = thinkCustomerSearch({
      customerId: body.customer_id != null ? String(body.customer_id) : null,
      areaMode: body.area_mode != null ? String(body.area_mode) : null,
      desiredArea: body.desired_area != null ? String(body.desired_area) : null,
      prevCid: body.prev_cid != null ? String(body.prev_cid) : null,
      prevWantMode: body.prev_want_mode != null ? String(body.prev_want_mode) : null,
      playbookSeenRv: body.playbook_seen_rv != null ? String(body.playbook_seen_rv) : null,
      codePlaybookRv: body.code_playbook_rv != null ? String(body.code_playbook_rv) : null,
    });
    return NextResponse.json({ ok: true, think });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
