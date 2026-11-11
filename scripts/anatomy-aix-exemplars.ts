// scripts/anatomy-aix-exemplars.ts — 竹内さんが送った AIX の文を種類ごとに少しずつ集めて伏せ、exam-cache に置く（Claude Code が1文ずつ読んで AIX の文の手本の表を作る材料）
//   2026-11-12 作業員5（竹内さん「AIX と判断する部分も細分化と連携」・KB bfa6bec5 AIX の文で細かい訴求）。LLM を呼ばない・DB は読むだけ（種類ごとに limit・1会話ずつ）。
//   申込以降の番は turn-application-gate で外す・申込へ（application_push）は集めない・YUMA の会話は外す。
//   伏せ: その会話の表示名・呼び名・こちらの文の頭の「〇〇さん」・名乗った本名 → YUMA、maskPII・URL・電話。
// 実行: npx tsx --env-file=<サーバーの鍵のある .env> scripts/anatomy-aix-exemplars.ts [--per=4] [--days=75]
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(process.cwd(), "..", "..", "exam-cache");
const TYPES = ["property_recommendation", "property_send", "property_check_result", "estimate_sheet", "viewing_invite", "meeting_place", "condition_hearing", "cost_explain", "zenryoku_support"];
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
  const { loadTurnApplicationRecords } = await import("../app/lib/turn-application-gate-server");
  const { turnApplicationReason } = await import("../app/lib/turn-application-gate");
  const { maskCustomerNames, customerNameTokens, staffHeadNames } = await import("../app/lib/compose-name-mask");
  const { maskSelfNamesPair } = await import("../app/lib/self-name-mask");
  const { maskPII } = await import("../app/lib/pii-mask");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const per = Number(arg("per", "4")) || 4;
  const since = new Date(Date.now() - (Number(arg("days", "75")) || 75) * 86_400_000).toISOString();
  const out: Array<Record<string, unknown>> = [];
  for (const type of TYPES) {
    const { data, error } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, picker_choices, sent_at, created_at")
      .eq("aix_type", type).not("sent_at", "is", null).gte("created_at", since).neq("conversation_id", YUMA_CONVERSATION_ID).order("created_at", { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    const seen = new Set<string>(); let got = 0;
    for (const a of (data ?? []) as Array<{ conversation_id: string; aix_type: string; check_pattern: string | null; picker_choices: unknown; sent_at: string }>) {
      if (got >= per || seen.has(a.conversation_id)) continue;
      const lo = new Date(Date.parse(a.sent_at) - 3 * 60_000).toISOString(), hi = new Date(Date.parse(a.sent_at) + 3 * 60_000).toISOString();
      const { data: ms } = await sb.from("messages").select("id, text, created_at").eq("conversation_id", a.conversation_id).eq("sender", "staff").eq("staff_writer", "takeuchi").eq("is_aix_generated", true).gte("created_at", lo).lte("created_at", hi).not("text", "like", "[画像]%").order("created_at").limit(3);
      const m = ((ms ?? []) as Array<{ id: string; text: string; created_at: string }>).filter((x) => String(x.text ?? "").length >= 20)[0];
      await sleep(80);
      if (!m) continue;
      const rec = await loadTurnApplicationRecords(sb, a.conversation_id); await sleep(80);
      if (turnApplicationReason(rec, m.created_at)) continue;
      const { data: cs } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", a.conversation_id).lt("created_at", m.created_at).order("created_at", { ascending: false }).limit(8);
      const prev = ((cs ?? []) as Array<{ sender: string; text: string | null }>);
      const cust: string[] = []; for (const x of prev) { if (x.sender === "staff") { if (cust.length) break; continue; } cust.unshift(String(x.text ?? "")); }
      const { data: cv } = await sb.from("conversations").select("customer_name, call_name").eq("id", a.conversation_id).maybeSingle();
      const c = (cv ?? {}) as { customer_name?: string | null; call_name?: string | null };
      const tokens = customerNameTokens([c.customer_name, c.call_name, ...staffHeadNames([m.text, ...prev.filter((x) => x.sender === "staff").map((x) => x.text)])]);
      const mask = (t: string) => maskPII(maskCustomerNames(t, tokens)).replace(/https?:\/\/\S+/g, "〈URL〉").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉");
      const sm = maskSelfNamesPair(mask(cust.join("\n")).slice(0, 300), mask(m.text).slice(0, 900));
      out.push({ id: m.id, type, check: a.check_pattern, picker: a.picker_choices, customer: sm.customer, text: sm.staff });
      seen.add(a.conversation_id); got++;
      await sleep(80);
    }
    console.log(`${type}: ${got}通`);
  }
  const dir = join(CACHE, "anatomy-seven"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "aix-texts.json"), JSON.stringify(out, null, 1));
  console.log(`合計 ${out.length}通 → exam-cache/anatomy-seven/aix-texts.json`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
