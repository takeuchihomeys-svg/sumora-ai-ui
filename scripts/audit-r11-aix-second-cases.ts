// scripts/audit-r11-aix-second-cases.ts — 11巡目（10/08 竹内「AIX テンプレート竹内の方に寄せる」）
//   AIX【物件オススメ】【見積書送る】の直後に竹内さんが送った2通目（messages.staff_writer='takeuchi'・AIX の通ではない・20分以内・間にお客様の発言なし）を正解に、
//   ✨2通目（aix-template-generate）を作り直す番を本番から作る（読むだけ・LLM なし）。
//   会話は AIX の塊の前で切り（申込の書類の手前で切る・名前は YUMA・maskPII）、1通目（AIX の通）を sentMessage と会話の最後に入れる。
//   その日の前の会話文の有無（資料文は数えない）を staffTalkedToday として渡す（YUMA の DB の今日の行に左右されないように）。
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-aix-second-cases.ts [--since=2026-09-01] [--per=14] [--out=scripts/.replay-out/r11-aix-second-cases.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { cutBeforeApplicationMaterial, applicationMaterialReason, piiValueSignal } from "../app/lib/test-pii-guard";
import { maskPII } from "../app/lib/pii-mask";
import { isMaterialOnlyText } from "../app/lib/daily-greeting";
import { catalogKeyOfPress } from "../app/lib/aix-catalog";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-09-01T00:00:00Z");
const PER = Number(arg("per", "14"));
const OUT = arg("out", "scripts/.replay-out/r11-aix-second-cases.json");
const ms = (s: string) => Date.parse(s);
const jstDay = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 200_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
type Press = { id: string; conversation_id: string; aix_type: string; send_mode: string | null; picker_choices: Record<string, unknown> | null; created_at: string; generated_text: string | null };
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };

