// scripts/audit-compose-conductor.ts — 文の統括の確かめ（reply-compose-conductor.ts）を本物の文に当てる（読むだけ・LLM なし・費用 0）
//
// 2026-11-05 作業員9。①竹内さんの送信（takeuchi_compose_examples）に「書かない事」の型がどれだけ出るか＝確かめの誤り（竹内さんが書く型を外れと言わないか）
//   ②直近 N 日の竹内さんの番（ai_reply_examples line_reply × messages.staff_writer=takeuchi・sure）で、下書きと送信の物差し（近さ・原則の揃い方・継続の約束の抜け）
// 実行: npx tsx --env-file=.env.local scripts/audit-compose-conductor.ts [--days=14] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { detectOmitKinds, hasKeepPromise, scoreAgainstTakeuchi, OMIT_JA, type OmitKind } from "../app/lib/reply-compose-conductor";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const DAYS = Number(arg("days", "14")), SHOW = Number(arg("show", "10"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function pages<T>(f: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  // ① 竹内さんの送信
  // 公開キーでは takeuchi_compose_examples は読めない（RLS）。読めない時は①を飛ばす（②だけ）。①は MCP の SQL で同じ型を数える
  const tk = await pages<{ scene: string; body: string }>((a, b) => sb.from("takeuchi_compose_examples").select("scene, body").order("message_id").range(a, b))
    .catch((e) => { console.log(`① 読めない（${(e as { message?: string })?.message ?? e}）→ 飛ばす`); return [] as Array<{ scene: string; body: string }>; });
  const byKind = new Map<OmitKind, number>(); const byScene = new Map<string, { n: number; keep: number }>();
  for (const r of tk) {
    for (const k of detectOmitKinds(r.body)) byKind.set(k, (byKind.get(k) ?? 0) + 1);
    const s = byScene.get(r.scene) ?? { n: 0, keep: 0 }; s.n++; if (hasKeepPromise(r.body)) s.keep++; byScene.set(r.scene, s);
  }
  console.log(`① 竹内さんの送信 ${tk.length}通に出た「書かない事」の型（多いほど、その型を外れと言うと竹内さんの書き方を外れにする）`);
  for (const k of Object.keys(OMIT_JA) as OmitKind[]) console.log(`   ${OMIT_JA[k]}: ${byKind.get(k) ?? 0}通（${(((byKind.get(k) ?? 0) / Math.max(1, tk.length)) * 100).toFixed(1)}%）`);
  console.log("   継続の約束の割合（場面別）: " + [...byScene].sort((a, b) => b[1].n - a[1].n).map(([s, v]) => `${s} ${v.keep}/${v.n}`).join("・"));

  // ② 直近の竹内さんの番
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const ex = await pages<{ id: string; conversation_id: string; sent_at: string | null; created_at: string; ai_draft: string | null; sent_reply: string }>((a, b) =>
    sb.from("ai_reply_examples").select("id, conversation_id, sent_at, created_at, ai_draft, sent_reply").eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null).order("created_at").range(a, b));
  const convs = [...new Set(ex.map((e) => e.conversation_id))];
  const msgs: Array<{ conversation_id: string; created_at: string; text: string | null; staff_writer: string | null; staff_writer_confidence: string | null }> = [];
  for (let i = 0; i < convs.length; i += 50) {
    const part = await pages<typeof msgs[number]>((a, b) => sb.from("messages").select("conversation_id, created_at, text, staff_writer, staff_writer_confidence")
      .in("conversation_id", convs.slice(i, i + 50)).eq("sender", "staff").gte("created_at", since).order("created_at").range(a, b));
    msgs.push(...part);
  }
  const writerOf = (e: typeof ex[number]) => {
    const t = Date.parse(e.sent_at ?? e.created_at);
    const m = msgs.find((x) => x.conversation_id === e.conversation_id && Math.abs(Date.parse(x.created_at) - t) <= 180_000 && (x.text ?? "").slice(0, 20) === e.sent_reply.slice(0, 20));
    return m && m.staff_writer_confidence === "sure" ? m.staff_writer : null;
  };
  const tkPairs = ex.filter((e) => writerOf(e) === "takeuchi");
  let keepMissed = 0; const extra = new Map<OmitKind, number>(); const sims: number[] = []; const shown: string[] = [];
  for (const e of tkPairs) {
    const s = scoreAgainstTakeuchi({ draft: e.ai_draft ?? "", sent: e.sent_reply });
    sims.push(s.sim); if (s.keepMissed) keepMissed++;
    for (const k of s.extraKinds) extra.set(k, (extra.get(k) ?? 0) + 1);
    if ((s.keepMissed || s.extraKinds.length) && shown.length < SHOW) shown.push(`   ${e.id.slice(0, 8)} 近さ ${s.sim}｜${s.keepMissed ? "継続の約束の抜け " : ""}${s.extraKinds.map((k) => OMIT_JA[k]).join("・")}\n      下書き: ${(e.ai_draft ?? "").replace(/\s+/g, " ").slice(0, 120)}\n      送信:   ${e.sent_reply.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  sims.sort((a, b) => a - b);
  console.log(`\n② 直近${DAYS}日の竹内さんの番（下書きあり）${tkPairs.length}件: 近さの中央 ${sims[Math.floor(sims.length / 2)] ?? "-"}・0.8 未満 ${sims.filter((x) => x < 0.8).length}件`);
  console.log(`   原則の外れ（下書きにあって竹内さんに無い型）: ${[...extra].map(([k, n]) => `${OMIT_JA[k]} ${n}`).join("・") || "なし"}`);
  console.log(`   継続の約束の抜け（竹内さんは入れた）: ${keepMissed}件`);
  if (shown.length) console.log(`\n目で読む（${shown.length}件）:\n${shown.join("\n")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
