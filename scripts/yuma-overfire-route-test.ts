// scripts/yuma-overfire-route-test.ts — 最終チェックの誤発火の線（2026-10-02）を generate-reply の本物の経路で確かめる（YUMA・書かない呼び方）
//   A 今の家の解約＋探している → SENSITIVE_CASE が付かない
//   B 内覧の後のお礼（お客様「本日はお時間を作っていただき、ありがとうございました」）→ DONE_PRESUPPOSED（viewing_thanks）の block が付かない
//   C 内覧のキャンセル → SENSITIVE_CASE が付く（本物は今までどおり）
// 手順書 memory/test_protocol_brain.md。実行: LLM_TEST_MODE=deepseek-all（試行）／LLM_TEST_FINAL_CLAUDE=1（最後）npx tsx --env-file=.env.local scripts/yuma-overfire-route-test.ts
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
let h: LlmTestHarness | null = null;
const made: string[] = [];
type Scene = { label: string; staff: string; customer: string; check: (codes: string[]) => boolean; want: string };
const SCENES: Scene[] = [
  { label: "A 今の家の解約＋探している", staff: "YUMAさんお世話になっております！！\n石橋阪大前周辺からオススメのお部屋ピックアップさせて頂きます！！",
    customer: "おはようございます。\n\n最寄り駅石橋阪大前6万までの1DK.1LDK,1Kの物件ありますか？\n明日物件解約します。\n\n入居が10/1に予定してます。",
    check: (c) => !c.some((x) => x.startsWith("SENSITIVE_CASE")), want: "SENSITIVE_CASE なし" },
  { label: "B 内覧の後のお礼", staff: "YUMAさん本日13時に現地にてお待ちしております！！",
    customer: "承知致しました！\n本日はお時間を作っていただき、ありがとうございました！\nまた2人で話し合ったうえで、ご相談させていただきます。",
    check: (c) => !c.includes("DONE_PRESUPPOSED_WITHOUT_EVIDENCE:block"), want: "内覧後のお礼に DONE_PRESUPPOSED の block なし" },
  { label: "C 内覧のキャンセル（本物）", staff: "YUMAさん明日13時に現地にてお待ちしております！！",
    customer: "すみません、明日の内覧はキャンセルでお願いします🙇‍♀️",
    check: (c) => c.some((x) => x.startsWith("SENSITIVE_CASE")), want: "SENSITIVE_CASE あり" },
];

async function main() {
  h = await setupLlmTest("yuma-overfire-route-test");
  h.assertYuma(YUMA);
  await h.waitUntilYumaQuiet([]);
  const { POST } = await import("../app/api/generate-reply/route");
  let ng = 0;
  for (const sc of SCENES) {
    h.assertSceneSafe([sc.staff, sc.customer], sc.label);
    const times = h.sceneTimes(2);
    const ins = await sb.from("messages").insert([
      { conversation_id: YUMA, sender: "staff", text: sc.staff, created_at: times[0] },
      { conversation_id: YUMA, sender: "customer", text: sc.customer, created_at: times[1] },
    ]).select("id");
    if (ins.error) throw new Error(ins.error.message);
    const ids = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    made.push(...ids);
    try {
      const meta = { action: null, reply_mode: "reply", enforcement_level: "recommended", reply_direction: "お客様の発言に沿って短く返す", key_topics: [], avoid_topics: [], analyzed_msg_ts: times[1] };
      const body = {
        message: sc.customer, customerMessages: [sc.customer], state: "proposing", conversationId: YUMA, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
        recentMessages: [{ sender: "staff", text: sc.staff, createdAt: times[0], isAix: false }, { sender: "customer", text: sc.customer, createdAt: times[1], isAix: false }],
        brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: null, brainAnalyzedAt: new Date().toISOString() },
        shadowNoWrite: true,
      };
      const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never);
      const raw = await (res as Response).text();
      const m = raw.match(/<<<FINAL_CHECK:([\s\S]*?)>>>/);
      const fc = m ? JSON.parse(m[1]) as { issues?: Array<{ code: string; severity: string }>; pre_revision_issues?: string[] } : null;
      const codes = [...(fc?.issues ?? []).map((i) => `${i.code}:${i.severity}`), ...(fc?.pre_revision_issues ?? [])];
      const text = raw.slice(raw.indexOf("\n") + 1).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
      const ok = !!fc && sc.check(codes);
      if (!ok) ng++;
      console.log(`\n${ok ? "✅" : "❌"} ${sc.label}（期待: ${sc.want}）\n   指摘: ${codes.join(",") || "なし"}\n   案: ${text.replace(/\n/g, " ／ ").slice(0, 200)}`);
    } finally {
      await sb.from("messages").delete().in("id", ids);
    }
  }
  console.log(`\n結果: ${SCENES.length - ng}/${SCENES.length}`);
  if (ng) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (made.length) { await sb.from("messages").delete().in("id", made); console.log(`後片付け: 場面の通 ${made.length}件を id で削除`); }
    if (h) await h.finish();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
