// scripts/audit-itandi-guard.ts（読むだけ・書かない・サイトには触らない）
// 2026-09-30 v2.5.42 竹内「ITANDI も一回での上限を作る。物件数で」「ITANDI で条件指定ちゃんとできていなければ件数多すぎるバグ（3000件以上の表示など）…
//   拡張ツールの部分が問題なのか ITANDI への登録がちゃんと入らなかったのかが原因となるので、その点も併せて確認して」
//   拡張の見分け（chrome-extension/itandi-guard.js）と原因の分け方（app/lib/search-audit-check.ts itandiGuardCause）を本番の記録に当てる:
//   ①ITANDI の回（property_candidate_pools・site=itandi・同じお客様で15分以内を1回）の物件数 → 上限 MAX_ROWS で切れる回
//   ②その回の行（家賃・間取り・所在地）× お客様の今の条件 → 「条件が効いていない形」で止める回（1ページ目＝先頭40行で判定）と理由・例（目で読む）
//   ③ITANDI の点検（search_audits・site=itandi）の読み戻しに原因の分け方を当てる（見分けが止めたと仮定した時 拡張側／ITANDI 側／判断つかず）
// 実行: npx tsx --env-file=.env.local scripts/audit-itandi-guard.ts [--since=2026-08-01] [--show=15]
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
import { itandiGuardCause, type AuditInput } from "../app/lib/search-audit-check";
const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const G = require_("../chrome-extension/itandi-guard.js") as {
  MAX_ROWS: number; evaluate(i: unknown): { suspect: boolean; reasons: string[]; judged: number; outside: { rent: number; layout: number; area: number; any: number }; samples: string[] };
  reasonsJa(r: string[]): string;
};
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const since = arg("since", "2026-08-01");
const show = Number(arg("show", "15"));

type Pool = { property_customer_id: string | null; sent_at: string; candidates: Array<{ name?: string; rent?: number; floor_plan?: string; address?: string; room_no?: string }> | null };

