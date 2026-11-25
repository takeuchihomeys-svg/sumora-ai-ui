/**
 * 検索確認→並べ替えの時間差監査（竹内さん: 確認後1秒以上）
 *
 *   npx tsx --env-file=.env.local scripts/audit-search-sort-gap.ts
 *   AUDIT_HOURS=48 npx tsx --env-file=.env.local scripts/audit-search-sort-gap.ts
 *
 * 仕組み: 誤った完了（intent だけで sort）や within_1s を数値で見張る。
 * 2.8.207 以降は search_press_ok／screenOk 確認後、confirm→go ≥1000ms が本線。
 */
import { createClient } from "@supabase/supabase-js";

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const HOURS = Number(process.env.AUDIT_HOURS || 72);
  const since = new Date(Date.now() - HOURS * 3600e3).toISOString();

  const { data: audits, error: ae } = await sb
    .from("search_audits")
    .select("id,created_at,mode,ext_version,status,trigger,steps,result")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(120);
  if (ae) throw ae;

  const modeTally: Record<string, number> = {};
  const relTally: Record<string, number> = {};
  const cases: any[] = [];

  for (const row of audits || []) {
    modeTally[String(row.mode)] = (modeTally[String(row.mode)] || 0) + 1;
    const steps = Array.isArray(row.steps) ? (row.steps as any[]) : [];
    if (!steps.length) continue;

    const nameOf = (s: any) => String(s?.k || s?.step || s?.name || "");
    const names = steps.map(nameOf);
    const interesting = names.some((n) =>
      /search|sort|grasp|after_search|armed|human_search/i.test(n),
    );
    if (!interesting) continue;

    let tArmed: number | null = null;
    let tIntent: number | null = null;
    let tPressOk: number | null = null;
    let tScreenOk: number | null = null;
    let tWait: number | null = null;
    let tGo: number | null = null;
    let waitDeclared: number | null = null;
    const stepHits: string[] = [];

    for (const s of steps) {
      const k = nameOf(s);
      const d = String(s?.d || s?.detail || "");
      const t = typeof s?.at === "number" ? s.at : Date.parse(String(s?.at || row.created_at));
      const hit =
        /search|sort|grasp|armed|after_search|human_search|fill_done|gate|wait|confirm/i.test(k);
      if (hit) stepHits.push(k + (d ? ":" + d.slice(0, 36) : ""));

      if (/search_armed|dl:search_armed|page:search_armed/.test(k) && tArmed == null) tArmed = t;
      if (/search_click_直前|grasp_intent|search_customer_grasp_intent|search_grasp_intent_only/.test(k + d) && tIntent == null)
        tIntent = t;
      if (/search_press_ok|search_grasp_confirmed|guide_phase_after_search(?!_screen)|human_search/.test(k) && tPressOk == null)
        tPressOk = t;
      if (/search_customer_grasp_ok|after_search_screen|search_customer_screen_ok/.test(k) && tScreenOk == null)
        tScreenOk = t;
      if (/sort_cursor_wait|sort_wait|search_to_sort|search_confirm_gap/.test(k) && tWait == null) {
        tWait = t;
        const m = d.match(/(\d+)\s*ms/);
        if (m) waitDeclared = Number(m[1]);
      }
      if (/sort_cursor_go|sort_menu|dl:sort_menu|sort_done|sort_hilo/.test(k) && tGo == null) tGo = t;
    }

    const tConfirm = tPressOk ?? tScreenOk ?? null;
    const tEarly = tIntent ?? tArmed ?? null;
    let rel = "n/a";
    let gap: number | null = null;
    let anchor: string | null = null;

    if (tGo != null && tConfirm != null) {
      gap = tGo - tConfirm;
      anchor = tPressOk != null ? "press_ok" : "screen_ok";
      if (gap < 0) rel = "go_before_confirm";
      else if (gap < 1000) rel = "go_within_1s_of_confirm";
      else rel = "go_after_1s_ok";
    } else if (tGo != null && tEarly != null) {
      gap = tGo - tEarly;
      anchor = tIntent != null ? "intent_only" : "armed_only";
      if (gap < 0) rel = "go_before_armed_intent";
      else if (gap < 1000) rel = "go_within_1s_of_armed_intent";
      else rel = "go_after_armed_no_confirm_mark";
    } else if (tGo != null) {
      rel = "go_without_search_mark";
    } else if (tConfirm != null || tEarly != null) {
      rel = "search_mark_no_sort_go";
    } else {
      continue;
    }

    relTally[rel] = (relTally[rel] || 0) + 1;
    cases.push({
      id: String(row.id).slice(0, 8),
      at: row.created_at,
      mode: row.mode,
      ver: row.ext_version,
      status: row.status,
      trigger: row.trigger,
      rel,
      gap_ms: gap,
      anchor,
      wait_declared_ms: waitDeclared,
      has_press_ok: tPressOk != null,
      has_screen_ok: tScreenOk != null,
      has_intent: tIntent != null,
      has_armed: tArmed != null,
      steps: stepHits.slice(0, 28),
    });
  }

  const early = cases.filter((c) =>
    /within_1s|before_confirm|before_armed|without_search|armed_no_confirm/.test(c.rel),
  );

  console.log(
    JSON.stringify(
      {
        since,
        audit_n: (audits || []).length,
        mode_tally: modeTally,
        rel_tally: relTally,
        case_n: cases.length,
        early_n: early.length,
        early_sample: early.slice(0, 18),
        ok_sample: cases.filter((c) => c.rel === "go_after_1s_ok").slice(0, 8),
        recent: cases.slice(0, 12),
        mechanism: "2.8.207 search_confirm_then_wait_sort / false_complete_next_gate",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
