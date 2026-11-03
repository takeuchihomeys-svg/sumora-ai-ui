// app/lib/second-takeuchi-data-server.ts — 竹内さんの2通目の手本・型の要約を DB で集める・置く・読む（サーバー専用・サーバーの鍵）
//
// 2026-10-29 作業員5。会話由来の文は倉庫に載せない（統括・竹内さん了承）。表は second_takeuchi_examples・second_takeuchi_forms（RLS・anon/authenticated は REVOKE）。
//   集める: AIX【物件オススメ】【見積書送る】の1通目（AIX の通）の直後 20 分以内に竹内さん（messages.staff_writer=takeuchi）が手で送った2通目・間にお客様の発言なし。
//     伏せ方は scripts/audit-r11-aix-second-cases.ts と同じ（お客様・スタッフの名前は YUMA・maskPII・URL・電話）。申込以降の会話・書類・個人の値の入った番は使わない。
//   置く: runSecondTakeuchiData（週1の cron /api/cron/second-takeuchi-data・手元は scripts/build-second-takeuchi-data.ts --dry）。
//   読む: loadSecondTakeuchiData（aix-template-generate だけ・1時間の手元の控え）。鍵が無い・表が空の時は手本なし（ログに1行）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "./test-conversations";
import { applicationMaterialReason, piiValueSignal } from "./test-pii-guard";
import { maskPII } from "./pii-mask";
import { isIdDocument } from "./id-document-guard";
import { isPersonalDocument } from "./personal-document-guard";
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

/** 竹内さんの2通目を集める（伏せ済み）
 *  2026-11-03 作業員6（統括「会話ごとに全部読む作りをやめる・押した AIX の直後20分だけを時刻の範囲で絞って読む・重い物は分けて続きから」）:
 *    前は会話ごとに messages を全件（最大2万行）読んでいた（11/03 10:44 の手動の実行が時間切れ・表は空のまま）。今は
 *    ①押した時刻の前15分〜後40分の通だけを1回ずつ読む（1回 数十行・間を空ける）
 *    ②申込以降の判定は、会話ごとに書類・申込フォームらしい通だけをサーバーで絞って読み（ilike・数行）、手元で
 *      applicationMaterialReason／isIdDocument／isPersonalDocument を当てる（前の cutBeforeApplicationMaterial と同じ判定）
 *    ③deal_outcomes の申込の時刻より後の押下は使わない（二重の歯止め）④budgetMs を過ぎたら止めて next（続きの時刻）を返す。
 *    名前の伏せは、窓の中のこちらの通の「〇〇さん」とお客様の表示名で行う（前は会話の全部のこちらの通から拾っていた）。 */
export async function collectTakeuchiSeconds(sb: SupabaseClient, opts: { sinceIso: string; beforeIso?: string | null; budgetMs?: number; pauseMs?: number }): Promise<{ cases: TakeuchiSecond[]; stats: Record<string, number>; next: string | null }> {
  type Press = { id: string; conversation_id: string; aix_type: string; send_mode: string | null; picker_choices: Record<string, unknown> | null; created_at: string; generated_text: string | null };
  type Msg = { sender: string; text: string | null; image_url: string | null; image_type?: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 200_000;
  const pause = opts.pauseMs ?? 80;
  const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
  const presses = await readAll<Press>((f, t) => {
    let q = sb.from("aix_usage_logs").select("id, conversation_id, aix_type, send_mode, picker_choices, created_at, generated_text")
      .in("aix_type", ["property_recommendation", "estimate_sheet"]).gte("created_at", opts.sinceIso);
    if (opts.beforeIso) q = q.lt("created_at", opts.beforeIso);
    return q.order("created_at", { ascending: false }).range(f, t);
  }, 5_000);
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  const convIds = [...new Set(presses.map((p) => p.conversation_id))].filter((c) => !isTestConversation(c));
  const names = new Map<string, string>();
  const appliedAt = new Map<string, number>();
  for (let i = 0; i < convIds.length; i += 200) {
    const part = convIds.slice(i, i + 200);
    const { data } = await sb.from("conversations").select("id, customer_name").in("id", part);
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string | null }>) names.set(c.id, c.customer_name ?? "");
    const { data: d2 } = await sb.from("deal_outcomes").select("conversation_id, applied_at").in("conversation_id", part).not("applied_at", "is", null);
    for (const r of (d2 ?? []) as Array<{ conversation_id: string; applied_at: string }>) {
      const a = ms(r.applied_at); const old = appliedAt.get(r.conversation_id);
      if (old === undefined || a < old) appliedAt.set(r.conversation_id, a);
    }
  }
  // 会話ごとの「最初に書類・申込フォーム・個人の値が出た時刻」（サーバーで候補だけに絞り、手元で前と同じ判定を当てる）
  const latestPressOf = new Map<string, string>();
  for (const p of presses) { const o = latestPressOf.get(p.conversation_id); if (!o || p.created_at > o) latestPressOf.set(p.conversation_id, p.created_at); }
  const docCut = new Map<string, number | null>();
  const cutOf = async (c: string): Promise<number | null> => {
    if (docCut.has(c)) return docCut.get(c)!;
    const { data, error } = await sb.from("messages").select("text, image_type, created_at").eq("conversation_id", c)
      .lt("created_at", latestPressOf.get(c) ?? new Date().toISOString()).or(DOC_CANDIDATE_OR).order("created_at").limit(300);
    if (error) throw new Error(error.message);
    let cut: number | null = null;
    for (const m of (data ?? []) as Array<{ text: string | null; image_type: string | null; created_at: string }>) {
      if (applicationMaterialReason(m.text) || isIdDocument(m.image_type, m.text) || isPersonalDocument(m.image_type, m.text)) { cut = ms(m.created_at); break; }
    }
    docCut.set(c, cut);
    await sleep(pause);
    return cut;
  };
  const cases: TakeuchiSecond[] = [];
  let next: string | null = null;
  for (const p of presses) {
    if (Date.now() - t0 > budget) { next = p.created_at; bump("時間切れで続きへ"); break; }
    if (isTestConversation(p.conversation_id)) continue;
    const pt = ms(p.created_at);
    const ap = appliedAt.get(p.conversation_id);
    if (ap !== undefined && ap <= pt) { bump("申込以降"); continue; }
    const { data: win, error: werr } = await sb.from("messages").select("sender, text, image_url, image_type, created_at, is_aix_generated, staff_writer")
      .eq("conversation_id", p.conversation_id).gte("created_at", new Date(pt - 15 * 60_000).toISOString()).lte("created_at", new Date(pt + 40 * 60_000).toISOString())
      .order("created_at").limit(200);
    if (werr) throw new Error(werr.message);
    await sleep(pause);
    const all = (win ?? []) as Msg[];
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
    if (all.some((m) => ms(m.created_at) < firstBlock - 1000 && applicationMaterialReason(m.text))) { bump("申込以降"); continue; }
    const cut = await cutOf(p.conversation_id);
    if (cut !== null && cut < firstBlock - 1000) { bump("申込以降"); continue; }
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
  return { cases, stats, next };
}
/** 書類・申込フォーム・個人の値らしい通の候補（サーバーで絞るだけ・判定は手元の関数） */
export const DOC_CANDIDATE_OR = ["[画像]%", "%記入欄%", "%本人確認%", "%年収%", "%生年月日%", "%@%", "%090%", "%080%", "%070%", "%給与%", "%源泉%", "%住民票%", "%収入証明%"]
  .map((v) => `text.ilike.${v}`).join(",");

