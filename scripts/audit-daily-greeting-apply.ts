// applyDailyGreeting（今日すでに送った後の挨拶を消す）を過去の AIX の送信に当てて、前後を目で読む（読み取りのみ・全件監査）
// 2026-09-22 竹内「今日初めてじゃないときはお世話になっておりますはつかわない」
// 実行: npx tsx --env-file=.env.local scripts/audit-daily-greeting-apply.ts [DAYS=60]
import { createClient } from "@supabase/supabase-js";
import { applyDailyGreeting } from "../app/lib/daily-greeting";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const MEDIA_RE = /^\s*(?:\[画像\]|\[動画\]|\[スタンプ\]|（室内イメージ）\s*)?(?:https?:\/\/\S+)?\s*$|^\s*\[画像\]/;

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }> = [];
  for (let p = 0; p < 40; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  const by = new Map<string, typeof rows>();
  for (const m of rows) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const mask = (s: string) => s.replace(/[^\s、。！!？?\n]{1,12}(?:さん|様)/g, "〈お客様〉さん").replace(/\n/g, " ／ ");
  let n = 0; const shown: string[] = [];
  for (const arr of by.values()) arr.forEach((m, i) => {
    if (m.sender !== "staff" || !m.is_aix_generated) return;
    const t = (m.text ?? "").trim(); if (!t || MEDIA_RE.test(t)) return;
    const day = jstDay(m.created_at);
    const sentBefore = arr.slice(0, i).some((x) => x.sender === "staff" && jstDay(x.created_at) === day
      && !(MEDIA_RE.test(x.text ?? "") && new Date(m.created_at).getTime() - new Date(x.created_at).getTime() < 10 * 60_000));
    if (!sentBefore) return;
    const r = applyDailyGreeting(t, { staffSentToday: true, greetingPhrase: "", name: "" });
    if (r.action !== "removed") return;
    n++;
    if (shown.length < 20) shown.push(`前: ${mask(t).slice(0, 90)}\n   後: ${mask(r.text).slice(0, 90)}`);
  });
  console.log(`直近${days}日の AIX で「今日すでに送った後」に挨拶を消す通: ${n}通\n`);
  for (const s of shown) console.log(" ", s);
}
main().catch((e) => { console.error(e); process.exit(1); });
