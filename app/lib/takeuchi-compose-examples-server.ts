// app/lib/takeuchi-compose-examples-server.ts — 文の指示役の場面の RAG（竹内さん本人の返信）を作る・引く（サーバー専用・サーバーの鍵）
//
// 2026-11-03 作業員6（竹内さん「この場面にはこれが良いってのも RAG 検索等で分かれば」・統括「手本の置き場は DB・RLS・サーバーの鍵・効いた重み」）。
//   表: takeuchi_compose_examples（RLS 有効・anon/authenticated は REVOKE・RPC match_takeuchi_compose は service_role だけ）。会話由来の文は倉庫に置かない。
//   作る: 週1の夜の cron（/api/cron/takeuchi-compose-examples）。営業時間（JST 9〜22時）は動かない。
//     1回 最大 limit 通（既定 300）・前回の続き（表の一番新しい sent_at の後）から古い順に・budgetMs で止めて next を返す。
//     1通ごとの読みは、その会話の前3日のお客様の発言（最大30行）と後の最初のお客様の発言（1行）だけ（会話の全部は読まない・間を空ける）。
//   重み: deal_outcomes の内覧（viewing_at / viewing_held_at）・申込（applied_at）と、次の返信までの分（composeExampleWeight）。
//   使わない番: 申込以降（deal_outcomes.applied_at の後・書類や申込フォームの通の後）・お断り・定型・個人の値の入った通。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { isTestConversation } from "./test-conversations";
import { applicationMaterialReason, piiValueSignal } from "./test-pii-guard";
import { maskPII } from "./pii-mask";
import { isIdDocument } from "./id-document-guard";
import { isPersonalDocument } from "./personal-document-guard";
import { resolveReplyScene } from "./reply-scene";
import { purposeOfText, composeExampleWeight, composeEmbedInput, sentencesOf, tagSentence } from "./compose-blueprint";
import { DOC_CANDIDATE_OR } from "./second-takeuchi-data-server";
import { readBeyondOf, worryCandidatesOf, utterTypesOf } from "./reading-tags";
import { embedTexts } from "./design-knowledge-rag-server";

function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
const ms = (s: string) => Date.parse(s);
export const conversationKey = (c: string) => createHash("sha256").update(c).digest("hex").slice(0, 16);

type Row = {
  message_id: string; conversation_key: string; sent_at: string; scene: string; purpose: string; seq: string[]; main_line: string; body: string;
  customer_gist: string | null; after_aix: boolean; reply_minutes: number | null; viewing_7d: boolean | null; applied_14d: boolean | null; weight: number; embedding: string | null;
  read_beyond: string[]; hidden_worry: string[]; utter_type: string[]; true_want: string[]; true_want_at: string | null; forward_score: number;
};

