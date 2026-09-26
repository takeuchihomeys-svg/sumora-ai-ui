import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { pendingSourceOrFilter } from "@/app/lib/automation-sources";
import { buildWebBrainCommands, isWebBrainSite, queuedKey, webBrainBlockReason, WEB_BRAIN_SOURCE } from "@/app/lib/web-brain-search";
import { sanitizeSearchOverride } from "@/app/lib/search-override-read";

/**
 * 2026-09-25 竹内「チェックした物の一括検索。拡張ツールでブレインモードに選択していたら連動して検索。ブレインモードのみで連動」「更新日も拡張ツールと連動」:
 *   AIXツールでチェックしたお客様を、1人1コマンドで積む（payload {source:"web_brain", is_wide, rp_update_days}・sites:[site]）。
 *   拾うのは拡張のブレインが ON の PC だけ（/api/automation/pending?brain=1）。更新日はお客様ごと（rp-update-days.ts＝拡張と同じ）。
 *   まだ終わっていない同じお客様・同じサイトの一括検索は積まない（二度押し・2つの画面）
 */
async function queueWebBrain(
  supabase: SupabaseClient,
  body: { customer_ids?: string[]; sites?: string[]; is_wide?: boolean; search_override?: unknown },
): Promise<[Record<string, unknown>, { status: number }]> {
  const site = body.sites?.[0];
  if (!isWebBrainSite(site) || (body.sites?.length ?? 0) !== 1) return [{ ok: false, error: "sites は realnetpro / itandi / reins のどれか1つ" }, { status: 400 }];
  const ids = [...new Set((body.customer_ids ?? []).map((s) => String(s)).filter(Boolean))];
  const block = webBrainBlockReason(ids.length, site);
  if (block) return [{ ok: false, error: block }, { status: 400 }];
  // 2026-09-27 メモ欄の検索の指示（その回だけの一時調整）。関所を通した物だけ payload に入れる（1人だけ・知らない欄は捨てる）
  const searchOverride = body.search_override != null ? sanitizeSearchOverride(body.search_override) : null;
  if (body.search_override != null && ids.length !== 1) return [{ ok: false, error: "一時調整の上書きは1人ずつです" }, { status: 400 }];
  const { data: pcs, error: pcErr } = await supabase
    .from("property_customers")
    .select("id, rp_update_days, last_property_sent_at, property_viewed_at")
    .in("id", ids);
  if (pcErr) return [{ ok: false, error: pcErr.message }, { status: 500 }];
  const byId = new Map(((pcs ?? []) as Array<{ id: string; rp_update_days: number | null; last_property_sent_at: string | null; property_viewed_at: string | null }>).map((p) => [String(p.id), p]));
  const customers = ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  const missing = ids.filter((id) => !byId.has(id));
  // まだ終わっていない同じ検索（直近3時間・pending/running）
  const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data: open, error: openErr } = await supabase
    .from("automation_commands")
    .select("id, customer_ids, sites")
    .in("status", ["pending", "running"])
    .eq("payload->>source", WEB_BRAIN_SOURCE)
    .gte("created_at", since)
    .limit(500);
  if (openErr) return [{ ok: false, error: openErr.message }, { status: 500 }];
  const queued = new Set<string>();
  const openIdOf = new Map<string, string>();
  for (const r of (open ?? []) as Array<{ id: string; customer_ids: string[] | null; sites: string[] | null }>) {
    for (const cid of r.customer_ids ?? []) for (const s of r.sites ?? []) { queued.add(queuedKey(String(cid), s)); openIdOf.set(queuedKey(String(cid), s), r.id); }
  }
  const { rows, skipped } = buildWebBrainCommands(customers, site, !!body.is_wide, { queued, searchOverride });
  let inserted: Array<{ id: string; customer_ids: string[] }> = [];
  if (rows.length > 0) {
    const { data, error } = await supabase.from("automation_commands").insert(rows).select("id, customer_ids");
    if (error) return [{ ok: false, error: error.message }, { status: 500 }];
    inserted = (data ?? []) as Array<{ id: string; customer_ids: string[] }>;
  }
  // 進み具合は積んだ物＋まだ終わっていない同じ検索の両方を見る
  const commandIds = [...inserted.map((r) => r.id), ...skipped.map((cid) => openIdOf.get(queuedKey(cid, site))).filter((v): v is string => !!v)];
  return [{ ok: true, brain: true, site, queued: inserted.length, already: skipped.length, missing: missing.length, commandIds, search_override: searchOverride }, { status: 200 }];
}

