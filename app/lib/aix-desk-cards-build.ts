// app/lib/aix-desk-cards-build.ts — AIX のボタン×ピッカーごとの「担当の札」を作って表 aix_desk_cards に書く（サーバー専用・DB を読む・LLM は設計知見の検索の埋め込みだけ）
//
// 2026-10-29 竹内さん（KB P1 ad20192b「AIX の中身を理解」・03d2bdd2「ボタンとピッカーごとに担当」・76c249e0「竹内基準」）・作業員1:
//   担当の札＝その担当が持つ自分の中身: 送る中身・使う場面・似たボタンとの線（カタログ）／竹内さんの文に入る物・目的（AIX_LEARNED）／入力欄（aix-pickers）／
//   一緒に使われた定型（templates）／竹内さんの決定（設計知見の RAG・題にボタンの語がある物）／竹内さんの番（お客様の発言→竹内さんの文・伏せた物）／押し間違いの例（従業員の送信）。
//   学ぶのは竹内さんの送信だけ（messages.staff_writer='takeuchi'・sure）。竹内さん自身の押し間違い（文がそのピッカーの意味に合わない）は手本にしない。
//   伏せ: 呼び名・URL・電話・号室・【物件名】・個人の値（text-mask-names・aix-meaning-learn.maskExemplar・example-pii-guard.sanitizeExampleText）。テストの会話の文は使わない。
//   呼ぶ所: 週1の cron（/api/cron/aix-desk-cards・サーバーの鍵）と scripts/build-aix-desk-cards.ts（手元の写し・試し用）。札の本文は git に入れない（表だけ）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { AIX_CATALOG, catalogKeyOfPress, MAIN_PICKER_FIELD } from "./aix-catalog";
import { AIX_PICKERS } from "./aix-pickers";
import { AIX_LEARNED } from "./aix-catalog-learned";
import { maskExemplar, misPressOf } from "./aix-meaning-learn";
import { sanitizeExampleText } from "./example-pii-guard";
import { isTestConversation } from "./test-conversations";
import { maskExamText, addressNamesOf } from "./text-mask-names";
import { loadRagRows, searchKb } from "./design-knowledge-rag-server";

export type AixDeskCardRow = { key: string; button: string; picker: string | null; text: string; owner: number; thin: string[] };
export const AIX_DESK_OWNER_MIN = 3;

/** 伏せる: お客様の呼び名（「〇〇さん」）・URL・号室・【物件名】・個人の値 */
const safe = (t: string, names: string[], side: "customer" | "staff" = "staff") => sanitizeExampleText(maskExemplar(maskExamText(String(t ?? "").replace(/https?:\/\/\S+/g, "[URL]"), null, names)), side).text;
const isTestText = (t: string) => /YUMA/i.test(t);
const one = (s: string, n: number) => Array.from(String(s ?? "").replace(/\s+/g, " ").trim()).slice(0, n).join("");
/** ボタン名・ピッカー名の芯の語（括弧・「について」を外す・2字以上・件数や「物件」は外す） */
export const coreWords = (label: string | null | undefined) => String(label ?? "").split(/[（）()／→・！]/).map((x) => x.replace(/について|した$|する$|送る$|してた$/g, "").trim())
  .filter((x) => x.length >= 2 && !/^(?:[0-9０-９]+件|複数件|物件|通常)$/.test(x)).flatMap((x) => (x.length >= 4 ? [x, x.slice(0, 2)] : [x]));

type Usage = { conversation_id: string; aix_type: string | null; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: unknown; generated_text: string | null; line_message_id: string | null; template_id: string | null; created_at: string };
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; line_message_id: string | null; staff_writer: string | null; staff_writer_confidence: string | null };

