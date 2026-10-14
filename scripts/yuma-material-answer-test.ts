// yuma-material-answer-test.ts — 区切り3: 物件資料に書いてある事の質問で、ブレインと返信の下書きが資料（物件検索ブレインの読み取り）で答えるか（YUMA で前と後）
//   実物の場面を YUMA に写す（伏せ字・申込の書類の手前で切る・未来の時刻）→ その番の「送った物件の資料の画像」を YUMA の sent_image_properties に1行だけ足す
//   → ブレイン（analyzeConversation）→ ブレインの答案で generate-reply（shadowNoWrite）→ 自分の行だけ消す
//   場面: 055d4212（会話 22b2511e・「ここって洗面台とトイレ一緒な感じですか？」→ 竹内さん「…洗面台とトイレが同じ間取りであるアメリカンセパレートの間取りとなります！！」）
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-material-answer-test.ts [--repeat=2] [--off]（--off＝MATERIAL_ANSWER=off の前）
import { createClient } from "@supabase/supabase-js";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const flag = (k: string) => process.argv.includes(`--${k}`);
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
type Scene = { source: string; askedAt: string; last: number; property: string; imageUrl: string };
const SCENES: Record<string, Scene> = {
  "055d4212": {
    source: "22b2511e-034e-44f4-8c10-b737716a3284", askedAt: "2026-10-09T11:21:30+00:00", last: 8, property: "エステムコート難波IVアトリ",
    imageUrl: "https://wfwsmwxakhyxobytszoq.supabase.co/storage/v1/object/public/property-images/aix/22b2511e-034e-44f4-8c10-b737716a3284/1791537562664_0_bzmsp.jpeg",
  },
};
let h: LlmTestHarness | null = null;
let ownMsgs: string[] = [];
let ownSip: Array<{ image_url: string; created_at: string }> = [];

async function main() {
  if (flag("off")) process.env.MATERIAL_ANSWER = "off";
  process.env.MATERIAL_ANSWER_NO_SAVE = "1";
  h = await setupLlmTest(`yuma-material-answer-test${flag("off") ? "-off" : ""}`);
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  const { MSG_SEP } = await import("../app/lib/reply-context");
  const { maskPII } = await import("../app/lib/pii-mask");
  const sc = SCENES[arg("scene", "055d4212")];
  const repeat = Number(arg("repeat", "1"));
  await h.waitUntilYumaQuiet([]);
  // 場面の時刻までの通（質問の通を含む）を写す
  const { data: conv } = await sb.from("conversations").select("status, customer_name").eq("id", sc.source).maybeSingle();
  const { data: msgs } = await sb.from("messages").select("sender, text, is_aix_generated, created_at").eq("conversation_id", sc.source).lte("created_at", sc.askedAt).order("created_at", { ascending: false }).limit(sc.last);
  const ordered = ((msgs ?? []) as Array<{ sender: string; text: string | null; is_aix_generated: boolean | null; created_at: string }>).reverse();
  const cut = h.cutBeforeApplicationMaterial(ordered);
  const name = String((conv as { customer_name?: string } | null)?.customer_name ?? "").trim();
  const texts = cut.kept.map((m) => maskPII(name.length >= 2 ? String(m.text ?? "").split(name).join("YUMA") : String(m.text ?? ""), []));
  h.assertSceneSafe(texts, `material:${sc.source.slice(0, 8)}`);
  const times = h.sceneTimes(texts.length, { offsetMin: 3, stepSec: 30 });
  const rows = cut.kept.map((m, i) => ({ conversation_id: YUMA, sender: m.sender === "customer" ? "customer" : "staff", text: texts[i], is_aix_generated: !!m.is_aix_generated, created_at: times[i] }));
  const ins = await sb.from("messages").insert(rows).select("id");
  if (ins.error) throw new Error(ins.error.message);
  ownMsgs = (ins.data ?? []).map((r: { id: string }) => r.id);
  // 送った資料の画像（質問の前の最後のこちらの通の時刻）
  const lastStaffIdx = rows.map((r) => r.sender).lastIndexOf("staff");
  const sipAt = times[Math.max(0, lastStaffIdx)];
  const sip = await sb.from("sent_image_properties").insert({ conversation_id: YUMA, property_name: sc.property, room_no: null, channel: "check", created_at: sipAt, image_url: `${sc.imageUrl}?yuma-test=1` }).select("image_url, created_at");
  if (sip.error) throw new Error(`sent_image_properties: ${sip.error.message}`);
  ownSip = (sip.data ?? []) as Array<{ image_url: string; created_at: string }>;
  console.log(`YUMA に ${rows.length}通・送った資料1行（${sc.property}）・MATERIAL_ANSWER=${process.env.MATERIAL_ANSWER ?? "on"}`);
  const customer = (() => { const out: string[] = []; for (let i = rows.length - 1; i >= 0 && rows[i].sender === "customer"; i--) out.unshift(rows[i].text); return out; })();
  for (let i = 0; i < repeat; i++) {
    const meta = await runInDeepseekScope(async () => {
      setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
      return analyzeConversation(YUMA, true, (conv as { status?: string } | null)?.status ?? "proposing", null, "brain", { autoSendEnabled: false, customerName: "YUMA", mode: "full", layer: "combined", strategy: null });
    });
    const m = (meta ?? {}) as Record<string, unknown>;
    const tc = m.turn_contract as { asks?: Array<{ route?: string; answer?: string }> } | undefined;
    console.log(`#${i + 1} ブレイン: mode=${m.reply_mode} action=${m.action ?? null} routes=${JSON.stringify((tc?.asks ?? []).map((a) => `${a.route}:${String(a.answer ?? "").slice(0, 40)}`))} dir=${String(m.reply_direction ?? "").slice(0, 120)}`);
    const body = {
      message: customer.join(MSG_SEP), customerMessages: customer, state: "proposing", conversationId: YUMA, customerName: "YUMA",
      hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
      recentMessages: rows.map((r, k) => ({ sender: r.sender, text: r.text, createdAt: times[k], isAix: r.is_aix_generated })),
      brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: null, brainAnalyzedAt: new Date().toISOString() },
      shadowNoWrite: true, testSceneMaterials: "on",
    };
    const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
    const raw = await res.text();
    const draft = raw.replace(/<<<[\s\S]*?>>>/g, "").split("\n").filter((l) => !/^\{"ok"/.test(l)).join("\n").trim();
    console.log(`#${i + 1} 下書き: ${draft.replace(/\n/g, " ／ ").slice(0, 300)}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (ownMsgs.length) await sb.from("messages").delete().in("id", ownMsgs);
  for (const r of ownSip) await sb.from("sent_image_properties").delete().eq("conversation_id", YUMA).eq("image_url", r.image_url).eq("created_at", r.created_at);
  console.log(`片付け: YUMA の通 ${ownMsgs.length}・送った資料 ${ownSip.length}`);
  if (h) await h.finish();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
});
