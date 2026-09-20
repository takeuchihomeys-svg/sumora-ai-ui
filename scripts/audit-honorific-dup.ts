// 敬称の二重（「親さんさん」）はどれだけ起きるか（読み取りのみ）
//
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
// audit-internal-leak.ts で実送信32通・下書き40件の「さんさん」を検出。
// 実例「天王寺区全域から…私の方で親さんさんご希望の」＝お客様の表示名が「親さん」で、そこにさらに「さん」。
// 敬称を足す処理は20か所以上に散らばっていて、重複を避けているのは2か所だけ（四者同名が崩れている）。
// ここでは「線」を引く: 名前が敬称で終わる会話は何件あるか・実際の重複はそれで説明できるか。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
/** 名前の末尾が敬称（これに当たる名前に「さん」を足すと二重になる） */
const ENDS_HONORIFIC = /(?:さん|サン|様|さま|ちゃん|君|くん)$/;

async function main() {
  const { data } = await sb.from("conversations").select("id, customer_name, status").limit(6000);
  const convs = (data ?? []) as Array<{ id: string; customer_name: string | null; status: string | null }>;
  const named = convs.filter((c) => (c.customer_name ?? "").trim());
  const risky = named.filter((c) => ENDS_HONORIFIC.test((c.customer_name ?? "").trim()));
  console.log(`=== 会話 ${convs.length}件（名前あり ${named.length}件）===`);
  console.log(`  名前が敬称で終わる（「さん」を足すと二重になる）: **${risky.length}件（${((risky.length / named.length) * 100).toFixed(1)}%）**`);
  for (const c of risky.slice(0, 20)) console.log(`    「${c.customer_name}」 [${c.status}]`);

  // 実送信・下書きの「さんさん」が、その会話の名前で説明できるか
  const nameOf = new Map<string, string>();
  for (const c of named) nameOf.set(c.id, (c.customer_name ?? "").trim());

  const DUP = /(?:さん|様)(?:さん|様)/;
  for (const [table, col, filt] of [["messages", "text", "staff"], ["ai_reply_examples", "ai_draft", null]] as const) {
    const rows: Array<{ t: string; conv: string; at: string }> = [];
    for (let p = 0; p < 14; p++) {
      const since = new Date(Date.now() - 365 * 86400_000).toISOString();
      const { data: d } = filt
        ? await sb.from("messages").select("text, conversation_id, created_at").eq("sender", filt)
            .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999)
        : await sb.from("ai_reply_examples").select("ai_draft, conversation_id, created_at")
            .gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
      const r = (d ?? []) as unknown as Array<Record<string, unknown>>;
      if (r.length === 0) break;
      for (const x of r) { const t = String(x[col] ?? ""); if (t) rows.push({ t, conv: String(x.conversation_id ?? ""), at: String(x.created_at) }); }
      if (r.length < 1000) break;
    }
    const hits = rows.filter((x) => DUP.test(x.t));
    let byName = 0;
    const other: string[] = [];
    for (const h of hits) {
      const n = nameOf.get(h.conv) ?? "";
      // その会話のお客様の名前＋敬称 の形になっているか（名前が敬称で終わる → 二重）
      if (n && ENDS_HONORIFIC.test(n) && h.t.includes(`${n}さん`)) { byName++; continue; }
      other.push(`  [${h.at.slice(5, 16)} 名前=「${n || "?"}」] ${h.t.replace(/\n/g, " ").slice(0, 100)}`);
    }
    console.log(`\n=== ${table}.${col}（${rows.length}件）の「さんさん／様様」: ${hits.length}件 ===`);
    console.log(`  お客様の名前が敬称で終わるため                : ${byName}件`);
    console.log(`  それ以外（別の原因）                         : ${other.length}件`);
    for (const o of other.slice(0, 10)) console.log(o);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