async function pageAll<T>(sb: SupabaseClient, table: string, cols: string, f: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    let r: { data: unknown; error: { message: string } | null } = { data: null, error: null };
    for (let t = 0; t < 4; t++) { r = await f(sb.from(table).select(cols)).range(i, i + 999); if (!r.error) break; await new Promise((s) => setTimeout(s, 3000)); }
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    const rows = (r.data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/** 札を作る（DB は読むだけ） */
export async function buildAixDeskCards(sb: SupabaseClient, o: { days?: number } = {}): Promise<{ cards: AixDeskCardRow[]; usages: number }> {
  const days = o.days ?? 180;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const usages = (await pageAll<Usage>(sb, "aix_usage_logs", "conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, generated_text, line_message_id, template_id, created_at", (q) => q.gte("created_at", since).order("created_at")))
    .filter((u) => !isTestConversation(u.conversation_id));
  const convIds = [...new Set(usages.map((u) => u.conversation_id))];
  const byConv = new Map<string, Msg[]>();
  for (let i = 0; i < convIds.length; i += 50) {
    const part = convIds.slice(i, i + 50);
    const ms = await pageAll<Msg>(sb, "messages", "conversation_id, sender, text, created_at, line_message_id, staff_writer, staff_writer_confidence", (q) => q.in("conversation_id", part).gte("created_at", new Date(Date.parse(since) - 7 * 86_400_000).toISOString()).order("created_at"));
    for (const m of ms) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  }
  const byLm = new Map<string, Msg>();
  for (const list of byConv.values()) for (const m of list) if (m.line_message_id) byLm.set(m.line_message_id, m);

  // 鍵ごと: 竹内さんの送信（お客様の直前の発言→竹内さんの文）・テンプレートの使われ方・従業員の押し間違い
  const ownerScenes = new Map<string, Array<{ cust: string; sent: string }>>();
  const ownerCount = new Map<string, number>();
  const tplUse = new Map<string, Map<string, number>>();
  const mis = new Map<string, { n: number; reasons: Map<string, number>; ex: string | null }>();
  for (const u of usages) {
    const m = u.line_message_id ? byLm.get(u.line_message_id) : undefined;
    const sentRaw = m?.text ?? u.generated_text ?? "";
    const key = catalogKeyOfPress({ aix_type: u.aix_type, check_pattern: u.check_pattern, send_mode: u.send_mode, app_sub_mode: u.app_sub_mode, picker_choices: u.picker_choices, text: u.generated_text ?? m?.text ?? null }).key;
    if (u.template_id) { const t = tplUse.get(key) ?? new Map<string, number>(); t.set(u.template_id, (t.get(u.template_id) ?? 0) + 1); tplUse.set(key, t); }
    const mp = misPressOf(key, sentRaw);
    if (mp && m?.staff_writer === "employee") {
      const v = mis.get(key) ?? { n: 0, reasons: new Map<string, number>(), ex: null };
      v.n++; v.reasons.set(mp.reason, (v.reasons.get(mp.reason) ?? 0) + 1);
      if (!v.ex && !isTestText(sentRaw)) v.ex = safe(sentRaw, addressNamesOf((byConv.get(u.conversation_id) ?? []).filter((x) => x.sender !== "customer").map((x) => x.text ?? "")));
      mis.set(key, v);
    }
    if (!(m && m.staff_writer === "takeuchi" && m.staff_writer_confidence === "sure")) continue;
    ownerCount.set(key, (ownerCount.get(key) ?? 0) + 1);
    // 竹内さん自身の押し間違い（文がそのピッカーの意味に合わない・例 内覧調整を押して待ち合わせの文）は手本にしない
    if (mp) continue;
    const list = byConv.get(u.conversation_id) ?? [];
    const at = Date.parse(m.created_at);
    const cust = [...list].reverse().find((x) => x.sender === "customer" && Date.parse(x.created_at) < at && (x.text ?? "").trim());
    const sc = ownerScenes.get(key) ?? [];
    const names = addressNamesOf(list.filter((x) => x.sender !== "customer").map((x) => x.text ?? ""));
    if (sc.length < 3 && cust && !isTestText(sentRaw) && !isTestText(cust.text ?? "")) sc.push({ cust: one(safe(cust.text ?? "", names, "customer"), 90), sent: one(safe(sentRaw, names), 160) });
    ownerScenes.set(key, sc);
  }
  const tplIds = [...new Set([...tplUse.values()].flatMap((m) => [...m.keys()]))];
  const tplText = new Map<string, { label: string; text: string }>();
  for (let i = 0; i < tplIds.length; i += 100) {
    const { data } = await sb.from("templates").select("id, label, text").in("id", tplIds.slice(i, i + 100));
    for (const t of (data ?? []) as Array<{ id: string; label: string; text: string }>) tplText.set(String(t.id), { label: t.label, text: t.text });
  }
  // 竹内さんの決定: AIX_LEARNED.kb の題＋設計知見の RAG（題にボタン・ピッカーの芯の語がある物だけ）
  const kbIds = [...new Set(Object.values(AIX_LEARNED).flatMap((l) => l.kb ?? []))];
  const ragRows = await loadRagRows(sb);
  const kbTitle = new Map<string, string>();
  for (const r of ragRows) { const k = String(r.id).slice(0, 8); if (kbIds.includes(k)) kbTitle.set(k, r.title); }
  const decisionsFor = async (e: { button: string; picker: { label: string } | null; staffOnly: string; when: string }): Promise<string[]> => {
    const q = `AIX【${e.button}】${e.picker ? `→${e.picker.label}` : ""}を押す時・押さない時 ${e.staffOnly} ${e.when}`.slice(0, 300);
    const hits = await searchKb(sb, q, { k: 12, rows: ragRows });
    const words = coreWords(e.button).concat(coreWords(e.picker?.label ?? null));
    return hits.filter((h) => (h.row.tags ?? []).includes("竹内さんの決定") && h.vector >= 0.45 && words.some((w) => h.row.title.includes(w))).slice(0, 3).map((h) => `${String(h.row.id).slice(0, 8)} ${h.row.title}`);
  };

  const cards: AixDeskCardRow[] = [];
  for (const e of AIX_CATALOG) {
    if (!e.brainSelectable) continue;
    const spec = AIX_PICKERS[e.aixType];
    const learned = AIX_LEARNED[e.key];
    const mainField = MAIN_PICKER_FIELD[e.aixType];
    const inputs = (spec?.pickers ?? []).filter((p) => p.key !== mainField && (!p.onlyWhen || (e.picker && p.onlyWhen.key === e.picker.field && p.onlyWhen.values.includes(e.picker.value))))
      .map((p) => `${p.label}${p.options?.length ? `（${[...new Set(p.options.map((x) => x.label))].slice(0, 5).join("／")}）` : ""}`).slice(0, 8);
    const tu = [...(tplUse.get(e.key) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    const tuAll = tu.reduce((a, [, n]) => a + n, 0);
    // その鍵の送信の3割以上・3回以上で使われた定型だけ（続きの定型との取り違えを外す）
    const tpls = tu.filter(([, n]) => n >= 3 && n / Math.max(1, tuAll) >= 0.3).slice(0, 1).map(([id]) => tplText.get(id)).filter(Boolean) as Array<{ label: string; text: string }>;
    const scenes = ownerScenes.get(e.key) ?? [];
    const owner = ownerCount.get(e.key) ?? 0;
    const kw = coreWords(e.button).concat(coreWords(e.picker?.label ?? null));
    const kb = [...new Set([...((learned?.kb ?? []).map((k) => (kbTitle.has(k) && kw.some((w) => kbTitle.get(k)!.includes(w)) ? `${k} ${kbTitle.get(k)}` : null)).filter(Boolean) as string[]), ...(await decisionsFor(e))])].slice(0, 4);
    const mp = mis.get(e.key);
    const thin: string[] = [];
    if (owner < AIX_DESK_OWNER_MIN) thin.push(`竹内さんの送信 ${owner}件（${AIX_DESK_OWNER_MIN}未満）`);
    if (!tpls.length) thin.push("テンプレートの記録なし");
    if (!kb.length) thin.push("竹内さんの決定なし");
    if (!e.when.trim()) thin.push("使う場面の定義なし");
    const lines: string[] = [];
    lines.push(`■担当 ${e.key}｜${e.button}${e.picker ? ` → ${e.picker.label}` : ""}`);
    lines.push(`送る中身（スタッフだけが知る事）: ${e.staffOnly || "なし（定型の資料・フォーム）"}`);
    lines.push(`使う場面: ${one(e.when, 200)}`);
    if (e.lines) lines.push(`似たボタンとの線: ${one(e.lines, 200)}`);
    if (learned?.purpose) lines.push(`目的: ${one(learned.purpose, 160)}`);
    if (learned?.writeContains?.length) lines.push(`竹内さんの文に入る物: ${learned.writeContains.join("・")}`);
    if (inputs.length) lines.push(`入力欄・確認事項: ${inputs.join("／")}`);
    if (tpls.length) lines.push(`一緒に使われた定型「${one(tpls[0].label, 30)}」: ${one(maskExemplar(tpls[0].text), 200)}`);
    if (kb.length) lines.push(`竹内さんの決定: ${kb.map((t) => one(t, 70)).join("／")}`);
    for (const s of scenes) lines.push(`竹内さんの番: 客「${s.cust}」→「${s.sent}」`);
    if (mp) {
      const why = [...mp.reasons].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      lines.push(`押し間違いの例（${mp.n}件・${one(why, 60)}）${mp.ex ? `: 「${one(mp.ex, 100)}」` : ""}`);
    }
    cards.push({ key: e.key, button: e.button, picker: e.picker?.label ?? null, text: lines.join("\n"), owner, thin });
  }
  return { cards, usages: usages.length };
}

/** 表 aix_desk_cards に書く（サーバーの鍵の client で） */
export async function upsertAixDeskCards(admin: SupabaseClient, cards: readonly AixDeskCardRow[], source: string): Promise<void> {
  const at = new Date().toISOString();
  const { error } = await admin.from("aix_desk_cards").upsert(cards.map((c) => ({ key: c.key, button: c.button, picker: c.picker, card_text: c.text, owner_count: c.owner, thin: c.thin, generated_at: at, source })), { onConflict: "key" });
  if (error) throw new Error(`aix_desk_cards: ${error.message}`);
}