export async function POST(req: NextRequest) {
  // 障害修正: SUPABASE_SERVICE_ROLE_KEY 未設定でも空500クラッシュせず anon キーへフォールバック
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { error: "server misconfigured: SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY missing" },
      { status: 500 }
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const body = await req.json() as {
    customer_ids?: string[];
    sites?: string[];
    force?: boolean;
    is_wide?: boolean; // 修正5: 広ボタンのキュー経路伝搬
    /** 2026-09-25 AIXツールの一括検索（ブレインの PC だけが拾う・1人1コマンド） */
    brain?: boolean;
    /** 2026-09-27 メモ欄の検索の指示（その回だけの一時調整・brain:true の時だけ） */
    search_override?: unknown;
  };

  if (body.brain === true) return NextResponse.json(...(await queueWebBrain(supabase, body)));

  const wantIds = JSON.stringify([...(body.customer_ids ?? [])].sort());
  const wantSites = JSON.stringify([...(body.sites ?? ["reins"])].sort());
  const wantWide = !!body.is_wide;

  // 修正6: force:true でも同一 customer_ids + sites + is_wide の直近5分内コマンドはデデュープ。
  // 拡張入りPCでWebApp操作すると即時経路とキュー経路が両方走り、同一顧客に
  // 検索・AI採点・LINE送信が2回発生するのを防ぐ最終防衛線。
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("automation_commands")
    .select("id, customer_ids, sites, payload")
    .eq("command_type", "batch_property_search")
    .not("status", "eq", "cancelled")  // cancelledはデデュープ対象外（ストップ後の再検索を通す）
    .gte("created_at", fiveMinAgo)
    .order("created_at", { ascending: false })
    .limit(20);

  const dup = (recent ?? []).find((r) => {
    const rIds = JSON.stringify([...((r.customer_ids as string[] | null) ?? [])].sort());
    const rSites = JSON.stringify([...((r.sites as string[] | null) ?? [])].sort());
    const rWide = !!(r.payload as { is_wide?: boolean } | null)?.is_wide;
    return rIds === wantIds && rSites === wantSites && rWide === wantWide;
  });
  if (dup) {
    return NextResponse.json({ ok: true, commandId: dup.id, deduped: true });
  }

  if (!body.force) {
    // AIX 由来（payload.source="aix"・AIXモードのPC待ち）のコマンドは再利用しない（別物）
    // 2026-09-25: 拾い手の決まっている物（AIX・自動便・AIXツールの一括検索 web_brain）は再利用しない（automation-sources.ts）
    const { data: existing } = await supabase
      .from("automation_commands")
      .select("id, status")
      .in("status", ["pending", "running"])
      .or(pendingSourceOrFilter({ aix: false, brain: false }) ?? "payload->>source.is.null")
      // 2026-09-25 反証: 一括検索だけ・直近3時間だけ。8月の scrape_and_compare が picked_up_at 空の running で6件残っており、
      //   これを「今動いている物」として返すと、押しても何も積まれない（静かに壊れる）
      .eq("command_type", "batch_property_search")
      .gte("created_at", new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (existing && existing.length > 0) {
      return NextResponse.json({ ok: true, commandId: existing[0].id, reused: true });
    }
  }

  const { data, error } = await supabase
    .from("automation_commands")
    .insert({
      command_type: "batch_property_search",
      customer_ids: body.customer_ids ?? null,
      sites: body.sites ?? ["reins"],
      // 修正5: is_wide を payload に保存（拡張側 _runBatchSearch が参照する）
      payload: { is_wide: wantWide },
      status: "pending",
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, commandId: data.id });
}
