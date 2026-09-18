// scripts/audit-waiting-commitment.ts
// 「待ちが生まれた場面」の判定（app/lib/waiting-commitment.ts）を本番のスタッフ実送信 365日に当て、
// 拾った文と取り出した日付を人が読める形で出す＝誤発火の点検。
//
// 2026-09-18 竹内（𝒮❦ 事例）「この状況だとお客さんと約束して信頼関係を結ぶ形とする」の実装時に作成。
// 初回の実測: スタッフ実送信 11,801通 → 9通だけ拾い、9通とも「お客様がいつ頃お申込みすればよいか」の
//   報告で、取り出した日付も全て正しかった（誤発火 0）。
// 判定の正規表現を変えた時は必ずこれを流し、拾う件数と中身が変わっていないか見る。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-waiting-commitment.ts
import { createClient } from "@supabase/supabase-js";
import { resolveWaitingSituation, contactDateLabel } from "../app/lib/waiting-commitment";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 365);

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ text: string; created_at: string }> = [];
  // PostgREST は1回 1000行までなので順に読む
  for (let page = 0; page < 40; page++) {
    const { data, error } = await sb
      .from("messages")
      .select("text, created_at")
      .neq("sender", "customer")
      .gte("created_at", since)
      .not("text", "is", null)
      .order("created_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as Array<{ text: string; created_at: string }>));
    if (data.length < 1000) break;
  }

  const hits: string[] = [];
  for (const m of rows) {
    const s = resolveWaitingSituation(m.text, m.created_at);
    if (!s) continue;
    const day = new Date(m.created_at).toLocaleDateString("ja-JP");
    hits.push(`${day}  →${contactDateLabel(s)}  【${s.evidence}】\n    ${m.text.replace(/\n/g, " ").slice(0, 110)}`);
  }

  console.log(`スタッフ実送信 ${rows.length} 通（直近 ${DAYS} 日）中、待ちの場面として拾ったのは ${hits.length} 通\n`);
  for (const h of hits) console.log(h + "\n");
  console.log("※ 拾った文が「お客様がいつ頃お申込みすればよいか」の報告になっているか、日付が正しいかを目で確かめる");
}

main().catch((e) => { console.error(e); process.exit(1); });
