// scripts/audit-progress-push.ts — 「進捗催促」の判定（greeting.ts PROGRESS_PUSH_RE）が当たったお客様の発言と、次のスタッフの手打ちが
//   「遅くなり申し訳」で始めたかを並べる（読むだけ・LLM なし）。#6・#12（10/28 竹内さん）: 「いつになりますか」（先の事の時期の質問）を催促と読んでいた
// 実行: npx tsx --env-file=.env.local scripts/audit-progress-push.ts [--days=180] [--show=40]
import { createClient } from "@supabase/supabase-js";
import { PROGRESS_PUSH_RE, isProgressPushMessage } from "../app/lib/greeting";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180")), SHOW = Number(arg("show", "40"));
type M = { id: number | string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const hits: M[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated").eq("sender", "customer").gte("created_at", since)
      .or("text.ilike.%いつ%,text.ilike.%まだ%,text.ilike.%どうなっ%,text.ilike.%進捗%,text.ilike.%連絡%,text.ilike.%返事%,text.ilike.%返信%,text.ilike.%お待ちして%,text.ilike.%催促%").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    hits.push(...((data ?? []) as M[]).filter((m) => PROGRESS_PUSH_RE.test(m.text ?? "")));
    if ((data ?? []).length < 1000) break;
  }
  const rows: Array<{ m: M; staff: string; apol: boolean; narrowHit: boolean; alt: string }> = [];
  for (const m of hits) {
    const { data } = await sb.from("messages").select("sender, text, is_aix_generated, created_at").eq("conversation_id", m.conversation_id).gt("created_at", m.created_at).order("created_at").limit(6);
    const next = ((data ?? []) as M[]).find((x) => x.sender !== "customer" && !x.is_aix_generated && (x.text ?? "").trim() && x.text !== "[画像]");
    if (!next) continue;
    const staff = (next.text ?? "").slice(0, 80);
    const apol = /遅くなり|遅れ(?:て|まして)|お待たせ/.test((next.text ?? "").slice(0, 60));
    const alt = (m.text ?? "").match(PROGRESS_PUSH_RE)?.[0] ?? "";
    process.env.PROGRESS_PUSH_NARROW = "on"; const narrowHit = isProgressPushMessage(m.text); delete process.env.PROGRESS_PUSH_NARROW;
    rows.push({ m, staff, apol, narrowHit, alt });
  }
  const c = (f: (r: typeof rows[number]) => boolean) => rows.filter(f).length;
  console.log(`当たり ${rows.length}（次にスタッフの手打ちあり）・うち謝り ${c((r) => r.apol)}`);
  console.log(`狭めた後: 当たり ${c((r) => r.narrowHit)}（謝り ${c((r) => r.narrowHit && r.apol)}）・外れた ${c((r) => !r.narrowHit)}（うち謝り ${c((r) => !r.narrowHit && r.apol)}＝誤って外した候補）`);
  const byAlt = new Map<string, [number, number]>();
  for (const r of rows) { const k = r.alt.replace(/[ぁ-ん]{3,}$/, ""); const v = byAlt.get(r.alt) ?? [0, 0]; v[0]++; if (r.apol) v[1]++; byAlt.set(r.alt, v); }
  console.log("当たった語（件・謝り）:", [...byAlt].sort((a, b) => b[1][0] - a[1][0]).slice(0, 20).map(([k, v]) => `${k} ${v[0]}/${v[1]}`).join("　"));
  console.log("\n== 狭めて外れた物（全部）");
  for (const r of rows.filter((x) => !x.narrowHit)) console.log(`${r.apol ? "★謝り" : "　　　"} 客「${(r.m.text ?? "").replace(/\s+/g, " ").slice(0, 70)}」→「${r.staff.replace(/\s+/g, " ").slice(0, 50)}」`);
  console.log(`\n== 残った物（先頭 ${SHOW}）`);
  for (const r of rows.filter((x) => x.narrowHit).slice(0, SHOW)) console.log(`${r.apol ? "★謝り" : "　　　"} 客「${(r.m.text ?? "").replace(/\s+/g, " ").slice(0, 70)}」→「${r.staff.replace(/\s+/g, " ").slice(0, 50)}」`);
  process.exit(0);
})();
