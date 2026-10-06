import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { pendingSourceOrFilter } from "@/app/lib/automation-sources";
import { buildWebBrainCommands, normalizeWebBrainSites, planWebBrainFold, queuedKey, webBrainBlockReason, WEB_BRAIN_SOURCE, type PendingWebBrain } from "@/app/lib/web-brain-search";
import { sanitizeSearchOverride } from "@/app/lib/search-override-read";
import { planPayload } from "@/app/lib/search-update-days";
import { planUpdateDaysFor } from "@/app/lib/search-update-days-server";
import { claimInstallId } from "@/app/lib/extension-snapshots";

/**
 * 2026-09-25 竹内「チェックした物の一括検索。拡張ツールでブレインモードに選択していたら連動して検索。ブレインモードのみで連動」「更新日も拡張ツールと連動」:
 *   AIXツールでチェックしたお客様を、1人1コマンドで積む（payload {source:"web_brain", is_wide, rp_update_days}・sites:[site]）。
 *   拾うのは拡張のブレインが ON の PC だけ（/api/automation/pending?brain=1）。更新日はお客様ごと（rp-update-days.ts＝拡張と同じ）。
 *   まだ終わっていない同じお客様・同じサイトの一括検索は積まない（二度押し・2つの画面）
 */
async function queueWebBrain(
  supabase: SupabaseClient,
  body: { customer_ids?: string[]; sites?: string[]; is_wide?: boolean; search_override?: unknown; target_install?: string },
): Promise<[Record<string, unknown>, { status: number }]> {
  // 2026-09-30 v2.5.42 竹内「リアプロと itandi、お客さんそれぞれ同時に完了するようにする」: リアプロ＋itandi の2つを1人1コマンドに載せてよい
  const sites = normalizeWebBrainSites(body.sites ?? null);
  if (!sites) return [{ ok: false, error: "sites は realnetpro / itandi / reins のどれか1つ、または realnetpro と itandi の2つ" }, { status: 400 }];
  const site = sites[0];
  const ids = [...new Set((body.customer_ids ?? []).map((s) => String(s)).filter(Boolean))];
  const block = webBrainBlockReason(ids.length, sites);
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
  const { rows, skipped } = buildWebBrainCommands(customers, sites, !!body.is_wide, { queued, searchOverride });
  // 2026-10-07 竹内（H0N0KA.「家賃が更に5,000円程低いお部屋が見つかれば決まる…もっと明確に物件検索をする事が出来る」）:
  //   メモ欄の指示（searchOverride）が無い時だけ、会話から作った決め手の条件（closing-target）をその回だけの上書きにする（登録の条件は変えない）。
  //   まだ見つかっていない（active・partial）像だけ・サイトで絞れる欄（家賃・間取り・広さ・徒歩・築年・階）だけ。CLOSING_TARGET_MODE=off で止める
  if (!searchOverride && rows.length > 0) {
    try {
      const { loadClosingTargetState } = await import("@/app/lib/closing-target-server");
      const { closingSearchOverride } = await import("@/app/lib/closing-target");
      for (const r of rows) {
        const cid = r.customer_ids[0];
        const st = await loadClosingTargetState(supabase, { propertyCustomerId: cid });
        if (!st || st.status === "found") continue;
        const { data: cur } = await supabase.from("property_customers").select("rent_max, floor_plan, floor_area_min, walk_minutes, building_age, desired_area, preferences, area_mode").eq("id", cid).maybeSingle();
        const ov = cur ? sanitizeSearchOverride(closingSearchOverride(st.target, cur as never)) : null;
        if (!ov) continue;
        (r.payload as Record<string, unknown>).search_override = ov;
        (r.payload as Record<string, unknown>).closing_target = { v: st.target.v, kind: st.target.kind, status: st.status, rationale: st.target.rationale };
      }
    } catch (e) { console.warn("[automation/trigger] 決め手の条件を載せられない（登録の条件のまま）:", e instanceof Error ? e.message : String(e)); }
  }
  // 2026-09-29 v2.5.41 更新日: 今までの決まり（rp-update-days）を、前回の検索（このサイトで最後に終わった回）から空いた時間を覆う所まで広げる。
  //   拡張は payload.update_days_plan の値を popup の経路でも使う（旧は popup が payload を見ず、その場の決まりで入れていた）。レインズは更新日なし
  if (rows.length > 0 && site !== "reins") {
    try {
      const plans = await planUpdateDaysFor(supabase, rows.map((r) => ({ id: r.customer_ids[0], baseDays: r.payload.rp_update_days })), sites.filter((x) => x !== "reins"));
      const byPlan = new Map(plans.map((x) => [x.id, x.plan]));
      for (const r of rows) {
        const plan = byPlan.get(r.customer_ids[0]);
        if (!plan) continue;
        r.payload.rp_update_days = plan.days;
        (r.payload as Record<string, unknown>).update_days_plan = planPayload([{ id: r.customer_ids[0], plan }]);
      }
    } catch (e) { console.warn("[automation/trigger] 更新日の計画を作れない（今までの決まり）:", e instanceof Error ? e.message : String(e)); }
  }
  // 2026-09-30 v2.5.42 リアプロを押した後に itandi を押した時: まだ拾われていない同じお客様の命令に itandi を足す（1人ずつ両サイトを続けて回す）。
  //   足すのは pending の間だけ（条件付き UPDATE・拾われた後は新しく積む）
  // 2026-09-30 拾う PC の指定（テスト用・1人の時だけ）: payload.target_install の PC にだけ渡す（pending の notForThisInstall）
  const targetInstall = ids.length === 1 ? claimInstallId(body.target_install ?? null) : null;
  if (targetInstall) for (const r of rows) (r.payload as Record<string, unknown>).target_install = targetInstall;
  let folded = 0;
  let toInsert = rows;
  const foldedIds: string[] = [];
  if (rows.length > 0 && site !== "reins") {
    const pend = await supabase.from("automation_commands").select("id, customer_ids, sites, payload")
      .eq("status", "pending").eq("payload->>source", WEB_BRAIN_SOURCE).gte("created_at", since).limit(200);
    if (!pend.error) {
      const plan = planWebBrainFold(rows, (pend.data ?? []) as PendingWebBrain[]);
      const failed = new Set<string>();
      for (const f of plan.fold) {
        const u = await supabase.from("automation_commands").update({ sites: f.sites }).eq("id", f.commandId).eq("status", "pending").select("id");
        if (u.error || !u.data?.length) failed.add(f.customerId); else { folded++; foldedIds.push(f.commandId); }
      }
      toInsert = [...plan.insert, ...rows.filter((r) => failed.has(r.customer_ids[0]))];
    }
  }
  let inserted: Array<{ id: string; customer_ids: string[] }> = [];
  if (toInsert.length > 0) {
    const { data, error } = await supabase.from("automation_commands").insert(toInsert).select("id, customer_ids");
    if (error) return [{ ok: false, error: error.message }, { status: 500 }];
    inserted = (data ?? []) as Array<{ id: string; customer_ids: string[] }>;
  }
  // 進み具合は積んだ物＋まだ終わっていない同じ検索の両方を見る
  const commandIds = [...inserted.map((r) => r.id), ...foldedIds, ...skipped.map((cid) => openIdOf.get(queuedKey(cid, site))).filter((v): v is string => !!v)];
  return [{ ok: true, brain: true, site, sites, queued: inserted.length + folded, folded, already: skipped.length, missing: missing.length, commandIds, search_override: searchOverride }, { status: 200 }];
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

  // 2026-10-02 v2.5.69: 一時停止中（automation_settings.paused）は積まない（再開した瞬間に溜まった分がまとめて走らないように）。
  //   他の積む口（AIX・見張り・広げて・cron）の分は /api/automation/pending が一時停止中に取り消す
  {
    const { data: st } = await supabase.from("automation_settings").select("paused").eq("id", 1).maybeSingle();
    if ((st as { paused?: boolean } | null)?.paused) {
      return NextResponse.json({ ok: false, paused: true, error: "自動の物件検索は一時停止中です（拡張の画面から手で検索してください）" }, { status: 409 });
    }
  }

  const body = await req.json() as {
    customer_ids?: string[];
    sites?: string[];
    force?: boolean;
    is_wide?: boolean; // 修正5: 広ボタンのキュー経路伝搬
    /** 2026-09-25 AIXツールの一括検索（ブレインの PC だけが拾う・1人1コマンド） */
    brain?: boolean;
    /** 2026-09-27 メモ欄の検索の指示（その回だけの一時調整・brain:true の時だけ） */
    search_override?: unknown;
    /** 2026-09-30 拾う PC の指定（テスト用・brain:true で1人の時だけ） */
    target_install?: string;
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
