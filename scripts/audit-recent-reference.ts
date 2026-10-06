// scripts/audit-recent-reference.ts
// 「先ほどのお部屋」「先程お送りした」等、近さの言葉で前の物件を指した回を、前の物件のやり取りからの時間で分けて数え、出口の前後を並べる（読むだけ・LLM なし・費用0）。
// 2026-10-06 竹内（見木 響夢さん）「先程ってかなり前にやり取りしていた物件なので、そこも踏まえて考える」
// 実行: npx tsx --env-file=.env.local scripts/audit-recent-reference.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { hasRecentRoomRef, lastRoomExchange, fixRecentReference, RECENT_REF_MAX_HOURS } from "../app/lib/recency-reference";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "365"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const OR = "%先ほど%,%先程%,%さきほど%,%さっき%,%今しがた%".split(",");

async function fetchHits(table: "messages" | "aix_generate_log", col: string, since: string): Promise<Row[]> {
  const out: Row[] = [];
  for (const w of OR) {
    let q = sb.from(table).select(table === "messages" ? "conversation_id, created_at, text, sender" : "conversation_id, created_at, generated_text, action_type").ilike(col, w).gte("created_at", since).limit(1000);
    if (table === "messages") q = q.neq("sender", "customer");
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Row[]));
  }
  return out;
}

const bucketOf = (h: number | null) => h === null ? "分からない" : h <= RECENT_REF_MAX_HOURS ? `${RECENT_REF_MAX_HOURS}時間以内` : h <= 24 ? "3〜24時間" : h <= 72 ? "1〜3日" : "3日超";

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  for (const [label, table, col] of [["AIX の生成（aix_generate_log・全種類）", "aix_generate_log", "generated_text"], ["実送信（スタッフ）", "messages", "text"]] as const) {
    const raw = await fetchHits(table, col, since);
    const seen = new Set<string>();
    const rows = raw.filter((r) => {
      const k = `${r.conversation_id}|${r.created_at}`;
      if (seen.has(k) || !r.conversation_id || r.conversation_id === YUMA_CONVERSATION_ID) return false;
      seen.add(k);
      return hasRecentRoomRef(String(r[col] ?? ""));
    });
    const cnt: Record<string, number> = {};
    let changed = 0;
    console.log(`\n=== ${label}: 近さの言葉で物件・送付を指した ${rows.length}回（${DAYS}日・YUMA を除く）===`);
    for (const r of rows) {
      const t = Date.parse(r.created_at);
      const { data: prev } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id)
        .lt("created_at", new Date(t - 1_000).toISOString()).order("created_at", { ascending: false }).limit(60);
      const msgs = ((prev ?? []) as Row[]).reverse();
      const last = lastRoomExchange(msgs, t);
      const b = bucketOf(last ? last.hours : null);
      cnt[b] = (cnt[b] ?? 0) + 1;
      const text = String(r[col] ?? "");
      const fx = fixRecentReference(text, last);
      if (fx.applied.length) changed++;
      const at = Math.max(0, text.search(/先ほど|先程|さきほど|さっき|今しがた/) - 30);
      console.log(`  [${b}${last ? `・${last.hours.toFixed(1)}時間・${last.by}` : ""}] ${r.created_at.slice(0, 16)} ${String(r.conversation_id).slice(0, 8)} ${r.action_type ?? ""}`);
      console.log(`      前: ${text.slice(at, at + 110).replace(/\n+/g, " / ")}`);
      if (fx.applied.length) console.log(`      後: ${fx.text.slice(Math.max(0, at - 10), at + 110).replace(/\n+/g, " / ")}  （${fx.applied.join("・")}）`);
    }
    console.log(`  時間の分け: ${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join("・")} ／ 出口で直した ${changed}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
