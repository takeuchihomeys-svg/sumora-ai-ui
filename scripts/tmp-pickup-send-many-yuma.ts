// tmp: 売上サポ → AIX（物件ピックアップ／物件オススメ）→ YUMA への実送信を、画面（PickupReview.sendViaAix → page の handoff → AixModal → onAfterSend）と同じ API の順で1回通す。
//   2026-09-30 竹内「リアプロと ITANDI、YUMA に物件送る形で大量にテスト。ちゃんと監視できているかも含めて」
//   本番（https://sumora-ai-ui.vercel.app）に向ける＝LINE に本当に届く（YUMA だけ）。
// 実行: npx tsx --env-file=.env.local scripts/tmp-pickup-send-many-yuma.ts --ids=123,456 [--mode=normal|new_arrival] [--force] [--label=…] [--no-send]
//   --force: 送付済みの確かめ（window.confirm）・send_hold を「OK」で越える（意図した送り直し）
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { sentConfirmMessage, dealConfirmMessage } from "../app/lib/pickup-review-order";
import { aixTypeForPickupCount, planPickupMarkSent } from "../app/lib/pickup-aix-handoff";
import { draftToSendableText } from "../app/lib/draft-text";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.SIM_BASE ?? "https://sumora-ai-ui.vercel.app";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IDS = arg("ids").split(",").map(Number).filter((n) => n > 0);
const MODE = arg("mode", "normal");
const FORCE = args.includes("--force");
const NO_SEND = args.includes("--no-send");
const LABEL = arg("label", IDS.join(","));
const OUT = process.env.OUT_DIR ?? "C:/Users/竹内悠~1/AppData/Local/Temp/claude/c--Users-------sumora-ai-ui/90d5437f-9ec8-479d-94e9-1097dde86432/scratchpad/sends";
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

