// 読むだけ（LLM なし）: 申込の意思の番（isApplyIntentTurn）を本番の会話から拾い、申込の情報の状態（readApplyInfoState・ブレインと同じ読み方）と
// スタッフのその番の一手（同じ番にフォーマットを送ったか・最初の1通が返信か AIX か）を並べて数える。2026-11-11 作業員3（A2）
//   npx tsx --env-file=<.env.local> scripts/audit-apply-info-state.ts [--days=200] [--writer=takeuchi|all] [--list]
// 個人の値は出さない（お客様の発言は先頭 40 字・数字は伏せる）
import { createClient } from "@supabase/supabase-js";
import { APPLY_INFO_OR_FILTER, readApplyInfoState, isApplyIntentTurn, type ApplyInfoMsg } from "../app/lib/apply-info-state";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const DAYS = Number(arg("days") ?? 200);
const WRITER = arg("writer") ?? "takeuchi";
const LIST = process.argv.includes("--list");
type M = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; image_type: string | null; is_aix_generated: boolean | null; staff_writer: string | null };
const mask = (s: string | null) => String(s ?? "").replace(/[0-9０-９]{3,}/g, "#").replace(/\n/g, " ").slice(0, 40);

async function priorReading(conv: string, at: string) {
  const { data: prior } = await sb.from("messages").select("sender, text, created_at, image_type")
    .eq("conversation_id", conv).lt("created_at", at).gte("created_at", new Date(Date.parse(at) - 180 * 86_400_000).toISOString())
    .or(APPLY_INFO_OR_FILTER)
    .order("created_at", { ascending: false }).limit(60);
  return readApplyInfoState((prior ?? []) as ApplyInfoMsg[]);
}

async function main() {
  // --at=<conv>@<iso>,…: 試験の問題の番だけ本番の会話で読む
  const at = arg("at");
  if (at) {
    for (const p of at.split(",")) { const [c, t] = p.split("@"); console.log(c.slice(0, 8), t, JSON.stringify(await priorReading(c, t))); }
    return;
  }
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const cands: M[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, image_type, is_aix_generated, staff_writer")
      .eq("sender", "customer").gte("created_at", since)
      .or("text.ilike.%申込%,text.ilike.%申し込%,text.ilike.%抑え%,text.ilike.%押さえ%,text.ilike.%審査%")
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    cands.push(...((data ?? []) as M[]));
    if (!data || data.length < 1000) break;
  }
  const turns = cands.filter((m) => !isTestConversation(m.conversation_id) && (m.text ?? "").length < 300 && !/記入欄】/.test(m.text ?? "") && isApplyIntentTurn(m.text));
  const tally = new Map<string, number>();
  const add = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
  const rows: string[] = [];
  for (const t of turns) {
    const { data: prior } = await sb.from("messages").select("sender, text, created_at, image_type")
      .eq("conversation_id", t.conversation_id).lt("created_at", t.created_at).gte("created_at", new Date(Date.parse(t.created_at) - 180 * 86_400_000).toISOString())
      .or(APPLY_INFO_OR_FILTER)
      .order("created_at", { ascending: false }).limit(60);
    const reading = readApplyInfoState((prior ?? []) as ApplyInfoMsg[]);
    // その番のスタッフの一手: 次の（25字を超える）お客様の発言まで・6時間まで
    const { data: after } = await sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer")
      .eq("conversation_id", t.conversation_id).gt("created_at", t.created_at).lte("created_at", new Date(Date.parse(t.created_at) + 6 * 3_600_000).toISOString())
      .order("created_at", { ascending: true }).limit(15);
    const win: Array<Pick<M, "sender" | "text" | "created_at" | "is_aix_generated" | "staff_writer">> = [];
    for (const m of (after ?? []) as M[]) { if (m.sender === "customer" && (m.text ?? "").length > 25) break; win.push(m); }
    const staff = win.filter((m) => m.sender !== "customer");
    if (!staff.length) continue;
    const w = staff[0].staff_writer ?? "unknown";
    if (WRITER !== "all" && w !== WRITER) continue;
    const formIdx = staff.findIndex((m) => /記入欄】/.test(m.text ?? ""));
    const act = formIdx < 0 ? "返信だけ（フォーマットなし）" : formIdx === 0 ? "フォーマットが先" : "返信→同じ番にフォーマット";
    add(`${reading.state}｜${act}`);
    rows.push(`${t.created_at.slice(0, 10)} ${t.conversation_id.slice(0, 8)} [${reading.state}${reading.via ? ":" + reading.via : ""}] ${act}｜「${mask(t.text)}」→「${mask(staff[0].text)}」`);
  }
  console.log(`# 申込の意思の番（${DAYS}日・書き手=${WRITER}・番 ${rows.length}）`);
  for (const [k, v] of [...tally.entries()].sort()) console.log(`  ${k}: ${v}`);
  if (LIST) for (const r of rows) console.log(r);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
