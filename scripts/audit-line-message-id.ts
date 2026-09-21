// こちらの送信に line_message_id が付いているか（＝引用された時に引用先を特定できるか）
//
// 2026-09-21: 引用返信460件のうち **82件（17.8%）は引用先のメッセージが見つからない**。
//   引用先が分からないと、物件も資料の中身も渡せない（引用の仕組みの土台）。
//   messages.line_message_id は LINE の push 応答（sentMessages[].id）を書き戻して入る。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-line-message-id.ts [--days=30]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);

async function count(kind: "image" | "text") {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  let total = 0, withId = 0;
  for (let p = 0; p < 20; p++) {
    let q = sb.from("messages").select("line_message_id, image_url").eq("sender", "staff").gte("created_at", since);
    q = kind === "image" ? q.not("image_url", "is", null) : q.is("image_url", null);
    const { data, error } = await q.range(p * 1000, p * 1000 + 999);
    if (error) { console.log("⚠", error.message); break; }
    const rows = (data ?? []) as Array<{ line_message_id: string | null }>;
    total += rows.length; withId += rows.filter((r) => !!r.line_message_id).length;
    if (rows.length < 1000) break;
  }
  console.log(`スタッフの${kind === "image" ? "画像" : "文"}: ${total}通中 line_message_id あり ${withId}（${total ? ((withId / total) * 100).toFixed(1) : 0}%）`);
}

async function main() {
  console.log(`=== 直近${DAYS}日 ===`);
  await count("image");
  await count("text");
}
main().catch((e) => { console.error(e); process.exit(1); });
