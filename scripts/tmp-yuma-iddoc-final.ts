// tmp: 最終テスト（本番と同じ組み合わせ）— YUMA にみことさんと同じ本人確認書類の質問を一時的に入れ、本番の /api/generate-reply で下書きを N 回作る（送らない）。
//   終わったら入れた発言を消す。2026-10-01 竹内「マイナンバー持っているので、マイナンバーカードの部分で伝えたら大丈夫。パスポートに関して触れなくて大丈夫」
// 実行: npx tsx --env-file=.env.local scripts/tmp-yuma-iddoc-final.ts   （N=2・BASE=https://sumora-ai-ui.vercel.app）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE ?? "https://sumora-ai-ui.vercel.app";
const N = Number(process.env.N ?? 2);
const Q = "よろしくお願いします。\n本人確認書類がマイナンバー、パスポート両方あるのですが審査通るまでどのくらいの期間見といたらいいですか？";

async function main() {
  const t0 = new Date().toISOString();
  const { data: ins, error } = await sb.from("messages").insert({ conversation_id: Y, sender: "customer", text: Q, created_at: t0 }).select("id").single();
  if (error) throw new Error(error.message);
  const insertedId = (ins as { id: string }).id;
  try {
    const { data: conv } = await sb.from("conversations").select("customer_name, status, has_viewed").eq("id", Y).single();
    const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(25);
    const all = ((ms ?? []) as Array<Record<string, unknown>>).reverse();
    const c = conv as Record<string, unknown>;
    const body = { message: Q, customerMessages: [Q], state: String(c.status ?? "proposing"), conversationId: Y, customerName: String(c.customer_name), hasViewed: !!c.has_viewed, activeTaskTypes: [] as string[],
      recentMessages: all.map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated })) };
    for (let i = 1; i <= N; i++) {
      const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(280_000) });
      const raw = await res.text();
      const nl = raw.indexOf("\n");
      const text = nl >= 0 && raw.startsWith("{") ? raw.slice(nl + 1) : raw;
      const fc = text.match(/<<<FINAL_CHECK:([\s\S]*?)>>>/)?.[1] ?? "";
      const visible = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
      console.log(`\n=== ${i}回目 HTTP ${res.status} ===\n${visible}\n--- パスポート: ${/パスポート/.test(visible) ? "あり ✗" : "なし ✓"} ／ マイナンバー: ${/マイナンバー/.test(visible) ? "あり ✓" : "なし"} ／ 指摘: ${(fc.match(/"code":"[A-Z_]+"/g) ?? []).join(" ") || "-"}`);
    }
  } finally {
    await sb.from("messages").delete().eq("id", insertedId);
    console.log("\n入れた発言を消した:", insertedId);
  }
  await new Promise((r) => setTimeout(r, 4000));
  const { data: llm } = await sb.from("llm_usage_logs").select("action,model").eq("conversation_id", Y).gte("created_at", t0);
  console.log("llm:", (llm ?? []).map((l) => `${(l as Record<string, string>).action}:${(l as Record<string, string>).model}`).join(", "));
}
main().catch((e) => { console.error(e); process.exit(1); });
