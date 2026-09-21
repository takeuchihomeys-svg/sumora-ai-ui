// セル衝突の解決が本番のコードで効くかを直接見る（YUMA・生成のみ）
//
// 2026-09-21 竹内「ブレインが勝つようにする／YUMAでテストもして」
//
// bg-async 経由だとブレインが AIX【物件ピックアップ】を選んで下書きが作られず、生成文まで届かなかった。
// ここでは **generate-reply を直接**呼んでプロンプトを組ませ、サーバーログの [brain-wins-cell] で
// 「avoid を消していない・必須要素に注記が付いた」を確かめる。
//   ※ ブレインの判断は DB の値をそのまま使う（YUMA の avoid_topics: 来阪/見積書/初期費用/…）
//
// ⚠ 書き込みを伴う（下書き欄が書き換わる）。前後で yuma-snapshot.ts save/restore すること。
// 実行: npx tsx --env-file=.env.local scripts/yuma-conflict-probe.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

/** セルが「初期費用を抑える宣言」を必須にする場面＝お客様が条件を変えた時 */
const CUSTOMER = "やっぱり家賃4万円以内で、猫2匹なので広めでお願いします";

async function main() {
  const { data: conv } = await sb.from("conversations")
    .select("customer_name, status, has_viewed, suggested_aix_meta").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  const meta = (c.suggested_aix_meta ?? {}) as Record<string, unknown>;
  console.log(`=== ブレインの判断（DB の今の値）===`);
  console.log(`   返信方向  : ${String(meta.reply_direction ?? "（なし）").slice(0, 90)}`);
  console.log(`   避ける話題: ${((meta.avoid_topics as string[] | undefined) ?? []).join(" / ") || "（なし）"}\n`);

  const { data: ms } = await sb.from("messages")
    .select("sender, text, image_url, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: true }).limit(200);
  const all = (ms ?? []) as unknown as Array<Record<string, unknown>>;
  const recentMessages = all.slice(-25).map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""),
    imageUrl: (m.image_url as string | null) ?? undefined,
    createdAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));

  console.log(`=== generate-reply を直接呼ぶ（プロンプトを組ませる）===`);
  let text = "";
  try {
    const res = await fetch(`${BASE}/api/generate-reply`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: CUSTOMER, customerMessages: [CUSTOMER],
        state: String(c.status ?? "proposing"), conversationId: YUMA,
        customerName: String(c.customer_name ?? "YUMA"),
        hasViewed: !!c.has_viewed, activeTaskTypes: [] as string[],
        recentMessages: [...recentMessages, { sender: "customer", text: CUSTOMER, createdAt: new Date().toISOString(), isAix: false }],
      }),
    });
    const raw = await res.text();
    const nl = raw.indexOf("\n");
    text = nl >= 0 ? raw.slice(nl + 1) : raw;
  } catch (e) { text = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
  const out = text.replace(/\n?<<<[A-Z_]{3,}[\s\S]*?(?:>>>|$)/g, "").trim();
  console.log(`   生成文: ${out.replace(/\n/g, " ／ ").slice(0, 240) || "（なし）"}`);

  const avoidHit = /御?見積(?:書|り)|初期費用[:：]|[0-9０-９,]{4,}円/.test(out);
  console.log(`\n   避けるべき語（見積書・初期費用の金額）に触れたか: ${avoidHit ? "⚠ 触れた" : "✅ 触れていない"}`);
  console.log(`\n   ※ サーバーのログで [brain-wins-cell] を確認すること（mode / annotated / dropped / avoidKept）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
