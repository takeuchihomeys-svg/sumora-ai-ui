// scripts/audit-backplan-plant-draft.ts — 竹内さん本人の文に仕込み（申込で抑え・最大限割引の御見積書・ご内覧）があった番で、AI の下書きにも同じ向きの仕込みが入った割合（台帳 #745・読むだけ・LLM なし）
// 2026-11-26 作業員A（竹内さん「返信の内容も実際の竹内の言い回しに逆算のところちゃんと行えばよりよくなる」）: BACKPLAN_TO_WRITER の物差し（on の前後で比べる元の数）
// 実行: npx tsx --env-file=.env.local scripts/audit-backplan-plant-draft.ts [--days=60] [--write]
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const days = Number(arg("days", "60")) || 60;
/** 仕込みの向き（竹内さん本人の60日の文の型・route-backplan の GOAL_PLANT と同じ向き） */
export const PLANT_DIR: Array<[string, RegExp]> = [
  ["申込", /お申込.{0,10}(?:抑え|押さえ)|申込みでお部屋を(?:先に)?抑え/],
  ["見積", /最大限割引.{0,20}(?:御見積|お見積)/],
  ["内覧", /ご内覧(?:頂|いただ|可能)|ご都合(?:の)?よろしいお日にちにお部屋ご案内/],
];
const dirsOf = (t: string) => PLANT_DIR.filter(([, re]) => re.test(t)).map(([d]) => d);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });

(async () => {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const turns: Array<{ id: number; conversation_id: string; customer_last_at: string | null; customer_turn_at: string; draft_first: string | null; draft_last: string | null; staff_texts: unknown }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, draft_first, draft_last, staff_texts").gte("customer_turn_at", since).order("id").range(f, f + 999);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as typeof turns));
    if ((data ?? []).length < 1000) break;
  }
  let n = 0, same = 0, anyDraft = 0;
  const byDir = new Map<string, { n: number; same: number }>();
  for (const t of turns) {
    const last = t.customer_last_at ?? t.customer_turn_at;
    const { data: ms } = await sb.from("messages").select("text, staff_writer, is_aix_generated").eq("conversation_id", t.conversation_id).eq("sender", "staff").gt("created_at", last).lte("created_at", new Date(Date.parse(last) + 6 * 3_600_000).toISOString()).order("created_at").limit(3);
    const xs = (ms ?? []) as Array<{ text: string | null; staff_writer: string | null; is_aix_generated: boolean | null }>;
    if (!xs.length || xs[0].staff_writer !== "takeuchi") continue;
    const tk = dirsOf(xs.filter((m) => !m.is_aix_generated).map((m) => m.text ?? "").join("\n"));
    if (!tk.length) continue;
    const d0 = String(t.draft_last ?? ""), draft = d0.trim() && !/^\s*__[A-Z_]+__\s*$/.test(d0) ? d0 : String(t.draft_first ?? "");
    if (!draft.trim()) continue;
    n++;
    const dd = dirsOf(draft);
    if (dd.length) anyDraft++;
    const hit = tk.some((d) => dd.includes(d));
    if (hit) same++;
    for (const d of tk) { const o = byDir.get(d) ?? { n: 0, same: 0 }; o.n++; if (dd.includes(d)) o.same++; byDir.set(d, o); }
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  console.log(`■ 竹内さん本人の文に仕込みがあった番 ${n}（下書きあり）: 下書きにも同じ向きの仕込み ${same}（${pct(same, n)}%）・下書きに何かの仕込み ${anyDraft}`);
  console.log(`  向きごと: ${[...byDir].map(([d, o]) => `${d} ${o.same}/${o.n}`).join("・")}`);
  if (process.argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const { error } = await sb.from("quality_daily").upsert([{ day, metric: "compose:backplan_plant_match", scope: "takeuchi", value: pct(same, n), n, detail: Object.fromEntries(byDir), source: "scripts/audit-backplan-plant-draft.ts（作業員A・#745）" }], { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log("書いた: quality_daily 1行");
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
