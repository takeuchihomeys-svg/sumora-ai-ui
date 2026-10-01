// tmp(コミットしない・2026-10-01 締め v2): --cif＝2通目を送らない（1通目に締め・2通目は作らない）／--later＝テンプレートを後から開いた（sentMessage を渡さない・履歴から補う）／--cta=viewing|apply
// もとは tmp-viewable-pair-gen.ts: AIX【物件オススメ】の1通目（/api/aix/action）→ 2通目（/api/aix-template-generate）を、YUMA の材料で**送らずに**生成だけ回す
// 実行: SIM_BASE=http://localhost:3200 npx tsx --env-file=.env.local scripts/tmp-viewable-pair-gen.ts --ids=2670,2678,2675 --n=3 [--out=名前]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { findAiPhrases } from "../app/lib/second-message-style";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const CAT = "物件オススメ【AIX】";
const BASE = process.env.SIM_BASE ?? "http://localhost:3200";
const SP = "C:/Users/竹内悠~1/AppData/Local/Temp/claude/c--Users-------sumora-ai-ui/90d5437f-9ec8-479d-94e9-1097dde86432/scratchpad";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IDS = arg("ids", "2670,2678,2675").split(",").map(Number);
const N = Number(arg("n", "3"));
const OUT = arg("out", `cv2-${Date.now()}`);
const CIF = args.includes("--cif");
const LATER = args.includes("--later");
const CTA = arg("cta", "") || null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatConditions(c: Record<string, any>): string {
  const lines: string[] = [];
  if (c.desired_area) lines.push(`エリア: ${c.desired_area}`);
  if (c.floor_plan) lines.push(`間取り: ${c.floor_plan}`);
  if (c.rent_max) lines.push(`家賃: ${c.rent_max / 10000}万円以内`);
  if (c.walk_minutes) lines.push(`駅徒歩: ${c.walk_minutes}分以内`);
  if (c.move_in_time) lines.push(`入居: ${c.move_in_time}`);
  if (c.building_age) lines.push(`築年数: ${c.building_age}年以内`);
  if (c.preferences) lines.push(`希望: ${c.preferences}`);
  if (c.ng_points) lines.push(`NG: ${c.ng_points}`);
  if (c.other_requests) lines.push(`その他: ${c.other_requests}`);
  return lines.join("\n");
}

