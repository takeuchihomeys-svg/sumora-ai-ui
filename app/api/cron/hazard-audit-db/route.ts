// app/api/cron/hazard-audit-db/route.ts — 危ない所の見張り（scripts/hazard-audit.ts）のうち、本番のサーバーで見られる分だけを毎晩回す（読むだけ・LLM なし・費用0）
//
// 2026-11-05 竹内さん（KB P1 95f492fc ⑤「危ない所の見張りを毎晩自動で回す」はい）・統括役の決定（2つに分ける）:
//   ここ（Vercel の cron）＝ DB の分 (d) publication の行の条件の列・(m) 相場の観測の trigger・(h) 分からない事の3つの表 と (e) 本番の LP の「◯月実績」。
//   手元の PC の分（作業ツリー・node_modules のリンク・試験の係のログ・git・手元の problems.json）は試験の係（scripts/exam-conductor.ts --run）が夜1回 hazard-audit --save を回す。
//   見つけ方は scripts の純関数をそのまま使う（同じ物差し）。結果は cron_run_logs（cron_name=hazard-audit-db）の result_json に1行のまとめと詳しい所。
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { rowFilterMissingCols, lpMonthOk, unknownsOpenLine } from "../../../../scripts/lib/hazard-audit-core";
import { pickupTriggerStillSkips } from "../../../../scripts/lib/exam-pickup-copy";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

type Check = { key: string; ok: boolean | null; line: string; detail: string[] };

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if ((process.env.HAZARD_AUDIT_CRON ?? "").trim().toLowerCase() === "off") return NextResponse.json({ ok: true, skipped: "HAZARD_AUDIT_CRON=off" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const logId = await startCronLog("hazard-audit-db");
  const checks: Check[] = [];
  try {
    // (d) publication の行の条件の列が replica identity に入っているか
    {
      const sql = `select pt.tablename, pt.rowfilter, c.relreplident,
        coalesce((select array_agg(a.attname::text) from pg_index ix join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)
          where ix.indrelid = c.oid and ((c.relreplident = 'd' and ix.indisprimary) or (c.relreplident = 'i' and ix.indisreplident))), '{}') as idcols
        from pg_publication_tables pt join pg_class c on c.relname = pt.tablename join pg_namespace n on n.oid = c.relnamespace and n.nspname = pt.schemaname
        where pt.rowfilter is not null`;
      const { data, error } = await sb.rpc("exec_sql", { sql });
      if (error) checks.push({ key: "d", ok: null, line: `publication の条件の列: 不明（${error.message.slice(0, 60)}）`, detail: [] });
      else {
        const rows = (Array.isArray(data) ? data : []) as Array<{ tablename: string; rowfilter: string; relreplident: string; idcols: string[] }>;
        const bad = rows.map((r) => ({ r, miss: rowFilterMissingCols(r.rowfilter, r.relreplident, r.idcols) })).filter((x) => x.miss.length);
        checks.push({ key: "d", ok: bad.length === 0, line: `publication の行の条件 ${rows.length}表（条件の列が replica identity に無い ${bad.length}）`,
          detail: bad.map((x) => `${x.r.tablename}: 無い列 ${x.miss.join(",")}（identity=${x.r.relreplident}）`) });
      }
    }
    // (m) 試験の写しの property_pickups を相場の観測に通さない前提が trigger の定義のままか
    {
      const sql = `select (select pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'property_pickups' and t.tgname = 'rent_observe_pickup_trg') as trg,
        (select pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'rent_observe_pickup_apply' limit 1) as fn`;
      const { data, error } = await sb.rpc("exec_sql", { sql });
      const row = (Array.isArray(data) ? data[0] : null) as { trg: string | null; fn: string | null } | null;
      if (error || !row) checks.push({ key: "m", ok: null, line: `相場の観測の trigger: 不明（${(error?.message ?? "行なし").slice(0, 60)}）`, detail: [] });
      else {
        const v = pickupTriggerStillSkips(row.trg ?? "", row.fn ?? "");
        checks.push({ key: "m", ok: v.ok, line: `相場の観測の trigger（試験の写しを通さない前提）${v.ok ? "そのまま" : `崩れた ${v.why.length}`}`, detail: v.why });
      }
    }
    // (h) 分からない事の3つの表（link-brain-watch がサーバーの鍵で数えた数）
    {
      const { data } = await sb.from("cron_run_logs").select("started_at, result_json").eq("cron_name", "link-brain-watch").eq("ok", true).order("started_at", { ascending: false }).limit(3);
      const row = ((data ?? []) as Array<{ started_at: string; result_json: { unknowns_open?: unknown } | null }>).find((r) => r.result_json?.unknowns_open);
      const r = unknownsOpenLine((row?.result_json?.unknowns_open ?? null) as never, row?.started_at ?? null, Date.now());
      checks.push({ key: "h", ok: r.ok, line: r.line, detail: [] });
    }
    // (e) 本番の LP の「◯月実績」が今月か
    {
      const det: string[] = []; let okAll = true;
      const base = "https://sumora-ai-ui.vercel.app";
      for (const page of ["iyeyasu.html", "giga-chintai.html"]) {
        try {
          const html = await (await fetch(`${base}/${page}`, { signal: AbortSignal.timeout(10_000) })).text();
          const js = await (await fetch(`${base}/lp-evidence.js`, { signal: AbortSignal.timeout(10_000) })).text();
          const r = lpMonthOk(html, js, new Date());
          if (!r.ok) okAll = false;
          det.push(`${page}: ${r.why}`);
        } catch (e) { okAll = false; det.push(`${page}: 読めない（${String(e).slice(0, 60)}）`); }
      }
      checks.push({ key: "e", ok: okAll, line: `LP の「◯月実績」${okAll ? "今月" : "ずれ・読めない"}`, detail: det });
    }
    const mark = (c: Check) => (c.ok === null ? "?" : c.ok ? "○" : "×");
    const summary = `危ない所の見張り（本番の分）${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ")}: ` + checks.map((c) => `(${c.key})${mark(c)} ${c.line}`).join("／");
    const bad = checks.filter((c) => c.ok === false).length;
    await finishCronLog(logId, true, { summary, bad, checks });
    return NextResponse.json({ ok: true, summary, bad, checks });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, { checks }, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
