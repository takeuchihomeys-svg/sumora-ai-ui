// scripts/conductor-intake-replay-build.ts — 入口の統括の「再生の試験」の材料を作る（竹内さん本人の番だけ・夜だけ・読むだけ・LLM なし）
//
// 2026-11-04 竹内さん（KB P1「統括を竹内さんの過去の番で鍛える」・41dadfe6「基準は竹内さんだけ」）:
//   竹内さん本人が送った番（messages.staff_writer='takeuchi'・申込の書類の手前まで）を、送る直前の状態（伏せた今の番のお客様の発言・直前のこちらの送信）にして、
//   竹内さんの一手（AIX か返信か・AIX の種類）を正解として残す。置き場は exam-cache だけ（git に入れない）。伏せは compose-name-mask＋maskPII。
//   上限: 窓 --days（既定 90・最大 120）・件数 --limit（既定 200・最大 400）。営業時間（JST 9〜22時）は動かない（--force で手元の確かめだけ）。
// 実行: npx tsx --env-file=.env.local scripts/conductor-intake-replay-build.ts [--days=90] [--limit=200]
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestConversation } from "../app/lib/test-conversations";
import { maskPII } from "../app/lib/pii-mask";
import { customerNameTokens, maskCustomerNames } from "../app/lib/compose-name-mask";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const DAYS = Math.min(120, Math.max(7, Number(arg("days", "90"))));
const LIMIT = Math.min(400, Math.max(20, Number(arg("limit", "200"))));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const OUT = join(process.cwd(), "..", "..", "exam-cache", "conductor-intake");
const APPLY_DOCS = /(申込(?:書|フォーマット)|本人確認書類|免許証|マイナンバー|源泉徴収|給与明細|生年月日|勤務先)/;

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null; staff_writer: string | null };

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data: tk, error } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, line_message_id, staff_writer")
    .eq("staff_writer", "takeuchi").neq("sender", "customer").gte("created_at", since).order("created_at", { ascending: false }).limit(LIMIT * 4);
  if (error) throw new Error(error.message);
  const rows = (tk ?? []) as Msg[];
  const out: Array<Record<string, unknown>> = [];
  const seenTurn = new Set<string>();
  for (const s of rows) {
    if (out.length >= LIMIT) break;
    if (isTestConversation(s.conversation_id)) continue;
    // その送信の直前の会話（お客様の今の番と、その前のこちらの送信）
    const { data: prev } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, line_message_id, staff_writer")
      .eq("conversation_id", s.conversation_id).lt("created_at", s.created_at).order("created_at", { ascending: false }).limit(12);
    const pv = (prev ?? []) as Msg[];
    if (!pv.length || pv[0].sender !== "customer") continue; // お客様の発言への一手だけ
    const turn: Msg[] = []; for (const m of pv) { if (m.sender !== "customer") break; turn.push(m); }
    const key = `${s.conversation_id}|${turn[turn.length - 1]?.created_at}`;
    if (seenTurn.has(key)) continue; seenTurn.add(key);
    const allText = [...pv.map((m) => m.text ?? ""), s.text ?? ""].join("\n");
    if (APPLY_DOCS.test(allText)) continue; // 申込の書類の手前まで
    const { data: conv } = await sb.from("conversations").select("customer_name").eq("id", s.conversation_id).maybeSingle();
    const tokens = customerNameTokens([(conv as { customer_name?: string | null } | null)?.customer_name ?? null]);
    const mask = (t: string) => maskPII(maskCustomerNames(t, tokens));
    let aixType: string | null = null;
    if (s.is_aix_generated && s.line_message_id) {
      const { data: al } = await sb.from("aix_usage_logs").select("aix_type").eq("line_message_id", s.line_message_id).limit(1).maybeSingle();
      aixType = (al as { aix_type?: string } | null)?.aix_type ?? "aix_unknown";
    }
    const lastStaff = pv.find((m) => m.sender !== "customer" && (m.text ?? "").trim());
    out.push({
      id: `ti-${out.length + 1}`, at: s.created_at, turnAt: turn[turn.length - 1]?.created_at,
      customer: mask(turn.reverse().map((m) => m.text ?? "").join("\n")).slice(0, 800),
      lastStaff: lastStaff ? mask(lastStaff.text ?? "").slice(0, 400) : null,
      gold: { route: aixType ? "aix" : "reply", aix: aixType },
    });
  }
  mkdirSync(OUT, { recursive: true });
  const f = join(OUT, `questions-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(f, JSON.stringify({ builtAt: new Date().toISOString(), days: DAYS, n: out.length, writer: "takeuchi", items: out }, null, 1));
  const aix = out.filter((x) => (x.gold as { route: string }).route === "aix").length;
  console.log(`作った: ${out.length}番（AIX ${aix}・返信 ${out.length - aix}）→ ${f}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
