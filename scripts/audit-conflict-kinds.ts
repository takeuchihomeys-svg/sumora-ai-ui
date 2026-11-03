// scripts/audit-conflict-kinds.ts — 返信か AIX かの外れを「ぶつかりの種類」で分ける（読むだけ・LLM なし）
// ⚠ 2026-11-03: 番ごとに DB を読む（数百回）。営業時間（9〜22時 JST）には回さない（11/3 10:31 の DB の混雑の一因）。材料は先に手元へ書き出して使い回す
//   入力: scripts/audit-aix-miss-causes.ts --json=<file> の外れ（スタッフが AIX を押した番でブレインが外した番）
//   a. ブレイン（LLM）は AIX と言ったのに、後ろの決まりが返信・約束・別の AIX に変えた（digest.la が AIX・最終が違う）
//   b. ブレイン（LLM）自身が返信にした（スタッフしか分からない事が要る番に気づかない）
//   c. 約束か、その場か（作業員1の③）
//   d. 返信と AIX の両方の要件があったのに片方だけ（スタッフが同じ返しで手打ちの文と AIX の両方を送った）
//   その他: AIX の種類違い（②）・スタッフだけが知る事（④）・材料が届いていない（⑤）
// 使い方: npx tsx --env-file=.env.local scripts/audit-conflict-kinds.ts --in=<aix-miss.json> [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
type Miss = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; cause: string; staff_aix: string; staff_at: string; brain_action: string; brain_reply_mode: string | null; decision_id: string | null };
(async () => {
  const j = JSON.parse(readFileSync(arg("in")!, "utf8")) as { misses: Miss[] };
  const out: Array<Miss & { kind: string; la: string | null; ds: string | null; staffText: boolean }> = [];
  for (const m of j.misses) {
    let la: string | null = null, ds: string | null = null;
    if (m.decision_id) { const { data } = await sb.from("brain_decision_logs").select("digest").eq("id", m.decision_id).maybeSingle(); const d = (data?.digest ?? {}) as { la?: string | null; ds?: string | null }; la = d.la ?? null; ds = d.ds ?? null; }
    const after = new Date(Date.parse(m.customer_last_at ?? m.customer_turn_at) + 1).toISOString();
    const until = new Date(Date.parse(m.staff_at) + 30 * 60_000).toISOString();
    const { data: st } = await sb.from("messages").select("sender, text, is_aix_generated, created_at").eq("conversation_id", m.conversation_id).gt("created_at", after).lte("created_at", until).neq("sender", "customer").order("created_at").limit(20);
    const staffText = (st ?? []).some((x) => !x.is_aix_generated && (x.text ?? "").trim() && !/^\s*\[(?:画像|ファイル)\]\s*$/.test(x.text ?? "") && Array.from(x.text ?? "").length >= 15);
    const laAix = !!la && la !== "none" && la !== "null";
    const brainReply = !m.brain_action;
    let kind: string;
    if (m.cause.startsWith("⑤")) kind = "その他:材料が届いていない";
    else if (m.cause.startsWith("④")) kind = "その他:スタッフだけが知る事（後で押した）";
    else if (m.cause.startsWith("③")) kind = staffText ? "d（約束かその場か＋手打ちも）" : "c";
    else if (laAix && la !== m.brain_action) kind = la === m.staff_aix ? "a（LLM は正解の AIX・後ろで変わった）" : "a（LLM は AIX・後ろで変わった）";
    else if (brainReply && staffText) kind = "d";
    else if (brainReply) kind = "b";
    else kind = "その他:AIX の種類違い";
    out.push({ ...m, kind, la, ds, staffText });
  }
  const c: Record<string, number> = {}; for (const o of out) c[o.kind] = (c[o.kind] ?? 0) + 1;
  console.log(`外れ ${out.length} 番のぶつかりの種類:`); for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  const aRows = out.filter((o) => o.kind.startsWith("a"));
  const dsC: Record<string, number> = {}; for (const o of aRows) { const k = String(o.ds ?? "-").split("(")[0]; dsC[k] = (dsC[k] ?? 0) + 1; }
  console.log("a の書き換えの出どころ（digest.ds）:", JSON.stringify(dsC));
  if (arg("out")) writeFileSync(arg("out")!, JSON.stringify(out, null, 1));
})();
