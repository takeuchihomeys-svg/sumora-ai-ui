// scripts/anatomy-aix-second-pairs.ts — 物件ピックアップ・物件オススメの AIX の2通目: AI のテンプレートの文（aix_generate_log）と竹内さんが実際に送った文を並べて伏せ、exam-cache に置く
//   2026-11-12 作業員5（竹内さん 11/12「AIX の文の2通目の AIX テンプレートの部分の質が悪いので、実際の竹内のように改善する。特に物件ピックアップと物件オススメ」）。
//   LLM を呼ばない・DB は読むだけ（夜・期間を区切る・場面ごとに limit）。申込の門で外す・YUMA の会話は外す。伏せは anatomy-aix-exemplars と同じ。
//   1通目（その直前に竹内さんが送った物件の文・🌟カード）と、直前のお客様の発言と、その時のブレインの記録（digest の気持ち・刺さり・誘導の欄）も並べる。
// 実行: npx tsx --env-file=<サーバーの鍵のある .env> scripts/anatomy-aix-second-pairs.ts [--days=90] [--per=15]
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(process.cwd(), "..", "..", "exam-cache");
const SCENES = ["compare", "new_listing", "followup_single", "alternative", "first"];
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
  const { loadTurnApplicationRecords } = await import("../app/lib/turn-application-gate-server");
  const { turnApplicationReason } = await import("../app/lib/turn-application-gate");
  const { maskCustomerNames, customerNameTokens, staffHeadNames } = await import("../app/lib/compose-name-mask");
  const { maskSelfIntroducedNames, selfIntroducedNames } = await import("../app/lib/self-name-mask");
  const { maskPII } = await import("../app/lib/pii-mask");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - (Number(arg("days", "90")) || 90) * 86_400_000).toISOString();
  const per = Number(arg("per", "15")) || 15;
  const out: Array<Record<string, unknown>> = [];
  for (const sc of SCENES) {
    const { data, error } = await sb.from("aix_generate_log").select("conversation_id, created_at, generated_text, conditions_snapshot")
      .eq("action_type", "property_recommendation").gte("created_at", since).neq("conversation_id", YUMA_CONVERSATION_ID)
      .filter("conditions_snapshot->>source", "eq", "aix-template-generate").filter("conditions_snapshot->>scenario", "eq", sc).order("created_at", { ascending: false }).limit(80);
    if (error) throw new Error(error.message);
    const seen = new Set<string>(); let got = 0;
    for (const g of (data ?? []) as Array<{ conversation_id: string; created_at: string; generated_text: string; conditions_snapshot: Record<string, unknown> }>) {
      if (got >= per || seen.has(g.conversation_id)) continue;
      const hi = new Date(Date.parse(g.created_at) + 20 * 60_000).toISOString(), lo = new Date(Date.parse(g.created_at) - 15 * 60_000).toISOString();
      const { data: ms } = await sb.from("messages").select("sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", g.conversation_id).gte("created_at", lo).lte("created_at", hi).order("created_at").limit(30);
      await sleep(60);
      const list = (ms ?? []) as Array<{ sender: string; text: string | null; created_at: string; staff_writer: string | null }>;
      const sent = list.find((m) => m.sender === "staff" && m.staff_writer === "takeuchi" && m.created_at >= g.created_at && !String(m.text ?? "").startsWith("[画像]") && String(m.text ?? "").length > 15);
      if (!sent) continue;
      const first = list.filter((m) => m.sender === "staff" && m.created_at < g.created_at && !String(m.text ?? "").startsWith("[画像]") && String(m.text ?? "").length > 15).slice(-1)[0];
      const rec = await loadTurnApplicationRecords(sb, g.conversation_id); await sleep(60);
      if (turnApplicationReason(rec, sent.created_at)) continue;
      const { data: cs } = await sb.from("messages").select("sender, text").eq("conversation_id", g.conversation_id).lt("created_at", first?.created_at ?? g.created_at).order("created_at", { ascending: false }).limit(10);
      await sleep(60);
      const prev = (cs ?? []) as Array<{ sender: string; text: string | null }>;
      const cust: string[] = []; for (const x of prev) { if (x.sender === "staff") { if (cust.length) break; continue; } cust.unshift(String(x.text ?? "")); }
      const { data: d } = await sb.from("brain_decision_logs").select("digest, suggested_action").eq("conversation_id", g.conversation_id).lte("created_at", g.created_at).order("created_at", { ascending: false }).limit(1);
      await sleep(60);
      const dg = ((d ?? [])[0] as { digest?: Record<string, unknown>; suggested_action?: string } | undefined);
      const { data: cv } = await sb.from("conversations").select("customer_name, call_name").eq("id", g.conversation_id).maybeSingle();
      const c = (cv ?? {}) as { customer_name?: string | null; call_name?: string | null };
      const tokens = customerNameTokens([c.customer_name, c.call_name, ...staffHeadNames([sent.text, first?.text, g.generated_text, ...prev.filter((x) => x.sender === "staff").map((x) => x.text)]), ...selfIntroducedNames(cust.join("\n"))]);
      const mask = (t: string | null | undefined) => maskPII(maskCustomerNames(String(t ?? ""), tokens)).replace(/https?:\/\/\S+/g, "〈URL〉").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉");
      out.push({
        scene: sc, pickup_type: g.conditions_snapshot?.pickup_type ?? null, at: g.created_at,
        customer: maskSelfIntroducedNames(mask(cust.join("\n"))).slice(0, 300),
        first: mask(first?.text).slice(0, 700), ai: mask(g.generated_text).slice(0, 900), takeuchi: mask(sent.text).slice(0, 900),
        brain: dg?.digest ? { act: dg.suggested_action ?? null, emo: dg.digest.emo ?? null, ms: dg.digest.ms ?? null, mg: dg.digest.mg ?? null, concern: dg.digest.concern ?? null, dir: String(dg.digest.dir ?? "").slice(0, 120) } : null,
      });
      seen.add(g.conversation_id); got++;
    }
    console.log(`${sc}: ${got}組`);
  }
  const dir = join(CACHE, "anatomy-seven"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "aix-second-pairs.json"), JSON.stringify(out, null, 1));
  console.log(`合計 ${out.length}組 → exam-cache/anatomy-seven/aix-second-pairs.json`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