(async () => {
  const pools: Pool[] = [];
  for (let o = 0; o < 20000; o += 1000) {
    const { data, error } = await sb.from("property_candidate_pools").select("property_customer_id, sent_at, candidates").eq("site", "itandi").gte("sent_at", since).order("sent_at").order("id").range(o, o + 999);
    if (error) throw new Error(error.message);
    pools.push(...((data ?? []) as Pool[]));
    if (!data || data.length < 1000) break;
  }
  const ids = [...new Set(pools.map((p) => p.property_customer_id).filter(Boolean))] as string[];
  const cust = new Map<string, { rent_max: number | null; floor_plan: string | null; desired_area: string | null; area_mode: string | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from("property_customers").select("id, rent_max, floor_plan, desired_area, area_mode").in("id", ids.slice(i, i + 100));
    for (const c of (data ?? []) as Array<{ id: string; rent_max: number | null; floor_plan: string | null; desired_area: string | null; area_mode: string | null }>) cust.set(c.id, c);
  }
  // 1回（同じお客様・15分以内）にまとめる
  const runs: Array<{ pc: string | null; at: string; rows: NonNullable<Pool["candidates"]> }> = [];
  const byC = new Map<string, Pool[]>();
  for (const p of pools) { const k = p.property_customer_id ?? "none"; const a = byC.get(k) ?? []; a.push(p); byC.set(k, a); }
  for (const [k, list] of byC) {
    let cur: (typeof runs)[number] | null = null, last = 0;
    for (const p of list) {
      const t = Date.parse(p.sent_at);
      if (!cur || t - last > 15 * 60_000) { cur = { pc: k === "none" ? null : k, at: p.sent_at, rows: [] }; runs.push(cur); }
      cur.rows.push(...(p.candidates ?? []));
      last = t;
    }
  }
  const sizes = runs.map((r) => r.rows.length).sort((a, b) => a - b);
  const q = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))];
  console.log(`=== ① ITANDI の1回の物件数（${since}〜・${runs.length}回・${ids.length}人）: 中央値 ${q(0.5)}・p90 ${q(0.9)}・p95 ${q(0.95)}・最大 ${sizes[sizes.length - 1]}・上位 ${[...sizes].reverse().slice(0, 6).join(", ")}`);
  const cut = runs.filter((r) => r.rows.length > G.MAX_ROWS);
  console.log(`上限 ${G.MAX_ROWS}件で切れる回: ${cut.length}回（${cut.map((r) => `${r.at.slice(5, 16)} ${r.rows.length}件`).join("・") || "なし"}）`);

  let judged = 0, suspect = 0, noCond = 0;
  const reasons: Record<string, number> = {};
  const ex: string[] = [], okEx: string[] = [];
  for (const r of runs) {
    const c = r.pc ? cust.get(r.pc) : null;
    if (!c || (c.rent_max == null && !c.floor_plan)) { noCond++; continue; }
    const rows = r.rows.slice(0, 40).map((x) => ({ rentYen: typeof x.rent === "number" ? x.rent : null, layout: x.floor_plan ?? null, address: x.address ?? null, name: x.name ?? null, room: x.room_no ?? null }));
    const ev = G.evaluate({ rows, count: null, cond: c, isWide: false });
    judged++;
    if (ev.suspect) {
      suspect++;
      for (const k of ev.reasons) reasons[k] = (reasons[k] ?? 0) + 1;
      if (ex.length < show) ex.push(`${r.at.slice(5, 16)} ${String(r.pc).slice(0, 8)} ${r.rows.length}件・行 ${ev.judged}のうち外 ${ev.outside.any}（家賃 ${ev.outside.rent}・間取り ${ev.outside.layout}・区 ${ev.outside.area}）→ ${G.reasonsJa(ev.reasons)}｜条件: 〜${c.rent_max}円・${c.floor_plan ?? "-"}・${c.area_mode}:${String(c.desired_area ?? "").slice(0, 24)}｜例: ${ev.samples.slice(0, 3).join(" / ")}`);
    } else if (ev.judged >= 6 && ev.outside.any > 0 && okEx.length < 6) {
      okEx.push(`${r.at.slice(5, 16)} ${String(r.pc).slice(0, 8)} ${r.rows.length}件・行 ${ev.judged}のうち外 ${ev.outside.any} → 止めない（半分未満）｜例: ${ev.samples.slice(0, 2).join(" / ")}`);
    }
  }
  console.log(`\n=== ② 条件が効いていない形（1ページ目＝先頭40行・お客様の今の条件で当てた＝当時と条件が違う回もある）: 当てた ${judged}回（条件の無いお客様 ${noCond}回は当てない）→ 止める ${suspect}回`);
  console.log(`理由: ${Object.entries(reasons).map(([k, n]) => `${G.reasonsJa([k])} ${n}`).join("・") || "なし"}`);
  ex.forEach((x) => console.log("  止める: " + x));
  okEx.forEach((x) => console.log("  止めない: " + x));

  // ③ 原因の分け方
  const { data: aud, error: aErr } = await sb.from("search_audits").select("run_id, created_at, site, trigger, status, intended, filled, result, customer_snapshot, error, error_kind, area_mode, is_wide").eq("site", "itandi").gte("created_at", since).order("created_at").limit(1000);
  if (aErr) throw new Error(aErr.message);
  const causes: Record<string, number> = {};
  const cex: string[] = [];
  for (const a of (aud ?? []) as Array<Record<string, unknown>>) {
    const input = { ...a, result: { ...((a.result as Record<string, unknown>) ?? {}), guard: { suspect: true, reasons: ["rows_outside"] } } } as unknown as AuditInput;
    const c = itandiGuardCause(input);
    causes[c.cause] = (causes[c.cause] ?? 0) + 1;
    if (cex.length < show) cex.push(`${String(a.created_at).slice(5, 16)} ${a.trigger} → ${c.cause}（${c.evidence.join("・")}）`);
  }
  console.log(`\n=== ③ ITANDI の点検 ${(aud ?? []).length}回に「止めた」と仮定して原因を分けた: ${Object.entries(causes).map(([k, n]) => `${k} ${n}`).join("・")}`);
  cex.forEach((x) => console.log("  " + x));
})().catch((e) => { console.error(e); process.exit(1); });
