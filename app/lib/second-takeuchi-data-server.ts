// app/lib/second-takeuchi-data-server.ts — 竹内さんの2通目の手本・型の要約を DB で集める・置く・読む（サーバー専用・サーバーの鍵）
//
// 2026-10-29 作業員5。会話由来の文は倉庫に載せない（統括・竹内さん了承）。表は second_takeuchi_examples・second_takeuchi_forms（RLS・anon/authenticated は REVOKE）。
//   集める: AIX【物件オススメ】【見積書送る】の1通目（AIX の通）の直後 20 分以内に竹内さん（messages.staff_writer=takeuchi）が手で送った2通目・間にお客様の発言なし。
//     伏せ方は scripts/audit-r11-aix-second-cases.ts と同じ（お客様・スタッフの名前は YUMA・maskPII・URL・電話）。申込以降の会話・書類・個人の値の入った番は使わない。
//   置く: runSecondTakeuchiData（週1の cron /api/cron/second-takeuchi-data・手元は scripts/build-second-takeuchi-data.ts --dry）。
//   読む: loadSecondTakeuchiData（aix-template-generate だけ・1時間の手元の控え）。鍵が無い・表が空の時は手本なし（ログに1行）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "./test-conversations";
import { cutBeforeApplicationMaterial, applicationMaterialReason, piiValueSignal } from "./test-pii-guard";
import { maskPII } from "./pii-mask";
import { catalogKeyOfPress } from "./aix-catalog";
import { buildSecondForms, buildSecondExampleRows, type TakeuchiSecond, type SecondFormData, type SecondExampleRow } from "./second-takeuchi-build";
import { isTestModeAllowed } from "./llm-test-mode";

function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
const ms = (s: string) => Date.parse(s);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, cap = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < cap; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const sceneOfKey = (aixType: string, key: string) => aixType === "estimate_sheet" ? "見積書" : `物件オススメ・${key.split("/")[1] ?? "新規ピックアップ"}`;

