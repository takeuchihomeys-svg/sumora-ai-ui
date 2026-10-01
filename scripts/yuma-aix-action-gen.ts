// scripts/yuma-aix-action-gen.ts — YUMA の材料で AIX 本体（/api/aix/action）の文を**送らずに**作るだけ（場面ごと）
//
// 2026-10-01 竹内「見積書や他のよく使うAIXテンプレートの部分も改善する。YUMAで徹底的にテスト（ブレインもDEEPSEEK）、最終アンソロピックで」
//   開発サーバ（SIM_BASE）を LLM_TEST_MODE=deepseek-all で起動して回す。最終だけ付けずに起動し直す。生成後に llm_usage_logs の model を確かめる。
//   送信はしない（/api/aix/action は文を返すだけ）。
//
// 実行: SIM_BASE=http://localhost:3310 npx tsx --env-file=.env.local scripts/yuma-aix-action-gen.ts --scene=pcr1,pcr2 [--n=1]
import { requireTestServer } from "./lib/dev-server-test-guard"; // 2026-10-02 竹内「テストはテストやで」: 送る前に開発サーバのテストの印を確かめる（手順書 memory/test_protocol_brain.md）
import { createClient } from "@supabase/supabase-js";
import { dedupeRepeatedEmoji } from "../app/lib/emoji-repeat";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.SIM_BASE ?? "http://localhost:3310";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg("n", "1"));
const WANT = arg("scene", "pcr1").split(",");
const EST_IMG = "https://wfwsmwxakhyxobytszoq.supabase.co/storage/v1/object/public/property-images/aix/dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7/1790814650323_0_smnq2.jpg";

type Scene = { key: string; label: string; action: string; body: Record<string, unknown>; customer?: string[] };
const SCENES: Scene[] = [
  { key: "pcr1", label: "物件確認した 1件・空室・御見積書同封", action: "property_check_result",
    customer: ["エステムコート大阪WESTの805号室まだ空いてますか？"],
    body: { check_pattern: "available", property_names: ["エステムコート大阪WEST 805号室"], prop_statuses: ["available"], property_count: 1, estimate_image_url: EST_IMG, estimate_image_urls: [EST_IMG] } },
  { key: "pcr2", label: "物件確認した 1件・退去予定・御見積書同封", action: "property_check_result",
    customer: ["エステムコート大阪WESTの805号室まだ空いてますか？"],
    body: { check_pattern: "available", property_names: ["エステムコート大阪WEST 805号室"], prop_statuses: ["vacating"], property_vacancy_dates: ["2026年11月下旬"], property_count: 1, estimate_image_url: EST_IMG, estimate_image_urls: [EST_IMG] } },
  { key: "pcr3", label: "物件確認した 3件送られて1件募集中（他2件募集終了）・御見積書同封", action: "property_check_result",
    customer: ["この3件空いてますか？"],
    body: { check_pattern: "available", property_names: ["エステムコート大阪WEST 805号室"], prop_statuses: ["available"], property_count: 1, sent_property_count: 3, estimate_image_url: EST_IMG, estimate_image_urls: [EST_IMG] } },
  { key: "pcr4", label: "物件確認した 全部募集終了（2件）", action: "property_check_result",
    customer: ["この2件空いてますか？"],
    body: { check_pattern: "unavailable", sent_property_count: 2 } },
  { key: "pcr5", label: "物件確認した 2件とも退去予定・御見積書同封", action: "property_check_result",
    customer: ["この2件空いてますか？"],
    body: { check_pattern: "available", property_names: ["エステムコート大阪WEST 805号室", "プレサンス梅田北ザ・ライブ 305号室"], prop_statuses: ["vacating", "vacating"], property_vacancy_dates: ["2026年11月下旬", "2026年12月上旬"], property_count: 2, estimate_image_urls: [EST_IMG, EST_IMG] } },
  { key: "vi1", label: "内覧調整（候補日を出す）", action: "viewing_invite",
    customer: ["プレサンス梅田北ザ・ライブ305号室を内覧したいです！"],
    body: { calendar_info: "10/3（土）11:00〜18:30\n10/4（日）11:00〜18:30", property_names: ["プレサンス梅田北ザ・ライブ 305号室"] } },
];

async function main() {
  await requireTestServer(BASE, "yuma-aix-action-gen");
  const { data: c } = await sb.from("conversations").select("account, customer_name, status, line_user_id").eq("id", Y).single();
  const cc = c as { account: string; customer_name: string; status: string };
  if (cc.customer_name !== "YUMA") throw new Error("not YUMA");
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(15);
  const base = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), createdAt: String(m.created_at), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  for (const sc of SCENES.filter((s) => WANT.includes(s.key))) {
    console.log(`\n━━━━ ${sc.label}`);
    const now = Date.now();
    const recent = [...base, ...(sc.customer ?? []).map((t, i) => ({ sender: "customer", text: t, createdAt: new Date(now - (3 - i) * 60_000).toISOString(), rawCreatedAt: new Date(now - (3 - i) * 60_000).toISOString(), isAix: false }))];
    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      const r = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: sc.action, account: cc.account ?? "sumora", conversation_id: Y, customer_name: "YUMA", recent_messages: recent, conversation_status: cc.status, ...sc.body,
      }), signal: AbortSignal.timeout(240_000) });
      const j = await r.json().catch(() => ({})) as Record<string, unknown>;
      const text = String(j.message_text ?? "");
      const rep = dedupeRepeatedEmoji(text).changes.length;
      console.log(`\n[${sc.key}-${i + 1}] ${((Date.now() - t0) / 1000).toFixed(1)}s ${r.status} ${text.length}字${rep ? " ⚠絵文字の重複" : ""}${/お待たせ/.test(text) ? " ⚠お待たせ" : ""}${/引き続き/.test(text) ? " ⚠引き続き" : ""}${/お申込みしお部屋/.test(text) ? " [申込]" : ""}${/ご査収/.test(text) ? " [ご査収]" : ""}${j.error ? ` ERROR:${String(j.error)}` : ""}${j.notice ? ` notice:${String(j.notice).slice(0, 60)}` : ""}\n${text}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