async function main() {
  const { data: conv } = await sb.from("conversations").select("account, customer_name, status").eq("id", Y).single();
  const c = conv as { account: string | null; customer_name: string; status: string };
  const { data: pcr } = await sb.from("property_customers").select("*").eq("id", PC).single();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pc = pcr as Record<string, any>;
  const customerConditions = formatConditions(pc);
  type Tmpl = { id: string; category: string; label: string; text: string; structure?: Array<{ label: string; text: string }> | null; use_count?: number; win_rate?: number | null };
  const tj = await (await fetch(`${BASE}/api/templates`, { cache: "no-store" })).json() as { templates: Tmpl[] };
  const bestTmpl = [...tj.templates.filter((t) => t.category === CAT)].sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0) || (b.use_count ?? 0) - (a.use_count ?? 0))[0] ?? null;
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(25);
  const recent = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  const out: string[] = [];
  const log = (s: string) => { console.log(s); out.push(s); };
  for (const id of IDS) {
    const hj = await (await fetch(`${BASE}/api/property-pickups?ids=${id}`, { cache: "no-store" })).json() as { items?: Array<{ id: number; property_name: string; room_no: string | null; image_url: string | null }> };
    const it = hj.items?.[0];
    const { data: row } = await sb.from("property_pickups").select("terms").eq("id", id).single();
    const ev = (row as { terms?: { evidence?: { moveIn?: string } } } | null)?.terms?.evidence?.moveIn ?? "?";
    log(`\n━━━━ id ${id} ${it?.property_name} ${it?.room_no} ／ 資料: ${ev}`);
    if (!it?.image_url) { log("  画像なし"); continue; }
    for (let i = 0; i < N; i++) {
      const body: Record<string, unknown> = { action: "property_recommendation", account: c.account ?? "sumora", conversation_id: Y, customer_name: c.customer_name ?? "YUMA", recent_messages: recent, conversation_status: c.status,
        image_url: it.image_url, pickup_ids: [it.id], customer_conditions: customerConditions };
      if (CIF) body.closing_in_first = true;
      if (bestTmpl?.structure?.length) body.template_structure = bestTmpl.structure;
      if (bestTmpl?.text) body.template_sample = bestTmpl.text;
      const g = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
      const gj = await g.json().catch(() => ({})) as Record<string, unknown>;
      const text1 = String(gj.message_text ?? "").trim();
      log(`\n[${id}-${i + 1}] 1通目${gj.error ? ` ERROR:${gj.error}` : ""}${gj.notice ? ` notice:${gj.notice}` : ""}\n${text1}`);
      if (!text1) continue;
      log(`   → 1通目: 浅く・${/浅く・/.test(text1) ? "あり⚠" : "なし"}／時期(◯月◯旬)${/\d{1,2}月(?:上旬|中旬|下旬)/.test(text1) ? "あり⚠" : "なし"}／締め${/お気に召され|お手隙の際に/.test(text1) ? "あり" : "なし"}／${text1.length}字`);
      if (CIF) continue;
      const now = new Date().toISOString();
      const recent2 = [...recent.map((m) => ({ sender: m.sender, text: m.text, rawCreatedAt: m.rawCreatedAt, isAix: m.isAix })), { sender: "staff", text: "[画像]", rawCreatedAt: now, isAix: true }, { sender: "staff", text: text1, rawCreatedAt: now, isAix: true }].slice(-15);
      const r = await fetch(`${BASE}/api/aix-template-generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        actionType: "property_recommendation", actionCategory: CAT, conversationId: Y, customerName: c.customer_name ?? "YUMA", conversationState: c.status,
        recentMessages: recent2, customerConditions, customerSummary: pc.ai_summary ?? null, noEmoji: false, pendingScheduledMessages: [], staffMessagedToday: true,
        pickupType: null, lastAixCheckPattern: null, sentMessage: LATER ? null : text1, ctaPreference: CTA,
      }), signal: AbortSignal.timeout(150_000) });
      const j = await r.json().catch(() => ({})) as { text?: string; error?: string };
      const text2 = String(j.text ?? "");
      const both = `${text1}\n${text2}`;
      const flags = [
        `申込の誘導 1通目${(text1.match(/お申込し?み?しお部屋抑え|お申込しお部屋抑え/g) ?? []).length}・2通目${(text2.match(/お申込しお部屋抑え/g) ?? []).length}`,
        `内覧の誘導 1通目${/ご都合よろしいお日にち/.test(text1) ? "あり" : "なし"}・2通目${/ご都合よろしいお日にち/.test(text2) ? "あり" : "なし"}`,
        `退去予定 1通目${/退去/.test(text1) ? "あり" : "なし"}・2通目${/退去/.test(text2) ? "あり" : "なし"}`,
        /即入居|居住中|入居中|2026年11月|最短での|\d{1,2}月(?:上旬|中旬|下旬)|浅く・/.test(both) ? `⚠語:${both.match(/即入居|居住中|入居中|2026年11月|最短での|\d{1,2}月(?:上旬|中旬|下旬)|浅く・/)?.[0]}` : "",
        findAiPhrases(text2).length ? `⚠AI語:${findAiPhrases(text2).map((h) => h.key).join(",")}` : "",
      ].filter(Boolean).join(" ／ ");
      log(`[${id}-${i + 1}] 2通目${j.error ? ` ERROR:${j.error}` : ""}\n${text2}\n   → ${flags}`);
    }
  }
  writeFileSync(`${SP}/rcv2/${OUT}.txt`, out.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