export async function runTakeuchiComposeExamples(opts: { dry?: boolean; afterIso?: string | null; limit?: number; budgetMs?: number; pauseMs?: number } = {}): Promise<{ ok: boolean; error?: string; read?: number; rows?: number; stats?: Record<string, number>; next?: string | null; embedTokens?: number; dry?: boolean }> {
  const sb = serviceClient();
  if (!sb) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" };
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 200_000;
  const pause = opts.pauseMs ?? 80;
  const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  try {
    let after = opts.afterIso ?? null;
    if (!after) {
      const { data } = await sb.from("takeuchi_compose_examples").select("sent_at").order("sent_at", { ascending: false }).limit(1);
      after = (data?.[0] as { sent_at?: string } | undefined)?.sent_at ?? "2026-01-01T00:00:00Z";
    }
    // 竹内さん本人の送信（staff_writer の部分 index・古い順・1回 limit 通）
    const { data: msgs, error } = await sb.from("messages").select("id, conversation_id, text, created_at")
      .eq("staff_writer", "takeuchi").eq("staff_writer_confidence", "sure").eq("staff_writer_source", "device").eq("sender", "staff")
      .or("is_aix_generated.is.null,is_aix_generated.eq.false").gt("created_at", after).order("created_at").limit(Math.min(opts.limit ?? 300, 500));
    if (error) throw new Error(error.message);
    const list = ((msgs ?? []) as Array<{ id: string; conversation_id: string; text: string | null; created_at: string }>).filter((m) => !isTestConversation(m.conversation_id));
    const convIds = [...new Set(list.map((m) => m.conversation_id))];
    const names = new Map<string, string>();
    const deals = new Map<string, Array<{ applied: number | null; viewing: number | null }>>();
    for (let i = 0; i < convIds.length; i += 200) {
      const part = convIds.slice(i, i + 200);
      const { data: cs } = await sb.from("conversations").select("id, customer_name").in("id", part);
      for (const c of (cs ?? []) as Array<{ id: string; customer_name: string | null }>) names.set(c.id, c.customer_name ?? "");
      const { data: ds } = await sb.from("deal_outcomes").select("conversation_id, applied_at, viewing_at, viewing_held_at").in("conversation_id", part);
      for (const d of (ds ?? []) as Array<{ conversation_id: string; applied_at: string | null; viewing_at: string | null; viewing_held_at: string | null }>) {
        const l = deals.get(d.conversation_id) ?? [];
        l.push({ applied: d.applied_at ? ms(d.applied_at) : null, viewing: d.viewing_held_at ? ms(d.viewing_held_at) : d.viewing_at ? ms(d.viewing_at) : null });
        deals.set(d.conversation_id, l);
      }
    }
    const docCut = new Map<string, number | null>();
    const cutOf = async (c: string): Promise<number | null> => {
      if (docCut.has(c)) return docCut.get(c)!;
      const { data, error: e } = await sb.from("messages").select("text, image_type, created_at").eq("conversation_id", c).or(DOC_CANDIDATE_OR).order("created_at").limit(300);
      if (e) throw new Error(e.message);
      let cut: number | null = null;
      for (const m of (data ?? []) as Array<{ text: string | null; image_type: string | null; created_at: string }>) {
        if (applicationMaterialReason(m.text) || isIdDocument(m.image_type, m.text) || isPersonalDocument(m.image_type, m.text)) { cut = ms(m.created_at); break; }
      }
      docCut.set(c, cut);
      await sleep(pause);
      return cut;
    };
    const rows: Omit<Row, "embedding">[] = [];
    let next: string | null = null;
    let lastDone: string | null = null;
    for (const m of list) {
      if (Date.now() - t0 > budget) { next = lastDone; bump("時間切れで続きへ"); break; }
      lastDone = m.created_at;
      const text = String(m.text ?? "").trim();
      if (!text || /^\[(?:画像|スタンプ|動画|ファイル)\]/.test(text) || /^【グループ】/.test(text)) { bump("画像・転送"); continue; }
      const p = purposeOfText(text);
      if (p.purpose === "material" || p.purpose === "decline") { bump(`外す:${p.purpose}`); continue; }
      const at = ms(m.created_at);
      const ap = (deals.get(m.conversation_id) ?? []).map((d) => d.applied).filter((x): x is number => x != null);
      if (ap.some((a) => a <= at)) { bump("申込以降"); continue; }
      const cut = await cutOf(m.conversation_id);
      if (cut !== null && cut <= at) { bump("申込以降"); continue; }
      // 前3日のお客様の発言（この通の前の、こちらの通より後の連投）と、AIX の直後か
      const { data: prev, error: pe } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", m.conversation_id)
        .gte("created_at", new Date(at - 3 * 86400_000).toISOString()).lt("created_at", m.created_at).order("created_at", { ascending: false }).limit(30);
      if (pe) throw new Error(pe.message);
      await sleep(pause);
      const pv = (prev ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>;
      const cust: string[] = [];
      for (const x of pv) { if (x.sender === "staff" && ms(x.created_at) < at - 5 * 60_000) break; if (x.sender !== "staff") cust.unshift(String(x.text ?? "")); }
      const olderCust = pv.filter((x) => x.sender !== "staff" && !cust.includes(String(x.text ?? ""))).map((x) => String(x.text ?? ""));
      const prevStaffAt = pv.find((x) => x.sender === "staff" && ms(x.created_at) < at - 5 * 60_000)?.created_at;
      const firstCustAt = pv.filter((x) => x.sender !== "staff" && (!prevStaffAt || x.created_at > prevStaffAt)).map((x) => x.created_at).sort()[0];
      const custGap = prevStaffAt && firstCustAt ? Math.round((ms(firstCustAt) - ms(prevStaffAt)) / 60_000) : null;
      const afterAix = pv.some((x) => x.sender === "staff" && x.is_aix_generated && ms(x.created_at) >= at - 20 * 60_000);
      const { data: nx } = await sb.from("messages").select("created_at").eq("conversation_id", m.conversation_id).neq("sender", "staff").gt("created_at", m.created_at).order("created_at").limit(1);
      await sleep(pause);
      const nextAt = (nx?.[0] as { created_at?: string } | undefined)?.created_at;
      const replyMinutes = nextAt ? Math.round((ms(nextAt) - at) / 60_000) : null;
      const ds = deals.get(m.conversation_id) ?? [];
      const viewing7d = ds.some((d) => d.viewing != null && d.viewing > at && d.viewing <= at + 7 * 86400_000);
      const applied14d = ds.some((d) => d.applied != null && d.applied > at && d.applied <= at + 14 * 86400_000);
      // 伏せ（お客様の表示名・こちらの通の「〇〇さん」→ YUMA・maskPII・URL・電話）
      const ns = [names.get(m.conversation_id) ?? "", ...(text.match(/^([^\s\n、。！!]{1,8})さん/) ? [text.match(/^([^\s\n、。！!]{1,8})さん/)![1]] : [])]
        .map((s) => s.trim()).filter((s) => s && s !== "YUMA").sort((a, b) => b.length - a.length);
      const mask = (t: string) => {
        let r = String(t ?? "");
        for (const n of ns) r = r.split(`${n}さん`).join("YUMAさん");
        for (const n of ns) if (n.length >= 2) r = r.split(n).join("YUMA");
        return maskPII(r).replace(/https?:\/\/\S+/g, "〈URL〉").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉");
      };
      const body = mask(text).slice(0, 400);
      const custText = cust.join("\n");
      if (cust.some((c) => applicationMaterialReason(c)) || piiValueSignal(body) || piiValueSignal(custText)) { bump("書類・個人の値"); continue; }
      const gist = custText ? mask(custText).slice(0, 200) : null;
      const scene = custText ? resolveReplyScene({ customerText: custText }).scene : afterAix ? "after_aix" : "staff_first";
      const mainLine = p.main ? mask(p.main).slice(0, 160) : sentencesOf(body).find((s) => !["list"].includes(tagSentence(s))) ?? body.slice(0, 80);
      rows.push({
        message_id: m.id, conversation_key: conversationKey(m.conversation_id), sent_at: m.created_at, scene, purpose: p.purpose, seq: p.seq, main_line: mainLine, body,
        customer_gist: gist, after_aix: afterAix, reply_minutes: replyMinutes, viewing_7d: viewing7d, applied_14d: applied14d,
        weight: composeExampleWeight({ replyMinutes, viewing7d, applied14d }),
        // 2026-11-03 読み方の候補（決定論の候補の札・決めるのはブレイン）と、その後に分かった事（2つ目の物差しの土台）
        read_beyond: custText ? readBeyondOf(custText, text) : [], hidden_worry: custText ? worryCandidatesOf(custText) : [],
        utter_type: custText ? utterTypesOf({ customerText: custText, prevCustomerTexts: olderCust, replyGapMinutes: custGap }) : [],
        true_want: [...(viewing7d ? ["viewed"] : []), ...(applied14d ? ["applied"] : []), ...(replyMinutes != null && replyMinutes <= 60 ? ["reply_fast"] : [])],
        true_want_at: viewing7d || applied14d ? new Date(at + 14 * 86400_000).toISOString() : null,
        forward_score: Math.round((composeExampleWeight({ replyMinutes, viewing7d, applied14d }) - 1) * 100) / 100,
      });
      bump("採用");
    }
    if (next === null && list.length >= Math.min(opts.limit ?? 300, 500)) next = lastDone;   // 1回の上限に達した＝まだ続きがある
    let embedTokens = 0;
    if (!opts.dry && rows.length) {
      for (let i = 0; i < rows.length; i += 64) {
        const part = rows.slice(i, i + 64);
        const { vectors, tokens } = await embedTexts(part.map((r) => composeEmbedInput({ scene: r.scene, purpose: r.purpose, customerGist: r.customer_gist, intentWhat: r.main_line })));
        embedTokens += tokens;
        const up = part.map((r, k) => ({ ...r, embedding: vectors[k] ? `[${vectors[k]!.join(",")}]` : null, built_at: new Date().toISOString() }));
        const res = await sb.from("takeuchi_compose_examples").upsert(up, { onConflict: "message_id" });
        if (res.error) throw new Error(`takeuchi_compose_examples: ${res.error.message}`);
      }
    }
    return { ok: true, read: list.length, rows: rows.length, stats, next, embedTokens, dry: !!opts.dry };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), stats };
  }
}