/** 集めて表に置く（cron・script の両方から）。
 *  1回で終わらない時は next（続きの時刻）を返す → ?before=<next> でもう1回。分けて集めた時の型の要約は、表の手本から作り直す */
export async function runSecondTakeuchiData(opts: { dry?: boolean; sinceDays?: number; beforeIso?: string | null; budgetMs?: number; pauseMs?: number } = {}): Promise<{ ok: boolean; error?: string; cases?: number; examples?: number; scenes?: number; stats?: Record<string, number>; dry?: boolean; next?: string | null; formsFrom?: "cases" | "table" | "skipped" }> {
  const sb = serviceClient();
  if (!sb) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" };
  try {
    const since = new Date(Date.now() - (opts.sinceDays ?? 365) * 86400_000).toISOString();
    const { cases, stats, next } = await collectTakeuchiSeconds(sb, { sinceIso: since, beforeIso: opts.beforeIso ?? null, budgetMs: opts.budgetMs, pauseMs: opts.pauseMs });
    const rows = buildSecondExampleRows(cases);
    if (!opts.dry) {
      for (let i = 0; i < rows.length; i += 200) {
        const r = await sb.from("second_takeuchi_examples").upsert(rows.slice(i, i + 200), { onConflict: "src" });
        if (r.error) throw new Error(`second_takeuchi_examples: ${r.error.message}`);
      }
    }
    let forms: Record<string, SecondFormData> = {};
    let formsFrom: "cases" | "table" | "skipped" = "skipped";
    if (next === null) {
      if (!opts.beforeIso) { forms = buildSecondForms(cases); formsFrom = "cases"; }
      else if (!opts.dry) {
        // 分けて集めた時: 表の手本（伏せ済み・400字まで）から作り直す（40字未満・URL 入りの2通目は表に無いので入らない＝1回で集めた時より少し粗い）
        const { data, error } = await sb.from("second_takeuchi_examples").select("src, scene, body, sent_on").gte("sent_on", since.slice(0, 10)).limit(5000);
        if (error) throw new Error(error.message);
        forms = buildSecondForms(((data ?? []) as Array<{ src: string; scene: string; body: string; sent_on: string }>)
          .map((r) => ({ src: r.src, scene: r.scene, at: `${r.sent_on}T00:00:00Z`, card: "", sent: r.body })));
        formsFrom = "table";
      }
      if (!opts.dry && Object.keys(forms).length) {
        const fr = await sb.from("second_takeuchi_forms").upsert(Object.entries(forms).map(([scene, data]) => ({ scene, data, updated_at: new Date().toISOString() })), { onConflict: "scene" });
        if (fr.error) throw new Error(`second_takeuchi_forms: ${fr.error.message}`);
      }
    }
    return { ok: true, cases: cases.length, examples: rows.length, scenes: Object.keys(forms).length, stats, dry: !!opts.dry, next, formsFrom };
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
