// scripts/w21-find-taken-anxiety.ts — 作業員21（夜の読み）: 「取られる不安」（他の人に部屋を取られる心配）が書かれたお客様の通の候補を探す（読むだけ・LLM なし）
//   出力は会話 id8／通 id8 と、手元で読むための頭の一節（外の API には渡さない）。テスト用・グループは除く。
// 実行: npx tsx --env-file=.env.local scripts/w21-find-taken-anxiety.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").slice(7));
const RE = process.argv.some((a) => a.startsWith("--kw=")) ? new RegExp((process.argv.find((a) => a.startsWith("--kw=")) as string).slice(5).split(",").join("|")) : /取られ|とられ|埋ま(っ|る|り)|先に.{0,8}(申込|申し込|決ま|契約)|他の(方|人).{0,12}(申込|申し込|決ま|取|契約)|無くな|なくな(っ|る)|早い者勝ち|間に合/;
(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const kw = (process.argv.find((a) => a.startsWith("--kw="))?.slice(5).split(",")) ?? ["取られ", "とられ", "埋ま", "先に", "他の方", "他の人", "なくな", "無くな", "早い者", "間に合"];
  const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, text").eq("sender", "customer").gte("created_at", since)
    .or(kw.map((k) => `text.ilike.%${k}%`).join(",")).order("created_at", { ascending: false }).limit(800);
  if (error) { console.log(error.message); return; }
  let n = 0;
  for (const r of (data ?? []) as any[]) {
    if (isTestConversation(r.conversation_id)) continue;
    const t = String(r.text ?? "").replace(/\s+/g, " ");
    if (!RE.test(t) || /本人確認|収入証明|免許証/.test(t)) continue;
    const m = t.match(RE)!; const at = Math.max(0, (m.index ?? 0) - 40);
    console.log(`${String(r.conversation_id).slice(0, 8)}/${String(r.id).slice(0, 8)} ${String(r.created_at).slice(0, 10)} …${t.slice(at, at + 100)}`);
    if (++n >= 60) break;
  }
  console.log(`候補 ${n}`);
})();
