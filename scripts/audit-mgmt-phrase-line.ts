// 「管理会社宛ての文」を手本から落とす判定の線を引く（読み取りのみ）
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
//   落としてよいのは「お客様への LINE（messages.staff）に1通も出ない形」だけ（誤削除0）。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const CANDIDATES: Array<{ id: string; re: RegExp }> = [
  { id: "〜さんのご案内をしております", re: /さんのご案内をしております/ },
  { id: "のご案内をしております（広め）", re: /のご案内をしております/ },
  { id: "ご確認をお願いできますでしょうか", re: /ご確認をお願いできますでしょうか/ },
  { id: "お願いできますでしょうか", re: /お願い(?:でき|出来)ますでしょうか/ },
  { id: "お伺いできますでしょうか", re: /お伺い(?:でき|出来)ますでしょうか/ },
  { id: "現在も募集中でしょうか", re: /現在も募集中でしょうか/ },
  { id: "ご確認頂けますと幸いです。よろしくお願い致します", re: /ご確認(?:頂|いただ)けますと幸いです。/ },
  { id: "御見積もりもお願いできますでしょうか", re: /(?:御)?見積(?:もり|り|書)?もお願い(?:でき|出来)ますでしょうか/ },
];

async function grab(table: "messages" | "ai_reply_examples", col: string) {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const out: Array<{ t: string; at: string }> = [];
  for (let p = 0; p < 16; p++) {
    const { data } = table === "messages"
      ? await sb.from(table).select(`${col}, created_at`).eq("sender", "staff").gte("created_at", since)
          .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999)
      : await sb.from(table).select(`${col}, created_at`).gte("created_at", since)
          .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    for (const x of r) { const t = String(x[col] ?? ""); if (t) out.push({ t, at: String(x.created_at) }); }
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const sent = await grab("messages", "text");                  // お客様に届いた文
  const ex = await grab("ai_reply_examples", "sent_reply");     // 手本として使われる文
  console.log(`お客様へのLINE ${sent.length}通 ／ 手本 sent_reply ${ex.length}件\n`);
  console.log(`${"候補の語".padEnd(42)} LINE / 手本   判定`);
  console.log("─".repeat(78));
  for (const c of CANDIDATES) {
    const s = sent.filter((x) => c.re.test(x.t));
    const e = ex.filter((x) => c.re.test(x.t));
    const ok = s.length === 0 ? "🟢 LINEに0通 → 手本から落として安全" : "🔴 お客様にも使う（落とせない）";
    console.log(`${c.id.padEnd(42)} ${String(s.length).padStart(4)} / ${String(e.length).padStart(4)}   ${ok}`);
    for (const x of s.slice(0, 2)) console.log(`      [LINE ${x.at.slice(5, 16)}] ${x.t.replace(/\n/g, " ").slice(0, 88)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
