// 「⚠️」やスタッフ向けの見出しが本文に出てよいか、実送信で線を引く（読み取りのみ）
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "⚠ を含む", re: /⚠/ },
  { id: "行頭が【⚠…】の注記", re: /^\s*【[^】\n]{0,4}⚠[^】\n]{0,60}】/m },
  { id: "<<< を含む", re: /<<</ },
  { id: ">>> を含む", re: />>>/ },
  { id: "「参考のみ」", re: /参考のみ/ },
  { id: "「送信前」", re: /送信前/ },
  { id: "「手動確認」", re: /手動確認/ },
  { id: "「リスケ検知」", re: /リスケ検知/ },
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
    for (const x of r) { const t = String(x[col] ?? ""); if (t && t !== "__SHOWN__") out.push({ t, at: String(x.created_at) }); }
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const sent = await grab("messages", "text");
  const draft = await grab("ai_reply_examples", "ai_draft");
  console.log(`実送信 ${sent.length}通 ／ 下書き ${draft.length}件\n`);
  console.log(`${"型".padEnd(28)} 実送信 / 下書き`);
  console.log("─".repeat(58));
  for (const p of PATTERNS) {
    const s = sent.filter((x) => p.re.test(x.t));
    const d = draft.filter((x) => p.re.test(x.t));
    console.log(`${p.id.padEnd(28)} ${String(s.length).padStart(5)} / ${String(d.length).padStart(5)}${s.length === 0 ? "   🟢 落として安全" : "   🔴 実送信にもある"}`);
    for (const x of s.slice(0, 4)) console.log(`      [実送信 ${x.at.slice(5, 16)}] ${x.t.replace(/\n/g, " ").slice(0, 92)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