/** 竹内さんの2通目を集める（伏せ済み） */
export async function collectTakeuchiSeconds(sb: SupabaseClient, opts: { sinceIso: string }): Promise<{ cases: TakeuchiSecond[]; stats: Record<string, number> }> {
  type Press = { id: string; conversation_id: string; aix_type: string; send_mode: string | null; picker_choices: Record<string, unknown> | null; created_at: string; generated_text: string | null };
  type Msg = { sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
  const presses = await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("id, conversation_id, aix_type, send_mode, picker_choices, created_at, generated_text")
    .in("aix_type", ["property_recommendation", "estimate_sheet"]).gte("created_at", opts.sinceIso).order("created_at", { ascending: false }).range(f, t));
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  const convIds = [...new Set(presses.map((p) => p.conversation_id))].filter((c) => !isTestConversation(c));
  const names = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, customer_name").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string | null }>) names.set(c.id, c.customer_name ?? "");
  }
  const cache = new Map<string, Msg[]>();
  const msgsOf = async (c: string) => {
    if (!cache.has(c)) cache.set(c, await readAll<Msg>((f, t) => sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated, staff_writer").eq("conversation_id", c).order("created_at").range(f, t), 20_000));
    return cache.get(c)!;
  };
  const cases: TakeuchiSecond[] = [];
  for (const p of presses) {
    if (isTestConversation(p.conversation_id)) continue;
    const pt = ms(p.created_at);
    const all = await msgsOf(p.conversation_id);
    const block = all.filter((m) => m.sender !== "customer" && m.is_aix_generated && Math.abs(ms(m.created_at) - pt) < 15 * 60_000);
    const card = block.filter((m) => !m.image_url && (m.text ?? "").length > 10).find((m) => p.aix_type === "estimate_sheet" ? /初期費用[：:]/.test(m.text ?? "") : /🌟/.test(m.text ?? ""));
    if (!card) { bump("1通目なし"); continue; }
    if (p.aix_type === "estimate_sheet" && /^[①-⑳]/.test((card.text ?? "").trim())) { bump("見積書の複数件"); continue; }
    const lastAix = Math.max(...block.map((m) => ms(m.created_at)));
    const second = all.find((m) => m.sender !== "customer" && !m.is_aix_generated && !m.image_url && ms(m.created_at) > lastAix && ms(m.created_at) <= lastAix + 20 * 60_000 && (m.text ?? "").trim().length > 8);
    if (!second) { bump("2通目なし"); continue; }
    if (all.some((m) => m.sender === "customer" && ms(m.created_at) > lastAix && ms(m.created_at) < ms(second.created_at))) { bump("間にお客様"); continue; }
    if (second.staff_writer !== "takeuchi") { bump("書き手が竹内さんでない"); continue; }
    const firstBlock = Math.min(...block.map((m) => ms(m.created_at)), pt);
    const before = all.filter((m) => ms(m.created_at) < firstBlock - 1000);
    if (cutBeforeApplicationMaterial(before).cutAt !== null) { bump("申込以降"); continue; }
    const nm = names.get(p.conversation_id) ?? "";
    const staffNames = new Set<string>();
    for (const m of all) if (m.sender !== "customer") { const mm = (m.text ?? "").match(/^([^\s\n、。！!]{1,8})さん/); if (mm) staffNames.add(mm[1]); }
    const ns = [nm, ...staffNames].map((s) => s.trim()).filter((s) => s.length >= 1 && s !== "YUMA").sort((a, b) => b.length - a.length);
    const mask = (t: string) => {
      let r = String(t ?? "");
      for (const n of ns) r = r.split(`${n}さん`).join("YUMAさん");
      for (const n of ns) if (n.length >= 2) r = r.split(n).join("YUMA");
      return maskPII(r).replace(/https?:\/\/\S+/g, "〈URL〉").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉");
    };
    const sent = mask(second.text ?? "");
    if (applicationMaterialReason(sent) || piiValueSignal(sent)) { bump("書類・個人の値"); continue; }
    const key = catalogKeyOfPress({ ...p, text: card.text ?? "" }).key;
    cases.push({ src: p.id, scene: sceneOfKey(p.aix_type, key), at: p.created_at, card: mask(card.text ?? ""), sent });
    bump("採用");
  }
  return { cases, stats };
}

/** 集めて表に置く（cron・script の両方から） */
export async function runSecondTakeuchiData(opts: { dry?: boolean; sinceDays?: number } = {}): Promise<{ ok: boolean; error?: string; cases?: number; examples?: number; scenes?: number; stats?: Record<string, number>; dry?: boolean }> {
  const sb = serviceClient();
  if (!sb) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" };
  try {
    const since = new Date(Date.now() - (opts.sinceDays ?? 365) * 86400_000).toISOString();
    const { cases, stats } = await collectTakeuchiSeconds(sb, { sinceIso: since });
    const forms = buildSecondForms(cases);
    const rows = buildSecondExampleRows(cases);
    if (!opts.dry) {
      for (let i = 0; i < rows.length; i += 200) {
        const r = await sb.from("second_takeuchi_examples").upsert(rows.slice(i, i + 200), { onConflict: "src" });
        if (r.error) throw new Error(`second_takeuchi_examples: ${r.error.message}`);
      }
      const fr = await sb.from("second_takeuchi_forms").upsert(Object.entries(forms).map(([scene, data]) => ({ scene, data, updated_at: new Date().toISOString() })), { onConflict: "scene" });
      if (fr.error) throw new Error(`second_takeuchi_forms: ${fr.error.message}`);
    }
    return { ok: true, cases: cases.length, examples: rows.length, scenes: Object.keys(forms).length, stats, dry: !!opts.dry };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type SecondTakeuchiData = { forms: Record<string, SecondFormData>; examples: Array<Pick<SecondExampleRow, "src" | "scene" | "els" | "body" | "sent_on">> };
let memo: { at: number; data: SecondTakeuchiData } | null = null;
/** aix-template-generate が読む（サーバーの鍵・1時間の控え）。鍵が無い・表が空なら空（手本なし）。
 *  試験の時だけ SECOND_EXAMPLES_EXCLUDE_FILE（問題の src の一覧の json）に入った手本を外す（答えを手本で見せない） */
export async function loadSecondTakeuchiData(): Promise<SecondTakeuchiData> {
  const empty: SecondTakeuchiData = { forms: {}, examples: [] };
  const exclude = await excludeSet();
  // 試験の時だけ: 手元にサーバーの鍵が無いので、本番の表と同じ中身のファイル（.claude/exam-cache の下・git に入れない）から読む
  const local = process.env.SECOND_EXAMPLES_LOCAL_FILE;
  if (local && isTestModeAllowed(process.env)) {
    try {
      const { readFileSync } = await import("node:fs");
      const j = JSON.parse(readFileSync(local, "utf8")) as SecondTakeuchiData;
      return { forms: j.forms ?? {}, examples: (j.examples ?? []).filter((r) => !exclude.has(r.src)) };
    } catch (e) { console.warn(JSON.stringify({ tag: "second-takeuchi-data:local-failed", error: e instanceof Error ? e.message : String(e) })); }
  }
  if (memo && Date.now() - memo.at < 3600_000 && !exclude.size) return memo.data;
  const sb = serviceClient();
  if (!sb) { console.warn(JSON.stringify({ tag: "second-takeuchi-data:no-key" })); return empty; }
  try {
    const [ex, fo] = await Promise.all([
      sb.from("second_takeuchi_examples").select("src, scene, els, body, sent_on").order("sent_on", { ascending: false }).limit(2000),
      sb.from("second_takeuchi_forms").select("scene, data"),
    ]);
    if (ex.error || fo.error) { console.warn(JSON.stringify({ tag: "second-takeuchi-data:read-failed", error: ex.error?.message ?? fo.error?.message })); return empty; }
    const data: SecondTakeuchiData = {
      forms: Object.fromEntries(((fo.data ?? []) as Array<{ scene: string; data: SecondFormData }>).map((r) => [r.scene, r.data])),
      examples: ((ex.data ?? []) as SecondTakeuchiData["examples"]).filter((r) => !exclude.has(r.src)),
    };
    if (!data.examples.length) console.warn(JSON.stringify({ tag: "second-takeuchi-data:empty" }));
    if (!exclude.size) memo = { at: Date.now(), data };
    return data;
  } catch (e) {
    console.warn(JSON.stringify({ tag: "second-takeuchi-data:read-failed", error: e instanceof Error ? e.message : String(e) }));
    return empty;
  }
}
async function excludeSet(): Promise<Set<string>> {
  const f = process.env.SECOND_EXAMPLES_EXCLUDE_FILE;
  if (!f || !isTestModeAllowed(process.env)) return new Set();
  try {
    const { readFileSync } = await import("node:fs");
    const j = JSON.parse(readFileSync(f, "utf8")) as { questions?: Array<{ src?: string }> } | string[];
    return new Set((Array.isArray(j) ? j : (j.questions ?? []).map((q) => q.src ?? "")).filter(Boolean));
  } catch { return new Set(); }
}