export type ComposeExampleHit = { message_id: string; scene: string; purpose: string; seq: string[]; main_line: string; body: string; customer_gist: string | null; weight: number; similarity: number; score: number };
/** 引く（構成のブレインの根拠）。鍵が無い・表が空・失敗の時は []（ログに1行・本番の返信は止めない） */
export async function matchTakeuchiCompose(o: { scene: string | null; purpose: string | null; customerGist: string | null; intentWhat?: string | null; conversationId?: string | null; k?: number }): Promise<ComposeExampleHit[]> {
  const sb = serviceClient();
  if (!sb) { console.warn(JSON.stringify({ tag: "compose-rag:no-key" })); return []; }
  try {
    const { vectors } = await embedTexts([composeEmbedInput({ scene: o.scene ?? "", purpose: o.purpose ?? "", customerGist: o.customerGist, intentWhat: o.intentWhat })]);
    if (!vectors[0]) return [];
    const { data, error } = await sb.rpc("match_takeuchi_compose", {
      query_embedding: `[${vectors[0].join(",")}]`, p_scene: o.scene, p_purpose: o.purpose, match_count: o.k ?? 3,
      p_exclude_key: o.conversationId ? conversationKey(o.conversationId) : null,
    });
    if (error) { console.warn(JSON.stringify({ tag: "compose-rag:failed", error: error.message })); return []; }
    return (data ?? []) as ComposeExampleHit[];
  } catch (e) {
    console.warn(JSON.stringify({ tag: "compose-rag:failed", error: e instanceof Error ? e.message : String(e) }));
    return [];
  }
}
