// scripts/yuma-aix-template-gen.ts — YUMA の材料で AIX テンプレート（2通目）を**送らずに**生成だけ回す（場面ごと・N 回）
//
// 2026-10-01 竹内「見積書や他のよく使うAIXテンプレートの部分も改善する。YUMAで徹底的にテスト（ブレインもDEEPSEEK）、最終アンソロピックで」
//   開発サーバを LLM_TEST_MODE=deepseek-all で起動した上で回す（最終だけ付けずに起動し直す）。生成後に llm_usage_logs の model を確かめる。
//   送信はしない（/api/aix-template-generate は文を返すだけ）。YUMA への書き込みは生成の記録（llm_usage_logs 等）だけ。
//
// 実行: SIM_BASE=http://localhost:3310 npx tsx --env-file=.env.local scripts/yuma-aix-template-gen.ts --scene=est1,est2 --n=3 [--cta=viewing|apply]
import { requireTestServer } from "./lib/dev-server-test-guard"; // 2026-10-02 竹内「テストはテストやで」: 送る前に開発サーバのテストの印を確かめる（手順書 memory/test_protocol_brain.md）
import { createClient } from "@supabase/supabase-js";
import { styleStatsOf } from "../app/lib/second-message-style";
import { dedupeRepeatedEmoji } from "../app/lib/emoji-repeat";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.SIM_BASE ?? "http://localhost:3310";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg("n", "3"));
const WANT = arg("scene", "est1").split(",");
const CTA = arg("cta", "") as "" | "viewing" | "apply";

const EST1 = "【エステムコート大阪WEST 805号室】\n\n初期費用さらに\n🌟124,050円割引させて頂き\n初期費用：137,980円\n\nスモラなら一般的な不動産業者より269,570円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。";
const EST2 = "①【レオンコンフォート難波クレア 503号室】\n\n初期費用さらに\n🌟40,000円割引させて頂き\n初期費用：102,000円\n\nスモラなら一般的な不動産業者より120,300円節約出来ます！！\n\n②【Luxe難波西2 1103号室】\n\n初期費用さらに\n🌟63,000円割引させて頂き\n初期費用：79,300円\n\nスモラなら一般的な不動産業者より140,000円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。";

type Scene = { key: string; label: string; action: string; category: string; first: string; customer?: string[]; staffToday?: boolean };
const SCENES: Scene[] = [
  { key: "est1", label: "見積書 1件（お客様が気に入った部屋の見積もり依頼）", action: "estimate_sheet", category: "見積書送る【AIX】", first: EST1,
    customer: ["エステムコート大阪WESTの805号室が気になってます。初期費用いくらになりますか？"] },
  { key: "est2", label: "見積書 2件（2部屋の見積もり依頼）", action: "estimate_sheet", category: "見積書送る【AIX】", first: EST2,
    customer: ["レオンコンフォート難波クレアとLuxe難波西2の見積もりもらえますか？"] },
  { key: "est3", label: "見積書 1件（内覧の後・前向き。YUMA は エステムコート大阪WEST の待ち合わせ場所を送っている）", action: "estimate_sheet", category: "見積書送る【AIX】", first: EST1,
    customer: ["今日はありがとうございました！エステムコート大阪WESTかなり良かったです。費用の見積もりください"] },
  { key: "est5", label: "見積書 1件（内覧の前・前向き）", action: "estimate_sheet", category: "見積書送る【AIX】", first: EST1.replace("エステムコート大阪WEST 805号室", "プレサンス梅田北ザ・ライブ 305号室"),
    customer: ["プレサンス梅田北ザ・ライブの305号室すごく良いです！気に入りました。見積もりお願いします"] },
  { key: "est4", label: "見積書 1件（今日はまだこちらから送っていない朝）", action: "estimate_sheet", category: "見積書送る【AIX】", first: EST1, staffToday: false,
    customer: ["おはようございます。昨日のエステムコート大阪WESTの見積もりお願いします"] },
];

async function main() {
  await requireTestServer(BASE, "yuma-aix-template-gen");
  const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(10);
  const base = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  const { data: pcr } = await sb.from("property_customers").select("ai_summary").eq("conversation_id", Y).limit(1);
  for (const sc of SCENES.filter((s) => WANT.includes(s.key))) {
    console.log(`\n━━━━ ${sc.label}${CTA ? `／訴求=${CTA}` : ""}\n【1通目】${sc.first.replace(/\n+/g, " ⏎ ").slice(0, 140)}`);
    const now = Date.now();
    const recent = [
      ...base,
      ...(sc.customer ?? []).map((t, i) => ({ sender: "customer", text: t, rawCreatedAt: new Date(now - (5 - i) * 60_000).toISOString(), isAix: false })),
      { sender: "staff", text: "[画像]", rawCreatedAt: new Date(now - 30_000).toISOString(), isAix: true },
      { sender: "staff", text: sc.first, rawCreatedAt: new Date(now - 20_000).toISOString(), isAix: true },
    ].slice(-15);
    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      const r = await fetch(`${BASE}/api/aix-template-generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        actionType: sc.action, actionCategory: sc.category, conversationId: Y, customerName: "YUMA", conversationState: "proposing",
        recentMessages: recent, customerConditions: "", customerSummary: (pcr?.[0] as { ai_summary?: string } | undefined)?.ai_summary ?? null, noEmoji: false,
        pendingScheduledMessages: [], staffMessagedToday: sc.staffToday ?? true, pickupType: null, lastAixCheckPattern: null, sentMessage: sc.first,
        sentMessageSource: "post_aix", ctaPreference: CTA || null,
      }), signal: AbortSignal.timeout(150_000) });
      const j = await r.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string };
      const text = String(j.text ?? "");
      const st = styleStatsOf(text);
      const rep = dedupeRepeatedEmoji(text).changes.length;
      console.log(`\n[${sc.key}-${i + 1}] ${((Date.now() - t0) / 1000).toFixed(1)}s ${text.length}字 文${st.sentences} 絵文字${st.emojis.join("")}${rep ? " ⚠絵文字の重複" : ""}${/お待たせ/.test(text) ? " ⚠お待たせ" : ""}${/[0-9,]{4,}円/.test(text) ? " ⚠金額" : ""}${/お申込|お申し込|抑え/.test(text) ? " [申込]" : ""}${/ご案内|ご内覧/.test(text) ? " [内覧]" : ""}${j.error ? ` ERROR:${j.error}` : ""}\n${text}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
