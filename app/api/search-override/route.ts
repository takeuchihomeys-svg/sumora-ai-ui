// POST /api/search-override { text, property_customer_id? }
// メモ欄（AIXツール）の文が検索の指示なら、DeepSeek の物件検索 AI が「一時調整」の形に要約して返す（積むのは画面の［実行］→ /api/automation/trigger）。
// 2026-09-27 竹内「『大正駅で検索する』なら駅は大正駅だけで検索、『1LDKで検索する』なら1LDKで検索。拡張ツールの一時調整の部分で合わせる形。
//   こちらからの文を DeepSeek の物件検索 AI が要約して、拡張ツールに渡す形。ゆくゆくは拡張ツールの AIX モードで使えるようにしていく」
// 要約の1か所（将来の拡張の AIX モードも同じ口を使う）。DB には書かない（読むのはお客様の登録の条件の欄だけ）。
// 内部認証（DeepSeek を呼ぶので誰でも叩ける口にしない）。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { overrideLine, isEmptyOverride, mergeSearchOverride, type RegisteredConditions } from "@/app/lib/search-override";
import { summarizeSearchMemo } from "@/app/lib/search-override-server";
import { loadPreviousSearchOverride } from "@/app/lib/search-override-history";

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
  // 2026-11-10 竹内さん「拡張ツールのところも前の条件いれて。AIXツールも前の条件だと理解できればより使いやすい。最新が一番優先される」
  //   前の回の条件（30日以内・一番新しい物）に、今回読んだ条件を重ねる。書いていない欄は前の物を残し、書いた欄は今回の値で置き換える。
  //   前の条件が無ければ今まで通り（今回読んだ条件だけ）。merge が null なら今まで通り override をそのまま返す
  const prev = r.is_search && body.property_customer_id
    ? await loadPreviousSearchOverride(supabase, String(body.property_customer_id)).catch(() => null)
    : null;
  const merged = r.is_search ? (mergeSearchOverride(prev?.override ?? null, r.override) ?? r.override) : r.override;
  return NextResponse.json({
    ok: true,
    is_search: r.is_search,
    override: merged ?? r.override,
    /** 今回の文から読んだ分だけ（前の条件は入っていない・画面の「今回の指示」に使う） */
    override_now: r.override,
    /** 前の回の条件（無ければ null） */
    previous: prev ? { override: prev.override, at: prev.at, from: prev.from } : null,
    empty: isEmptyOverride(merged ?? r.override),
    unclear: r.unclear,
    dropped: r.dropped,
    ai: r.ai,
    line: r.is_search ? overrideLine(merged ?? r.override, reg) : null,
    registered: reg,
  });
}
