// POST /api/search-override { text, property_customer_id? }
// メモ欄（AIXツール）の文が検索の指示なら、DeepSeek の物件検索 AI が「一時調整」の形に要約して返す（積むのは画面の［実行］→ /api/automation/trigger）。
// 2026-09-27 竹内「『大正駅で検索する』なら駅は大正駅だけで検索、『1LDKで検索する』なら1LDKで検索。拡張ツールの一時調整の部分で合わせる形。
//   こちらからの文を DeepSeek の物件検索 AI が要約して、拡張ツールに渡す形。ゆくゆくは拡張ツールの AIX モードで使えるようにしていく」
// 要約の1か所（将来の拡張の AIX モードも同じ口を使う）。DB には書かない（読むのはお客様の登録の条件の欄だけ）。
// 内部認証（DeepSeek を呼ぶので誰でも叩ける口にしない）。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { overrideLine, isEmptyOverride, type RegisteredConditions } from "@/app/lib/search-override";
import { summarizeSearchMemo } from "@/app/lib/search-override-server";

export const maxDuration = 30;

const REG_COLS = "id, desired_area, area_mode, rent_max, rent_min, floor_plan, walk_minutes, building_age, floor_area_min, floor_area_max, pet";

export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as { text?: string; property_customer_id?: string | null };
  const text = String(body.text ?? "").trim();
  if (!text) return NextResponse.json({ ok: false, error: "text が要ります" }, { status: 400 });
  let reg: RegisteredConditions | null = null;
  if (body.property_customer_id) {
    const { data, error } = await supabase.from("property_customers").select(REG_COLS).eq("id", String(body.property_customer_id)).maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ ok: false, error: "お客様の条件が見つかりません" }, { status: 404 });
    const { id: _id, ...rest } = data as Record<string, unknown>;
    void _id;
    reg = rest as RegisteredConditions;
  }
  const r = await summarizeSearchMemo(text, reg);
  return NextResponse.json({
    ok: true,
    is_search: r.is_search,
    override: r.override,
    empty: isEmptyOverride(r.override),
    unclear: r.unclear,
    dropped: r.dropped,
    ai: r.ai,
    line: r.is_search ? overrideLine(r.override, reg) : null,
    registered: reg,
  });
}