async function main() {
  if (!IDS.length) throw new Error("--ids が要る");
  const rec: Record<string, unknown> = { label: LABEL, ids: IDS, mode: MODE, force: FORCE, started: new Date().toISOString() };
  const t0 = Date.now(); const t0Iso = new Date().toISOString();
  // ① 売上サポの詳細（画面と同じ API）: 行・送った記録
  const det = await (await fetch(`${BASE}/api/property-pickups?view=detail&conv=${Y}&batches=30`, { cache: "no-store" })).json() as Record<string, unknown>;
  const cust = (det.customer as Record<string, unknown> | undefined) ?? {};
  const batches = (cust.batches as Array<{ batch_id: string; items: Array<Record<string, unknown> & { id: number }> }> | undefined) ?? [];
  const allItems = batches.flatMap((b) => b.items.map((it) => ({ ...it, _batch: b.batch_id })));
  const targets = IDS.map((id) => allItems.find((it) => it.id === id)).filter(Boolean) as Array<Record<string, unknown>>;
  rec.found = targets.length;
  if (targets.length !== IDS.length) { rec.error = `詳細 API に無い行 ${IDS.filter((id) => !allItems.some((it) => it.id === id))}`; }
  const hist = (cust.sent_history as Array<Record<string, unknown>> | undefined) ?? [];
  rec.sent_history_n = hist.length;
  const sentMsg = sentConfirmMessage(targets as never, hist as never);
  const dealMsg = dealConfirmMessage(targets as never);
  rec.confirm_sent = sentMsg; rec.confirm_deal = dealMsg;
  rec.targets = targets.map((t) => ({ id: t.id, site: t.site, name: t.property_name, room: t.room_no, status: t.status, verdict: t.verdict, score: t.score, ad: t.ad_yen, batch: t._batch }));
  const save = () => { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/${Date.now()}_${LABEL.replace(/[^\w-]/g, "_")}.json`, JSON.stringify(rec, null, 2)); };
  if ((sentMsg || dealMsg) && !FORCE) { rec.stopped = "confirm"; console.log(JSON.stringify(rec, null, 1)); save(); return; }
  if (args.includes("--confirm-only")) { rec.stopped = "confirm_only_passed"; console.log(JSON.stringify(rec, null, 1)); save(); return; }
  if (!targets.length) { console.log(JSON.stringify(rec, null, 1)); save(); return; }
  const aix = aixTypeForPickupCount(targets.length)!;
  rec.aix = aix;
  // ② handoff: GET ?ids= → image_url（pickSendImageUrl）
  const hj = await (await fetch(`${BASE}/api/property-pickups?ids=${targets.map((t) => t.id).join(",")}`, { cache: "no-store" })).json() as { items?: Array<{ id: number; rank: number; property_name: string; room_no: string | null; image_url: string | null }> };
  const { data: raw } = await sb.from("property_pickups").select("id, trim_image_url, page_image_url, agent_image_url, pdf_url, site").in("id", IDS);
  const rawById = new Map(((raw ?? []) as Array<Record<string, string | null>>).map((r) => [Number(r.id), r]));
  const handoff: Array<{ id: number; name: string; url: string; bytes: Uint8Array }> = [];
  const imgCheck: unknown[] = [];
  for (const it of hj.items ?? []) {
    const r = rawById.get(it.id);
    imgCheck.push({ id: it.id, image_url_is_trim: !!it.image_url && it.image_url === r?.trim_image_url, not_page: it.image_url !== r?.page_image_url, not_agent: it.image_url !== r?.agent_image_url });
    if (!it.image_url) continue;
    const res = await fetch(it.image_url); if (!res.ok) continue;
    handoff.push({ id: it.id, name: `${it.property_name}${it.room_no ? ` ${it.room_no}` : ""}`, url: it.image_url, bytes: new Uint8Array(await res.arrayBuffer()) });
  }
  rec.image_check = imgCheck;
  const files = aix === "property_recommendation" ? handoff.slice(0, 1) : handoff;
  // ③ AixModal の uploadImageRaw と同じ置き場に再アップロード
  const uploaded: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const path = `aix/${Y}/${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}.jpg`;
    const { error } = await sb.storage.from("property-images").upload(path, files[i].bytes, { upsert: false, contentType: "image/jpeg" });
    if (error) throw new Error(`upload ${error.message}`);
    uploaded.push(sb.storage.from("property-images").getPublicUrl(path).data.publicUrl);
  }
  // 再アップロードした物が元の資料の画像とバイト単位で同じか
  rec.verbatim = await Promise.all(uploaded.map(async (u, i) => { const b = new Uint8Array(await (await fetch(u)).arrayBuffer()); return { id: files[i].id, same_bytes: sha(b) === sha(files[i].bytes), sha: sha(b) }; }));
  // ④ 生成（/api/aix/action）
  const { data: conv } = await sb.from("conversations").select("line_user_id, account, customer_name, status").eq("id", Y).single();
  const c = conv as { line_user_id: string; account: string | null; customer_name: string | null; status: string };
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(25);
  const recent = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  const body: Record<string, unknown> = { action: aix, account: c.account ?? "sumora", conversation_id: Y, customer_name: c.customer_name ?? "YUMA", recent_messages: recent, conversation_status: c.status };
  if (aix === "property_send") { body.image_urls = uploaded; body.pickup_ids = files.map((f) => f.id); body.send_mode = MODE; body.include_viewing_invite = false; }
  else { body.image_url = uploaded[0]; body.pickup_ids = [files[0].id]; }
  const g0 = Date.now();
  const gres = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const gj = await gres.json().catch(async () => ({ raw: (await gres.text()).slice(0, 300) })) as Record<string, unknown>;
  const text = String(gj.message_text ?? "");
  rec.gen = { http: gres.status, sec: (Date.now() - g0) / 1000, text, notice: gj.notice ?? null, send_hold: gj.send_hold ?? null, error: gj.error ?? null };
  rec.text_checks = { sendable: draftToSendableText(text) !== null, forbidden: FORBIDDEN.filter(([, re]) => re.test(text)).map(([k]) => k) };
  if (!text || (gj.send_hold && !FORCE) || NO_SEND) { rec.stopped = !text ? "no_text" : NO_SEND ? "no_send" : "send_hold"; console.log(JSON.stringify(rec, null, 1)); save(); return; }
  // ⑤ 送信（画像まとめて → 本文）＋ messages（画面と同じ記録）
  const s0 = Date.now();
  const ires = await fetch(`${BASE}/api/send-line-message`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ line_user_id: c.line_user_id, image_urls: uploaded, account: c.account ?? "sumora", conversation_id: Y, origin: "aix", aix_type: aix }) });
  const ij = await ires.json().catch(() => ({})) as { ok?: boolean; sentMessageIds?: string[]; error?: string };
  const delivered = ires.ok && ij.ok ? uploaded : uploaded.slice(0, (ij.sentMessageIds ?? []).length);
  for (let i = 0; i < delivered.length; i++) await sb.from("messages").insert({ conversation_id: Y, sender: "staff", text: "[画像]", image_url: delivered[i], created_at: new Date(Date.now() + i).toISOString(), is_aix_generated: true, ...(ij.sentMessageIds?.[i] ? { line_message_id: ij.sentMessageIds[i] } : {}) });
  const tres = await fetch(`${BASE}/api/send-line-message`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ line_user_id: c.line_user_id, message: text.trim(), account: c.account ?? "sumora", conversation_id: Y, origin: "aix" }) });
  const tj = await tres.json().catch(() => ({})) as { ok?: boolean; sentMessageIds?: string[]; error?: string };
  const sentAt = new Date().toISOString();
  if (tres.ok) await sb.from("messages").insert({ conversation_id: Y, sender: "staff", text: text.trim(), created_at: sentAt, is_aix_generated: true, ...(tj.sentMessageIds?.[0] ? { line_message_id: tj.sentMessageIds[0] } : {}) });
  await sb.from("conversations").update({ last_message: text.trim(), last_sender: "staff", updated_at: sentAt, ai_draft: null, suggested_aix_meta: null }).eq("id", Y);
  rec.send = { img_http: ires.status, img_ok: ij.ok ?? false, img_err: ij.error ?? null, delivered: delivered.length, txt_http: tres.status, txt_err: tj.error ?? null, sec: (Date.now() - s0) / 1000 };
  // ⑥ onAfterSend: 送った印（mark_sent）・log-aix-usage
  const plan = planPickupMarkSent({ aix, handoffIds: files.map((f) => f.id), handoffFiles: files, sentFiles: files, sentImageUrls: delivered });
  if (plan) {
    const batchIds = [...new Set(targets.filter((t) => plan.itemIds.includes(Number(t.id))).map((t) => String(t._batch)))].join(",");
    const mres = await fetch(`${BASE}/api/property-pickups/send`, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ batch_id: batchIds, item_ids: plan.itemIds, action: "mark_sent", sent_by: "aix", image_urls: plan.imageUrls, conversation_id: Y }) });
    rec.mark_sent = { http: mres.status, json: await mres.json().catch(() => null) };
  }
  const lres = await fetch(`${BASE}/api/log-aix-usage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    conversation_id: Y, aix_type: aix, conversation_status: c.status, line_message_id: tj.sentMessageIds?.[0] ?? null, sent_at: sentAt, scheduled: false,
    send_mode: aix === "property_send" ? MODE : null, generated_text: text, was_edited: false, picker_choices: {},
    properties_sent_count: aix === "property_send" ? files.length : 1, properties_sent_names: files.map((f) => f.name),
  }) });
  rec.log_aix = { http: lres.status };
  // ⑦ 送った後（after）の読み取りを待つ
  type Row = Record<string, unknown>;
  let details: Row[] = [], sips: Row[] = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    details = ((await sb.from("image_details").select("image_url, lines, model, read_at").in("image_url", delivered)).data ?? []) as Row[];
    sips = ((await sb.from("sent_image_properties").select("image_url, property_name, room_no, source, facts").in("image_url", delivered)).data ?? []) as Row[];
    if (details.length >= delivered.length && sips.length >= delivered.length) break;
  }
  rec.after_sec = (Date.now() - t0) / 1000;
  await new Promise((r) => setTimeout(r, 5000));
  rec.sent_image_properties = sips.map((s) => ({ i: delivered.indexOf(String(s.image_url)), name: s.property_name, room: s.room_no, source: s.source }));
  rec.image_details = details.map((d) => ({ i: delivered.indexOf(String(d.image_url)), model: d.model, lines: d.lines }));
  rec.sent_properties = (((await sb.from("sent_properties").select("property_name, room_no, channel, delivery, source, pickup_id, image_url, sent_at").eq("conversation_id", Y).gte("sent_at", t0Iso)).data ?? []) as Row[]);
  rec.pickup_status = (((await sb.from("property_pickups").select("id, status, sent_at, sent_by").in("id", IDS)).data ?? []) as Row[]);
  const { data: logs } = await sb.from("llm_usage_logs").select("action, model, input_uncached, cache_read, output_tokens, thinking_tokens, duration_ms, env, conversation_id, created_at").gte("created_at", t0Iso).order("created_at");
  rec.llm = logs;
  rec.aix_items = (await sb.from("aix_action_items").select("id, status, action, check_pattern, created_at").eq("conversation_id", Y).gte("created_at", t0Iso)).data;
  rec.aix_usage = (await sb.from("aix_usage_logs").select("id, aix_type, send_mode, suggested_action, created_at").eq("conversation_id", Y).gte("created_at", t0Iso)).data;
  console.log(JSON.stringify(rec, null, 1));
  save();
}
main().catch((e) => { console.error(e); process.exit(1); });