(async () => {
  const presses = await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("id, conversation_id, aix_type, send_mode, picker_choices, created_at, generated_text").in("aix_type", ["property_recommendation", "estimate_sheet"]).gte("created_at", SINCE).order("created_at", { ascending: false }).range(f, t));
  const convIds = [...new Set(presses.map((p) => p.conversation_id))].filter((c) => !isTestConversation(c));
  const names = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, customer_name").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string | null }>) names.set(c.id, c.customer_name ?? "");
  }
  const cache = new Map<string, Msg[]>();
  const msgsOf = async (c: string) => { if (!cache.has(c)) cache.set(c, await readAll<Msg>((f, t) => sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, is_aix_generated, staff_writer").eq("conversation_id", c).order("created_at").range(f, t))); return cache.get(c)!; };
  const cases: unknown[] = []; const per: Record<string, number> = {}; const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  for (const p of presses) {
    if (isTestConversation(p.conversation_id)) continue;
    const pt = ms(p.created_at);
    const all = await msgsOf(p.conversation_id);
    const block = all.filter((m) => m.sender !== "customer" && m.is_aix_generated && Math.abs(ms(m.created_at) - pt) < 15 * 60_000);
    const card = block.filter((m) => !m.image_url && (m.text ?? "").length > 10).find((m) => p.aix_type === "estimate_sheet" ? /初期費用[：:]/.test(m.text ?? "") : /🌟/.test(m.text ?? ""));
    if (!card) { bump(`${p.aix_type}:1通目なし`); continue; }
    if (p.aix_type === "estimate_sheet" && /^[①-⑳]/.test((card.text ?? "").trim())) { bump("estimate:複数件"); continue; }
    const lastAix = Math.max(...block.map((m) => ms(m.created_at)));
    const second = all.find((m) => m.sender !== "customer" && !m.is_aix_generated && !m.image_url && ms(m.created_at) > lastAix && ms(m.created_at) <= lastAix + 20 * 60_000 && (m.text ?? "").trim().length > 8);
    if (!second) { bump(`${p.aix_type}:2通目なし`); continue; }
    if (all.some((m) => m.sender === "customer" && ms(m.created_at) > lastAix && ms(m.created_at) < ms(second.created_at))) { bump(`${p.aix_type}:間にお客様`); continue; }
    if (second.staff_writer !== "takeuchi") { bump(`${p.aix_type}:書き手=${second.staff_writer ?? "不明"}`); continue; }
    const key = catalogKeyOfPress({ ...p, text: card.text ?? "" }).key;
    const k = p.aix_type === "estimate_sheet" ? "estimate-second" : `rec-second:${key.split("/")[1] ?? "-"}`;
    if ((per[k] ?? 0) >= PER) continue;
    const firstBlock = Math.min(...block.map((m) => ms(m.created_at)), pt);
    const before = all.filter((m) => ms(m.created_at) < firstBlock - 1000);
    const cut = cutBeforeApplicationMaterial(before);
    if (cut.cutAt !== null) { bump(`${p.aix_type}:申込以降`); continue; }
    const nm = names.get(p.conversation_id) ?? "";
    const staffNames = new Set<string>(); for (const m of all) if (m.sender !== "customer") { const mm = (m.text ?? "").match(/^([^\s\n、。！!]{1,8})さん/); if (mm) staffNames.add(mm[1]); }
    const ns = [nm, ...staffNames].map((s) => s.trim()).filter((s) => s.length >= 1 && s !== "YUMA").sort((a, b) => b.length - a.length);
    const mask = (t: string) => { let r = String(t ?? ""); for (const n of ns) if (n.length >= 1) r = r.split(`${n}さん`).join("YUMAさん"); for (const n of ns) if (n.length >= 2) r = r.split(n).join("YUMA"); return maskPII(r).replace(/https?:\/\/\S+/g, "〈URL〉").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉"); };
    const recent = cut.kept.slice(-14).map((m) => ({ sender: m.sender === "customer" ? "customer" : "staff", text: m.image_url && !(m.text ?? "").trim() ? "[画像]" : mask(m.text ?? ""), createdAt: m.created_at, rawCreatedAt: m.created_at, isAix: !!m.is_aix_generated }));
    if (recent.some((m) => applicationMaterialReason(m.text) || piiValueSignal(m.text))) { bump(`${p.aix_type}:書類・個人の値`); continue; }
    const cardText = mask(card.text ?? "");
    const day = jstDay(firstBlock);
    const talkedToday = before.some((m) => m.sender !== "customer" && jstDay(ms(m.created_at)) === day && !isMaterialOnlyText(m.text));
    const pickupType = (p.picker_choices?.pickup_type as string | undefined) ?? (key.startsWith("property_recommendation/") ? key.split("/")[1] : undefined);
    const body = {
      actionType: p.aix_type,
      actionCategory: p.aix_type === "estimate_sheet" ? "見積書送る【AIX】" : "物件オススメ【AIX】",
      conversationState: "proposing",
      recentMessages: [...recent, { sender: "staff", text: cardText, createdAt: card.created_at, rawCreatedAt: card.created_at, isAix: true }],
      sentMessage: cardText,
      sentMessageSource: "post_aix",
      staffTalkedToday: talkedToday,
      ...(pickupType ? { pickupType } : {}),
    };
    cases.push({ id: `${k}:${p.id.slice(0, 8)}`, action: k, route: "aix-template-generate", src: p.id, at: p.created_at, body, sent: mask(second.text ?? ""), genThen: null, inputText: [...recent.map((m) => m.text), cardText].join("\n"), talkedToday });
    per[k] = (per[k] ?? 0) + 1; bump(`${k}:採用`);
  }
  writeFileSync(OUT, JSON.stringify({ since: SINCE, made: new Date().toISOString(), cases }, null, 1));
  console.log(`番 ${cases.length} → ${OUT}`);
  for (const [k, v] of Object.entries(stats).sort()) console.log(`  ${k} ${v}`);
})().catch((e) => { console.error(e); process.exit(1); });
