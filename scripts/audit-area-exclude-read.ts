// scripts/audit-area-exclude-read.ts — 弱い所 359 の網（app/lib/area-exclude-read.readAreaExclude）を本番の過去のお客様の発言に当て、当たった番を全部出す（読むだけ・LLM なし）
//   実行: npx tsx --env-file=.env.local scripts/audit-area-exclude-read.ts [--days=200]
//   物件を送った後（7日以内にこちらが🌟・ピックアップ・画像を送った）の発言だけ。当たった番の次のこちらの文（最初の1通）と書いた人を並べる。
//   営業時間の DB を重くしないよう、発言は1会話ずつではなく、ゆるい語で絞った行だけ読む。
import { createClient } from "@supabase/supabase-js";
import { readAreaExclude } from "../app/lib/area-exclude-read";

const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=200").split("=")[1]);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type M = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; staff_writer: string | null };

(async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const loose = ["住んで", "すんで", "避け", "以外", "除い", "外し", "NG", "ＮＧ", "行った事", "行ったこと"];
  const cands = new Map<string, M>();
  for (const w of loose) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, staff_writer")
      .eq("sender", "customer").gte("created_at", since).ilike("text", `%${w}%`).limit(1000);
    if (error) throw error;
    for (const m of (data ?? []) as M[]) cands.set(m.id, m);
  }
  let hits = 0, takeuchi = 0, takeuchiPickup = 0, pickupAll = 0;
  for (const m of [...cands.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const { data: around } = await sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, staff_writer")
      .eq("conversation_id", m.conversation_id).gte("created_at", new Date(Date.parse(m.created_at) - 7 * 86400_000).toISOString())
      .lte("created_at", new Date(Date.parse(m.created_at) + 86400_000).toISOString()).order("created_at", { ascending: true }).limit(400);
    const rows = (around ?? []) as M[];
    const sentBefore = rows.filter((r) => r.sender !== "customer" && r.created_at < m.created_at && (/🌟|ピックアップ/.test(r.text ?? "") || !!r.image_url)).length;
    if (!readAreaExclude({ customerText: m.text, sentPropertyCount: sentBefore })) continue;
    hits++;
    const reply = rows.find((r) => r.sender !== "customer" && r.created_at > m.created_at && r.text && r.text !== "[画像]");
    const pickup = /ピックアップ|探させ|お探し|お送りさせ|除い|絞らせ|新着/.test(reply?.text ?? "");
    if (pickup) pickupAll++;
    if (reply?.staff_writer === "takeuchi") { takeuchi++; if (pickup) takeuchiPickup++; }
    console.log(`${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} [${reply?.staff_writer ?? "?"}${pickup ? "・約束" : ""}] お客様「${(m.text ?? "").replace(/\n/g, " ").slice(0, 110)}」\n    → 「${(reply?.text ?? "").replace(/\n/g, " ").slice(0, 110)}」`);
  }
  console.log(`\n候補 ${cands.size}通・当たった ${hits}番（ピックアップの約束 ${pickupAll}）・竹内さんの番 ${takeuchi}（ピックアップの約束 ${takeuchiPickup}）`);
})().catch((e) => { console.error(e); process.exit(1); });
