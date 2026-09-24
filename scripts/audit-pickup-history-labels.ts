// 監査（読み取りだけ）: AIX の履歴の入口（app/lib/pickup-send-facts.ts）がスタッフの実送信のどれに当たるかを数えて、当たった本文を読む
//   ・社内の説明文として中身ごと伏せる行（isInternalPropertyCard）→ 実際にお客様向けに書いた文を伏せていないか（誤伏せ0か）
//   ・前回の物件送付の文として印を付ける行（isPastPickupSend）→ 件数と例
// 使い方: npx tsx --env-file=.env.local scripts/audit-pickup-history-labels.ts [--days=90] [--out=ファイル]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isInternalPropertyCard, isPastPickupSend } from "../app/lib/pickup-send-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const DAYS = Number(arg("days") ?? 90);
const OUT = arg("out");

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  let total = 0, card = 0, past = 0;
  const cardRows: string[] = [];
  const pastRows: string[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("messages").select("id, text, created_at, conversation_id")
      .eq("sender", "staff").gte("created_at", since).not("text", "is", null)
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string; text: string; created_at: string; conversation_id: string }>;
    for (const r of rows) {
      total++;
      if (isInternalPropertyCard(r.text)) { card++; cardRows.push(`[${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)}] ${r.text.replace(/\n/g, " / ").slice(0, 160)}`); }
      else if (isPastPickupSend("staff", r.text)) { past++; if (pastRows.length < 15) pastRows.push(`[${r.created_at.slice(0, 16)}] ${r.text.replace(/\n/g, " / ").slice(0, 160)}`); }
    }
    if (rows.length < 1000) break;
    from += 1000;
  }
  const lines = [
    `スタッフの文 ${total}通（${DAYS}日）`,
    `社内の説明文として伏せる: ${card}通（全件を下に並べる・お客様向けの文が混ざっていないか目で読む）`,
    ...cardRows,
    ``,
    `前回の物件送付として印を付ける: ${past}通（例15件）`,
    ...pastRows,
  ];
  const text = lines.join("\n");
  if (OUT) writeFileSync(OUT, text, "utf8"); else console.log(text);
}
main().catch((e) => { console.error(e); process.exit(1); });
