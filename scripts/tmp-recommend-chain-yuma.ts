// tmp(コミットしない): 売上サポ → AIX【物件オススメ】(1通目) → 送信後のテンプレート「物件オススメ【AIX】」から AIX テンプレート生成(2通目) を YUMA に実送信。
//   2026-09-30 竹内「AIX オススメの文送った後は、2通目 物件オススメの AIX テンプレート行う。質上げることや、ずれ起きないように」
//   画面: PickupReview→page handoff→AixModal(generate/handleSend)→onAfterSend→TemplateModal(recommend-templates→✨この会話に合った文を生成→この文を使う)
// 実行: npx tsx --env-file=.env.local scripts/tmp-recommend-chain-yuma.ts --ids=2668 [--no-send] [--no-send2] [--force]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { sentConfirmMessage, dealConfirmMessage } from "../app/lib/pickup-review-order";
import { aixTypeForPickupCount, planPickupMarkSent } from "../app/lib/pickup-aix-handoff";
import { draftToSendableText } from "../app/lib/draft-text";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const YUMA_LINE = "U3d8d9e48f947d85f270da34a32413a67";
const CAT = "物件オススメ【AIX】";
const BASE = process.env.SIM_BASE ?? "https://sumora-ai-ui.vercel.app";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IDS = arg("ids").split(",").map(Number).filter((n) => n > 0);
const FORCE = args.includes("--force");
const NO_SEND = args.includes("--no-send");
const NO_SEND2 = args.includes("--no-send2");
const LABEL = arg("label", IDS.join(","));
const OUT = "C:/Users/竹内悠~1/AppData/Local/Temp/claude/c--Users-------sumora-ai-ui/90d5437f-9ec8-479d-94e9-1097dde86432/scratchpad/sends";
function secret(): string {
  const e = (process.env.INTERNAL_API_SECRET ?? "").trim();
  if (e) return e;
  const l = readFileSync(".env.prod", "utf8").split(/\r?\n/).find((x) => x.startsWith("INTERNAL_API_SECRET=")) ?? "";
  return l.slice("INTERNAL_API_SECRET=".length).trim().replace(/^"(.*)"$/, "$1");
}
const AUTH = { Authorization: `Bearer ${secret()}` };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const FORBIDDEN: Array<[string, RegExp]> = [
  ["お待たせ", /お待たせ/], ["作業メモ(【】指示)", /【(?:メモ|注意|指示|内部|スタッフ)/], ["AD/広告料", /AD\s*\d|広告料|🌟★/], ["プレースホルダ", /\{\{|\[\[|〇〇|○○|XX/],
  ["元付・業者", /元付|業者間/], ["点数・札", /点数|スコア|👑/],
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatConditions(c: Record<string, any>): string {
  const lines: string[] = [];
  if (c.desired_area) lines.push(`エリア: ${c.desired_area}`);
  if (c.floor_plan) lines.push(`間取り: ${c.floor_plan}`);
  const rp: string[] = [];
  if (c.rent_min) rp.push(`${c.rent_min / 10000}万円〜`);
  if (c.rent_max) rp.push(`${c.rent_max / 10000}万円以内`);
  if (rp.length) lines.push(`家賃: ${rp.join("")}`);
  if (c.walk_minutes) lines.push(`駅徒歩: ${c.walk_minutes}分以内`);
  if (c.move_in_time) lines.push(`入居: ${c.move_in_time}`);
  if (c.building_age) lines.push(`築年数: ${c.building_age}年以内`);
  if (c.preferences) lines.push(`希望: ${c.preferences}`);
  if (c.ng_points) lines.push(`NG: ${c.ng_points}`);
  if (c.other_requests) lines.push(`その他: ${c.other_requests}`);
  if (c.additional_conditions) {
    const a = String(c.additional_conditions).split("\n").map((l) => l.replace(/^【[^】]*】/, "").trim()).filter(Boolean).join("、");
    if (a) lines.push(`追加条件: ${a}`);
  }
  return lines.join("\n");
}

async function main() {
  if (IDS.length !== 1) throw new Error("--ids は1件（物件オススメ）");
  const rec: Record<string, unknown> = { label: LABEL, ids: IDS, force: FORCE, started: new Date().toISOString() };
  const t0 = Date.now(); const t0Iso = new Date().toISOString();
  const save = () => { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/${Date.now()}_chain_${LABEL.replace(/[^\w-]/g, "_")}.json`, JSON.stringify(rec, null, 2)); };
  const det = await (await fetch(`${BASE}/api/property-pickups?view=detail&conv=${Y}&batches=30`, { cache: "no-store" })).json() as Record<string, unknown>;
  const cust = (det.customer as Record<string, unknown> | undefined) ?? {};
  const batches = (cust.batches as Array<{ batch_id: string; items: Array<Record<string, unknown> & { id: number }> }> | undefined) ?? [];
  const allItems = batches.flatMap((b) => b.items.map((it) => ({ ...it, _batch: b.batch_id })));
  const targets = IDS.map((id) => allItems.find((it) => it.id === id)).filter(Boolean) as Array<Record<string, unknown>>;
  const hist = (cust.sent_history as Array<Record<string, unknown>> | undefined) ?? [];
  const sentMsg = sentConfirmMessage(targets as never, hist as never);
  const dealMsg = dealConfirmMessage(targets as never);
  rec.targets = targets.map((t) => ({ id: t.id, site: t.site, name: t.property_name, room: t.room_no, status: t.status, batch: t._batch }));
  if (!targets.length) { rec.error = "詳細 API に無い行"; console.log(JSON.stringify(rec, null, 1)); save(); return; }
  if ((sentMsg || dealMsg) && !FORCE) { rec.stopped = "confirm"; rec.confirm = { sentMsg, dealMsg }; console.log(JSON.stringify(rec, null, 1)); save(); return; }
  const aix = aixTypeForPickupCount(1)!;
  rec.aix = aix;
  const hj = await (await fetch(`${BASE}/api/property-pickups?ids=${IDS[0]}`, { cache: "no-store" })).json() as { items?: Array<{ id: number; rank: number; property_name: string; room_no: string | null; image_url: string | null }> };
  const it = hj.items?.[0];
  if (!it?.image_url) { rec.error = "画像なし"; console.log(JSON.stringify(rec, null, 1)); save(); return; }
  const srcBytes = new Uint8Array(await (await fetch(it.image_url)).arrayBuffer());
  const pname = `${it.property_name}${it.room_no ? ` ${it.room_no}` : ""}`;
  const path = `aix/${Y}/${Date.now()}_0_${Math.random().toString(36).slice(2, 7)}.jpg`;
  const up = await sb.storage.from("property-images").upload(path, srcBytes, { upsert: false, contentType: "image/jpeg" });
  if (up.error) throw new Error(`upload ${up.error.message}`);
  const uploadedUrl = sb.storage.from("property-images").getPublicUrl(path).data.publicUrl;
  const upBytes = new Uint8Array(await (await fetch(uploadedUrl)).arrayBuffer());
  rec.verbatim = { same_bytes: sha(upBytes) === sha(srcBytes), sha: sha(upBytes), source_image: it.image_url };
  const { data: conv } = await sb.from("conversations").select("line_user_id, account, customer_name, status").eq("id", Y).single();
  const c = conv as { line_user_id: string; account: string | null; customer_name: string | null; status: string };
  if (c.line_user_id !== YUMA_LINE || c.customer_name !== "YUMA") throw new Error("宛先が YUMA ではない: 中止");
  rec.dest = { conversation_id: Y, line_user_id: c.line_user_id, customer_name: c.customer_name };
  const { data: pcr } = await sb.from("property_customers").select("id,customer_name,desired_area,floor_plan,rent_min,rent_max,move_in_time,preferences,ng_points,walk_minutes,other_requests,building_age,additional_conditions,ai_summary").eq("id", PC).single();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pc = pcr as Record<string, any>;
  const customerConditions = formatConditions(pc);
  rec.customer_conditions = customerConditions;
  type Tmpl = { id: string; category: string; label: string; text: string; structure?: Array<{ label: string; text: string }> | null; use_count?: number; win_rate?: number | null; recommend_shown_count?: number | null; recommend_picked_count?: number | null };
  const tj = await (await fetch(`${BASE}/api/templates`, { cache: "no-store" })).json() as { templates: Tmpl[] };
  const catTemplates = tj.templates.filter((t) => t.category === CAT);
  const bestTmpl = [...catTemplates].sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0) || (b.use_count ?? 0) - (a.use_count ?? 0))[0] ?? null;
  rec.auto_template = bestTmpl ? { id: bestTmpl.id, label: bestTmpl.label } : null;
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(25);
  const recent = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  const body: Record<string, unknown> = { action: aix, account: c.account ?? "sumora", conversation_id: Y, customer_name: c.customer_name ?? "YUMA", recent_messages: recent, conversation_status: c.status,
    image_url: uploadedUrl, pickup_ids: [it.id], customer_conditions: customerConditions };
  if (bestTmpl?.structure?.length) body.template_structure = bestTmpl.structure;
  if (bestTmpl?.text) body.template_sample = bestTmpl.text;
  const g0 = Date.now();
  const gres = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const gj = await gres.json().catch(async () => ({ raw: (await gres.text()).slice(0, 300) })) as Record<string, unknown>;
  const text = String(gj.message_text ?? "");
  rec.gen1 = { http: gres.status, sec: (Date.now() - g0) / 1000, text, notice: gj.notice ?? null, send_hold: gj.send_hold ?? null, error: gj.error ?? null, suggest_template_category: gj.suggest_template_category ?? null };
  rec.text1_checks = { sendable: draftToSendableText(text) !== null, forbidden: FORBIDDEN.filter(([, re]) => re.test(text)).map(([k]) => k) };
  if (!text || (gj.send_hold && !FORCE) || NO_SEND) { rec.stopped = !text ? "no_text" : NO_SEND ? "no_send" : "send_hold"; console.log(JSON.stringify(rec, null, 1)); save(); return; }
  // 1通目送信: 画像 → 本文
  const ires = await fetch(`${BASE}/api/send-line-message`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ line_user_id: c.line_user_id, image_urls: [uploadedUrl], account: c.account ?? "sumora", conversation_id: Y, origin: "aix", aix_type: aix }) });
  const ij = await ires.json().catch(() => ({})) as { ok?: boolean; sentMessageIds?: string[]; error?: string };
  const delivered = ires.ok && ij.ok ? [uploadedUrl] : [];
  if (delivered.length) await sb.from("messages").insert({ conversation_id: Y, sender: "staff", text: "[画像]", image_url: uploadedUrl, created_at: new Date().toISOString(), is_aix_generated: true, ...(ij.sentMessageIds?.[0] ? { line_message_id: ij.sentMessageIds[0] } : {}) });
  const tres = await fetch(`${BASE}/api/send-line-message`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ line_user_id: c.line_user_id, message: text.trim(), account: c.account ?? "sumora", conversation_id: Y, origin: "aix" }) });
  const tj1 = await tres.json().catch(() => ({})) as { ok?: boolean; sentMessageIds?: string[]; error?: string };
  const sentAt = new Date().toISOString();
  if (tres.ok) await sb.from("messages").insert({ conversation_id: Y, sender: "staff", text: text.trim(), created_at: sentAt, is_aix_generated: true, ...(tj1.sentMessageIds?.[0] ? { line_message_id: tj1.sentMessageIds[0] } : {}) });
  await sb.from("conversations").update({ last_message: text.trim(), last_sender: "staff", updated_at: sentAt, ai_draft: null, suggested_aix_meta: null }).eq("id", Y);
  rec.send1 = { img_http: ires.status, img_ok: ij.ok ?? false, img_err: ij.error ?? null, delivered: delivered.length, txt_http: tres.status, txt_err: tj1.error ?? null };
  const file = { id: it.id, name: pname };
  const plan = planPickupMarkSent({ aix, handoffIds: [it.id], handoffFiles: [file as never], sentFiles: [file as never], sentImageUrls: delivered });
  if (plan) {
    const batchId = String(targets[0]._batch);
    const mres = await fetch(`${BASE}/api/property-pickups/send`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ batch_id: batchId, item_ids: plan.itemIds, action: "mark_sent", sent_by: "aix", image_urls: plan.imageUrls, conversation_id: Y }) });
    rec.mark_sent = { http: mres.status, json: await mres.json().catch(() => null) };
  }
  const lres = await fetch(`${BASE}/api/log-aix-usage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    conversation_id: Y, aix_type: aix, conversation_status: c.status, line_message_id: tj1.sentMessageIds?.[0] ?? null, sent_at: sentAt, scheduled: false,
    send_mode: null, generated_text: text, was_edited: false, picker_choices: { pickup_type: null, is_new_arrival: false, focus_points: [], simple: false, has_estimate_image: false },
    properties_sent_count: 1, properties_sent_names: [pname],
  }) });
  rec.log_aix = { http: lres.status };

  // ===== 2通目（画面: TemplateModal 物件オススメ【AIX】 → おすすめ → ✨この会話に合った文を生成 → 📤この文を使う）=====
  await new Promise((r) => setTimeout(r, 4000));
  const chain: Record<string, unknown> = {};
  rec.chain = chain;
  const { data: ms2 } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(25);
  const recent2 = ((ms2 ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  const sentMessage = text.trim();
  const rr = await (await fetch(`${BASE}/api/recommend-templates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    conversation_id: Y, action_type: aix, sent_message: sentMessage, category: CAT,
    templates: catTemplates.map((t) => ({ id: t.id, label: t.label, text: t.text, use_count: t.use_count ?? 0, win_rate: t.win_rate ?? null, recommend_shown_count: t.recommend_shown_count ?? null, recommend_picked_count: t.recommend_picked_count ?? null })),
    customer_conditions: customerConditions, customer_summary: pc.ai_summary ?? null, sub_category: null,
  }) })).json() as { ok: boolean; recommendations?: Array<{ id: string; score: number; reason: string }> };
  chain.recommendations = (rr.recommendations ?? []).map((r) => ({ ...r, label: catTemplates.find((t) => t.id === r.id)?.label }));
  if (rr.ok && rr.recommendations?.length) await fetch(`${BASE}/api/learn-template-selection`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phase: "shown", template_ids: rr.recommendations.map((r) => r.id) }) });
  const g2 = Date.now();
  const gr = await fetch(`${BASE}/api/aix-template-generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    actionType: "property_recommendation", actionCategory: CAT, conversationId: Y, customerName: c.customer_name ?? "YUMA", conversationState: c.status,
    recentMessages: recent2.slice(-15), customerConditions, customerSummary: pc.ai_summary ?? null, noEmoji: false, pendingScheduledMessages: [], staffMessagedToday: true,
    pickupType: null, lastAixCheckPattern: null, sentMessage,
  }), signal: AbortSignal.timeout(120_000) });
  const gj2 = await gr.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string };
  let text2 = String(gj2.text ?? "");
  chain.gen = { http: gr.status, sec: (Date.now() - g2) / 1000, text: text2, error: gj2.error ?? null };
  // 作業メモ風（【…】始まり・お客様への言葉の特徴なし）は送らず1回だけ再生成（画面では入力欄で人が見て送るので、その代わり）
  const looksMeta = (t: string) => /^\s*【[^】]*】/.test(t) || !/[！!？?😊😌✨]|さん/.test(t) || /(?:^|\n)\s*-{3,}\s*(?:\n|$)|橋渡し|2通目|トーク画面|履歴|書きます/.test(t);
  if (looksMeta(text2)) {
    chain.withheld_first = text2;
    const gr2 = await fetch(`${BASE}/api/aix-template-generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      actionType: "property_recommendation", actionCategory: CAT, conversationId: Y, customerName: c.customer_name ?? "YUMA", conversationState: c.status,
      recentMessages: recent2.slice(-15), customerConditions, customerSummary: pc.ai_summary ?? null, noEmoji: false, pendingScheduledMessages: [], staffMessagedToday: true,
      pickupType: null, lastAixCheckPattern: null, sentMessage,
    }), signal: AbortSignal.timeout(120_000) });
    const gj3 = await gr2.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string };
    text2 = String(gj3.text ?? "");
    chain.regen = { text: text2, error: gj3.error ?? null };
    if (looksMeta(text2)) { chain.send = { skipped: "meta_twice" }; text2 = ""; }
  }
  chain.text_checks = { forbidden: FORBIDDEN.filter(([, re]) => re.test(text2)).map(([k]) => k), len1: sentMessage.length, len2: text2.length };
  if (text2.trim() && !NO_SEND2) {
    const t2 = await fetch(`${BASE}/api/send-line-message`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ line_user_id: c.line_user_id, message: text2.trim(), account: c.account ?? "sumora", conversation_id: Y, origin: "manual" }) });
    const t2j = await t2.json().catch(() => ({})) as { ok?: boolean; sentMessageIds?: string[]; error?: string };
    const at2 = new Date().toISOString();
    if (t2.ok) {
      await sb.from("messages").insert({ conversation_id: Y, sender: "staff", text: text2.trim(), created_at: at2, ...(t2j.sentMessageIds?.[0] ? { line_message_id: t2j.sentMessageIds[0] } : {}) });
      await sb.from("conversations").update({ last_message: text2.trim(), last_sender: "staff", updated_at: at2, ai_draft: null, suggested_aix_meta: null }).eq("id", Y);
      const lastCust = [...recent2].reverse().find((m) => m.sender === "customer")?.text || "（初回連絡）";
      const sr = await fetch(`${BASE}/api/save-reply-example`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationState: c.status, conversationId: Y, customerMessage: lastCust, sentReply: text2.trim(), isStarred: false, sentAt: at2, entry_source: "aix_action" }) });
      chain.save_example_http = sr.status;
    }
    chain.send = { http: t2.status, ok: t2.ok, err: t2j.error ?? null, at: at2 };
  } else if (!chain.send) chain.send = { skipped: true };

  // 記録の読み取り
  type Row = Record<string, unknown>;
  let sips: Row[] = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    sips = ((await sb.from("sent_image_properties").select("image_url, property_name, room_no, source").in("image_url", delivered)).data ?? []) as Row[];
    if (sips.length >= delivered.length) break;
  }
  rec.after_sec = (Date.now() - t0) / 1000;
  rec.sent_image_properties = sips;
  rec.sent_properties = ((await sb.from("sent_properties").select("property_name, room_no, channel, delivery, source, pickup_id, image_url, sent_at").eq("conversation_id", Y).gte("sent_at", t0Iso)).data ?? []) as Row[];
  rec.pickup_status = ((await sb.from("property_pickups").select("id, status, sent_at, sent_by").eq("id", IDS[0])).data ?? []) as Row[];
  rec.llm = (await sb.from("llm_usage_logs").select("action, model, input_uncached, cache_read, output_tokens, env, conversation_id, created_at").gte("created_at", t0Iso).order("created_at")).data;
  rec.aix_usage = (await sb.from("aix_usage_logs").select("id, aix_type, send_mode, suggested_action, created_at").eq("conversation_id", Y).gte("created_at", t0Iso)).data;
  rec.aix_items = (await sb.from("aix_action_items").select("id, status, action, check_pattern, created_at").eq("conversation_id", Y).gte("created_at", t0Iso)).data;
  rec.reply_examples = (await sb.from("ai_reply_examples").select("id, conversation_id, entry_source, sent_reply, created_at").eq("conversation_id", Y).gte("created_at", t0Iso)).data;
  console.log(JSON.stringify(rec, null, 1));
  save();
}
main().catch((e) => { console.error(e); process.exit(1); });
