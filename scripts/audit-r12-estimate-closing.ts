// scripts/audit-r12-estimate-closing.ts — 見積書の2通目の締め: 採点の刺さり具合（新）と旧（反応だけ）を、竹内さんの実送信の締めと比べる（読むだけ・LLM なし）
// 2026-10-08 竹内「刺さる条件（スコアリング的に刺さる条件）なら内覧または申込誘導する。空室なら内覧誘導」
// 実行: npx tsx --env-file=.env.local scripts/audit-r12-estimate-closing.ts [--show]
import { createClient } from "@supabase/supabase-js";
import { estimatePropertiesOf, isEstimateCard, resolveEstimateClosing } from "../app/lib/estimate-second-message";
import { loadEstimateAppeal } from "../app/lib/estimate-appeal-server";
import { hasClosingSentence, readCustomerReaction } from "../app/lib/recommend-cta";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
const ms = (s: string) => Date.parse(s);
const SHOW = process.argv.includes("--show");
(async () => {
  const logs = await readAll((f, t) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "estimate_sheet").order("created_at").range(f, t));
  const convs = [...new Set(logs.map((l) => l.conversation_id))];
  const msgs: any[] = [];
  for (let i = 0; i < convs.length; i += 80) msgs.push(...await readAll((f, t) => sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated, text, sender, image_url").in("conversation_id", convs.slice(i, i + 80)).order("created_at").range(f, t)));
  const by = new Map<string, any[]>(); for (const m of msgs) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const st: Record<string, number> = {}; const bump = (k: string) => (st[k] = (st[k] ?? 0) + 1);
  const seen = new Set<string>();
  for (const l of logs) {
    const arr = by.get(l.conversation_id) ?? []; const t = ms(l.created_at);
    const card = arr.find((m) => m.is_aix_generated && Math.abs(ms(m.created_at) - t) < 15 * 60_000 && isEstimateCard(m.text));
    if (!card || seen.has(card.created_at)) continue; seen.add(card.created_at);
    const second = arr.find((m) => m.sender !== "customer" && !m.is_aix_generated && !m.image_url && ms(m.created_at) > ms(card.created_at) && ms(m.created_at) < ms(card.created_at) + 20 * 60_000 && (m.text ?? "").length > 8);
    if (!second || second.staff_writer !== "takeuchi") continue;
    if (arr.some((m) => m.sender === "customer" && ms(m.created_at) > ms(card.created_at) && ms(m.created_at) < ms(second.created_at))) continue;
    const human = hasClosingSentence(second.text, "apply") ? "apply" : hasClosingSentence(second.text, "viewing") ? "viewing" : "receipt";
    const recent = arr.filter((m) => ms(m.created_at) < ms(card.created_at)).slice(-12).map((m) => ({ sender: m.sender === "customer" ? "customer" : "staff", text: m.text }));
    const reaction = readCustomerReaction(recent);
    const ap = await loadEstimateAppeal(sb as any, l.conversation_id, estimatePropertiesOf(card.text), { notViewable: false });
    const oldD = (() => { const p = process.env.ESTIMATE_CLOSING_BY_APPEAL; process.env.ESTIMATE_CLOSING_BY_APPEAL = "off"; const d = resolveEstimateClosing({ viewed: false, reactionKind: reaction?.kind ?? null }); if (p === undefined) delete process.env.ESTIMATE_CLOSING_BY_APPEAL; else process.env.ESTIMATE_CLOSING_BY_APPEAL = p; return d.closing; })();
    const newD = resolveEstimateClosing({ viewed: false, reactionKind: reaction?.kind ?? null, appeal: ap.appeal, notViewable: ap.notViewable }).closing;
    bump(`n`); bump(`採点 ${ap.appeal ?? "なし"}${ap.appeal === "strong" ? (ap.notViewable ? "・退去予定" : "・今見られる") : ""}`);
    bump(`竹内さん=${human}`);
    bump(`旧=${oldD}｜竹内=${human}`); bump(`新=${newD}｜竹内=${human}`);
    if (oldD === human) bump("旧の一致"); if (newD === human) bump("新の一致");
    if (SHOW) console.log(`${card.created_at.slice(0, 10)} 採点${ap.appeal ?? "-"}(${ap.found}) 旧${oldD} 新${newD} 竹内${human}｜${String(second.text).replace(/\n/g, "⏎").slice(0, 80)}`);
  }
  for (const [k, v] of Object.entries(st).sort()) console.log(`  ${k}: ${v}`);
})();
