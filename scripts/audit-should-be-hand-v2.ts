// scripts/audit-should-be-hand-v2.ts — 手打ちの網の2版（AIX_SHOULD_BE_HAND_V2）で当てはめが変わる見張りの番の一覧（読むだけ・LLM なし・費用0・作業員N2・2026-11-23・台帳 #641）
//   line_watch_turns.staff_texts（手打ちの文・60日で 1,755行・約 560kB の軽い読み）を、off と on の shouldBeAixOf に通して比べる。
//   比べる所は2つ: ①1通ずつ（audit-aix-turn-judgment・learn-aix-meanings と同じ・strong だけ使う）②返事のまとまりを1つに（見張りの採点 line-watch-judge と同じ・ボタンで比べる）
//   本文は出さない（会話の頭8字・鍵・強さだけ）。--show で変わった文の頭40字を出す（目で確かめる用・手元だけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-should-be-hand-v2.ts [--days=60] [--show] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { shouldBeAixOf, type ShouldBeAix } from "../app/lib/aix-should-be";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const show = process.argv.includes("--show");
const OFF = {}, ON = { AIX_SHOULD_BE_HAND_V2: "on" };
const lab = (s: ShouldBeAix | null) => (s ? `${s.key}:${s.strength}` : "なし");

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "60")) || 60;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  type W = { id: number; conversation_id: string; customer_turn_at: string; staff_texts: Array<{ text?: string; burst?: boolean }> | null; brain_reply_mode: string | null; brain_action: string | null; verdict: string | null; writer: string | null };
  const rows: W[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id,conversation_id,customer_turn_at,staff_texts,brain_reply_mode,brain_action,verdict,writer:verdict_detail->>staff_writer").gte("customer_turn_at", since).not("staff_texts", "is", null).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as W[]));
    if ((data ?? []).length < 1000) break;
  }
  const one: Array<Record<string, unknown>> = [], burst: Array<Record<string, unknown>> = [];
  let texts = 0;
  for (const r of rows) {
    const ts = (r.staff_texts ?? []).filter((t) => typeof t?.text === "string" && t.text.trim());
    const brain = r.brain_reply_mode === "aix" ? r.brain_action : null;
    const base = { id: r.id, conv: r.conversation_id.slice(0, 8), at: r.customer_turn_at.slice(0, 16), writer: r.writer, brain: brain ?? "返信", verdict: r.verdict };
    for (const t of ts) {
      texts++;
      const a = shouldBeAixOf(t.text, { mode: "hand", env: OFF }), b = shouldBeAixOf(t.text, { mode: "hand", env: ON });
      if (lab(a) !== lab(b)) one.push({ ...base, off: lab(a), on: lab(b), ...(show ? { head: t.text!.replace(/\s+/g, " ").slice(0, 40) } : {}) });
    }
    const bt = ts.filter((t) => t.burst).map((t) => t.text).join("\n").trim();
    if (bt) {
      const a = shouldBeAixOf(bt, { mode: "hand", env: OFF }), b = shouldBeAixOf(bt, { mode: "hand", env: ON });
      if (lab(a) !== lab(b)) burst.push({ ...base, off: lab(a), on: lab(b), buttonSame: (a?.button ?? null) === (b?.button ?? null), mapMatchOff: !!brain && a?.button === brain, mapMatchOn: !!brain && b?.button === brain });
    }
  }
  const strongOff = one.filter((x) => String(x.off).endsWith(":strong")).length, strongOn = one.filter((x) => String(x.on).endsWith(":strong")).length;
  console.log(`# 手打ちの網の2版（${days}日・見張りの番 ${rows.length}・手打ちの文 ${texts}）`);
  console.log(`## 1通ずつ（strong を使う台本の数え）: 変わった文 ${one.length}（strong になった ${strongOn}・strong でなくなった ${strongOff}）`);
  for (const x of one) console.log(`- ${x.id} ${x.conv} ${x.at} 書き手 ${x.writer ?? "?"}｜ブレイン ${x.brain}｜${x.off} → ${x.on}${x.head ? `｜${x.head}` : ""}`);
  const mapChanged = burst.filter((x) => x.mapMatchOff !== x.mapMatchOn);
  console.log(`## 返事のまとまり（見張りの採点）: 当てはめが変わった番 ${burst.length}・ボタンが変わった番 ${burst.filter((x) => !x.buttonSame).length}・ブレインとの一致（same_via_mapping の元）が変わった番 ${mapChanged.length}`);
  for (const x of burst) console.log(`- ${x.id} ${x.conv} ${x.at}｜ブレイン ${x.brain}｜${x.off} → ${x.on}${x.buttonSame ? "" : "｜ボタンが変わる"}${x.mapMatchOff !== x.mapMatchOn ? `｜一致 ${x.mapMatchOff}→${x.mapMatchOn}` : ""}`);
  const j = arg("json", "");
  if (j) writeFileSync(j, JSON.stringify({ days, turns: rows.length, texts, one, burst }, null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
