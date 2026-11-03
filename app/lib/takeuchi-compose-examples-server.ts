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
import { customerNameTokens, maskCustomerNames, staffHeadNames } from "./compose-name-mask";

/** 伏せの版（2026-11-03 夜の直し）。この日時より前に作った行は、cron が先に元の送信から作り直す（問いの値なしで直る） */
export const COMPOSE_MASK_VER = "20261104a";
export const COMPOSE_MASK_VER_AT = "2026-11-03T16:00:00Z";   // 版の日時は push より前（11/03 の 14:30Z は push の後だった）

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

export async function runTakeuchiComposeExamples(opts: { dry?: boolean; afterIso?: string | null; limit?: number; budgetMs?: number; pauseMs?: number } = {}): Promise<{ ok: boolean; error?: string; read?: number; rows?: number; stats?: Record<string, number>; next?: string | null; embedTokens?: number; dry?: boolean; stale?: number; failed?: string[] }> {
  const sb = serviceClient();
  if (!sb) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" };
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 200_000;
  const pause = opts.pauseMs ?? 80;
  const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  try {
    // 2026-11-03 伏せの版（COMPOSE_MASK_VER_AT）より前に作った行（built_at が古い）を、まず最大 limit 行だけ元の送信から作り直す
    //   （問いの値が無くても直る作り・週1の cron でも自分で直る）。古い行が無くなってから、今まで通り新しい送信へ進む
    const lim = Math.min(opts.limit ?? 300, 500);
    const { data: stale } = opts.afterIso ? { data: [] as Array<{ message_id: string }> } : await sb.from("takeuchi_compose_examples").select("message_id")
      .lt("built_at", COMPOSE_MASK_VER_AT).order("sent_at").limit(lim);
    const staleIds = ((stale ?? []) as Array<{ message_id: string }>).map((r) => r.message_id);
    let msgs: unknown[] | null = null;
    if (staleIds.length) {
      bump(`作り直し（伏せの版 ${COMPOSE_MASK_VER}）`);
      const r = await sb.from("messages").select("id, conversation_id, text, created_at").in("id", staleIds).order("created_at");
      if (r.error) throw new Error(r.error.message);
      msgs = r.data ?? [];
    } else {
      let after = opts.afterIso ?? null;
      if (!after) {
        const { data } = await sb.from("takeuchi_compose_examples").select("sent_at").order("sent_at", { ascending: false }).limit(1);
        after = (data?.[0] as { sent_at?: string } | undefined)?.sent_at ?? "2026-01-01T00:00:00Z";
      }
      // 竹内さん本人の送信（staff_writer の部分 index・古い順・1回 limit 通）
      const r = await sb.from("messages").select("id, conversation_id, text, created_at")
        .eq("staff_writer", "takeuchi").eq("staff_writer_confidence", "sure").eq("staff_writer_source", "device").eq("sender", "staff")
        .or("is_aix_generated.is.null,is_aix_generated.eq.false").gt("created_at", after).order("created_at").limit(lim);
      if (r.error) throw new Error(r.error.message);
      msgs = r.data ?? [];
    }
    const list = ((msgs ?? []) as Array<{ id: string; conversation_id: string; text: string | null; created_at: string }>).filter((m) => !isTestConversation(m.conversation_id));
    const convIds = [...new Set(list.map((m) => m.conversation_id))];
    const names = new Map<string, string[]>();
    const deals = new Map<string, Array<{ applied: number | null; viewing: number | null }>>();
    for (let i = 0; i < convIds.length; i += 200) {
      const part = convIds.slice(i, i + 200);
      const { data: cs } = await sb.from("conversations").select("id, customer_name, call_name").in("id", part);
      for (const c of (cs ?? []) as Array<{ id: string; customer_name: string | null; call_name: string | null }>) names.set(c.id, customerNameTokens([c.customer_name, c.call_name]));
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
    const failedIds: string[] = [];
    /** 文字を「文字の数」で切る（絵文字の片方だけ残すと DB と埋め込みが断る） */
    const cut = (t: string, n: number) => Array.from(String(t ?? "")).slice(0, n).join("");
    for (const m of list) {
      if (Date.now() - t0 > budget) { next = lastDone; bump("時間切れで続きへ"); break; }
      lastDone = m.created_at;
      try {
      const text = String(m.text ?? "").trim();
      if (!text || /^\[(?:画像|スタンプ|動画|ファイル)\]/.test(text) || /^【グループ】/.test(text)) { bump("画像・転送"); continue; }
      const p = purposeOfText(text);
      if (p.purpose === "material" || p.purpose === "decline") { bump(`外す:${p.purpose}`); continue; }
      const at = ms(m.created_at);
      const ap = (deals.get(m.conversation_id) ?? []).map((d) => d.applied).filter((x): x is number => x != null);
      if (ap.some((a) => a <= at)) { bump("申込以降"); continue; }
      const docCutAt = await cutOf(m.conversation_id);
      if (docCutAt !== null && docCutAt <= at) { bump("申込以降"); continue; }
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
      // 伏せ（2026-11-03 直し: その会話のお客様の名前＝表示名・呼び名とその姓・名だけ → YUMA。文の途中の「〇〇さん」を正規表現で置き換えない＝compose-name-mask.ts）＋maskPII・URL・電話
      const mask = (t: string) => {
        // 20261104a: 表示名・呼び名に、こちらの文の頭の「〇〇さん」（この通と前3日のこちらの通）を足す
        const r = maskCustomerNames(String(t ?? ""), customerNameTokens([...(names.get(m.conversation_id) ?? []), ...staffHeadNames([text, ...pv.filter((x) => x.sender === "staff").map((x) => x.text)])]));
        return maskPII(r).replace(/https?:\/\/\S+/g, "〈URL〉").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉");
      };
      const body = cut(mask(text), 400);
      const custText = cust.join("\n");
      if (cust.some((c) => applicationMaterialReason(c)) || piiValueSignal(body) || piiValueSignal(custText)) { bump("書類・個人の値"); continue; }
      const gist = custText ? cut(mask(custText), 200) : null;
      const scene = custText ? resolveReplyScene({ customerText: custText }).scene : afterAix ? "after_aix" : "staff_first";
      const mainLine = p.main ? cut(mask(p.main), 160) : sentencesOf(body).find((s) => !["list"].includes(tagSentence(s))) ?? cut(body, 80);
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
      } catch (e) {
        // 1通の失敗で回全体を止めない（その通は飛ばして記録・古い行なら次の回にもう一度）
        bump("読めずに飛ばした"); failedIds.push(m.id);
        console.warn(JSON.stringify({ tag: "compose-examples:message-failed", messageId: m.id, error: e instanceof Error ? e.message : String(e) }));
      }
    }
    if (!staleIds.length && next === null && list.length >= Math.min(opts.limit ?? 300, 500)) next = lastDone;   // 1回の上限に達した＝まだ続きがある（作り直しの回は次の回が古い行を選び直す）
    let embedTokens = 0;
    if (!opts.dry && rows.length) {
      for (let i = 0; i < rows.length; i += 64) {
        const part = rows.slice(i, i + 64);
        const { vectors, tokens } = await embedTexts(part.map((r) => composeEmbedInput({ scene: r.scene, purpose: r.purpose, customerGist: r.customer_gist, intentWhat: r.main_line })))
          .catch((e) => { bump("埋め込みに失敗（埋め込みなしで書く）"); console.warn(JSON.stringify({ tag: "compose-examples:embed-failed", error: e instanceof Error ? e.message : String(e) })); return { vectors: part.map(() => null) as Array<number[] | null>, tokens: 0 }; });
        embedTokens += tokens;
        // 作り直し（同じ通をもう一度作る時・?after= で前から）: 本文が前と変わった行は文の解剖を読み直す（anatomy を空に・anatomy_pick は残す）
        const { data: prevRows } = await sb.from("takeuchi_compose_examples").select("message_id, body, anatomy").in("message_id", part.map((r) => r.message_id));
        //   11/03 夜の伏せ直しの失敗（かなの続きを YUMA に置き換えた）は anatomy の文にも入った＝本文が同じでも「かな・漢字の直後の YUMAさん」がある解剖は読み直す
        const prevBody = new Map(((prevRows ?? []) as Array<{ message_id: string; body: string; anatomy: unknown }>).map((r) => [r.message_id, { body: r.body, hasAnatomy: r.anatomy != null, brokenAnatomy: r.anatomy != null && /[ぁ-んァ-ヶ一-龯]YUMAさん/.test(JSON.stringify(r.anatomy)) }]));
        const plain: Array<Record<string, unknown>> = [], reread: Array<Record<string, unknown>> = [];
        part.forEach((r, k) => {
          const pv = prevBody.get(r.message_id);
          const rr = !!pv && pv.hasAnatomy && (pv.body !== r.body || pv.brokenAnatomy);
          const base = { ...r, embedding: vectors[k] ? `[${vectors[k]!.join(",")}]` : null, built_at: new Date().toISOString() };
          if (rr) { bump("本文が変わって解剖を読み直す"); reread.push({ ...base, anatomy: null, anatomy_conflicts: [] as string[], anatomy_at: null }); } else plain.push(base);
        });
        // 2026-11-03 作り直しが止まった原因: 1回の upsert に anatomy の欄がある行と無い行が混ざると PostgREST が丸ごと断る（All object keys must match）
        //   → 欄のそろった2組に分けて送る。1組が断られた時は1行ずつ送り直し、それでも断られた行は飛ばして記録する（1行の失敗で回全体を止めない）
        for (const grp of [plain, reread]) {
          if (!grp.length) continue;
          const res = await sb.from("takeuchi_compose_examples").upsert(grp, { onConflict: "message_id" });
          if (!res.error) continue;
          console.warn(JSON.stringify({ tag: "compose-examples:upsert-group-failed", rows: grp.length, error: res.error.message }));
          for (const one of grp) {
            const r1 = await sb.from("takeuchi_compose_examples").upsert([one], { onConflict: "message_id" });
            if (r1.error) { bump("書けずに飛ばした"); failedIds.push(String(one.message_id)); console.warn(JSON.stringify({ tag: "compose-examples:row-failed", messageId: one.message_id, error: r1.error.message })); }
          }
        }
      }
    }
    // 作り直しの回で、もう例に入らない（画像・申込以降・個人の値・時間切れの残り以外）古い行は消す（古いまま残すと毎回作り直しの対象になる）
    if (!opts.dry && staleIds.length && next === null) {
      const kept = new Set(rows.map((r) => r.message_id));
      const failed = new Set(failedIds);
      const drop = staleIds.filter((id) => !kept.has(id) && !failed.has(id));
      if (drop.length) {
        const d = await sb.from("takeuchi_compose_examples").delete().in("message_id", drop).lt("built_at", COMPOSE_MASK_VER_AT);
        if (d.error) throw new Error(d.error.message);
        stats["作り直しで例から外した"] = drop.length;
      }
    }
    return { ok: true, read: list.length, rows: rows.length, stats, next, embedTokens, dry: !!opts.dry, stale: staleIds.length, failed: failedIds.slice(0, 20) };
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

/** 2026-11-04 統括と連携した検索（⑤）: 問いはお客様の発言と状況のまとめだけ。統括メタは絞り込み（場面・趣旨）と並べ替え（心配の札）にだけ使う */
export async function matchTakeuchiComposeForConductor(o: { customerText: string; situationSummary?: string | null; meta: import("./compose-port").ConductorComposeMeta; purpose?: string | null; conversationId?: string | null; k?: number }): Promise<ComposeExampleHit[]> {
  const sb = serviceClient();
  if (!sb) { console.warn(JSON.stringify({ tag: "compose-rag:no-key" })); return []; }
  try {
    const { composeRagQuery, rerankComposeHits } = await import("./compose-port");
    const { vectors } = await embedTexts([composeRagQuery({ customerText: o.customerText, situationSummary: o.situationSummary })]);
    if (!vectors[0]) return [];
    const k = o.k ?? 3;
    const { data, error } = await sb.rpc("match_takeuchi_compose", {
      query_embedding: `[${vectors[0].join(",")}]`, p_scene: o.meta.scene, p_purpose: o.purpose ?? null, match_count: Math.min(10, k * 3),
      p_exclude_key: o.conversationId ? conversationKey(o.conversationId) : null,
    });
    if (error) { console.warn(JSON.stringify({ tag: "compose-rag:failed", error: error.message })); return []; }
    const hits = (data ?? []) as ComposeExampleHit[];
    if (!hits.length) return [];
    const { data: tags } = await sb.from("takeuchi_compose_examples").select("message_id, hidden_worry, read_beyond").in("message_id", hits.map((h) => h.message_id));
    const tagOf = new Map(((tags ?? []) as Array<{ message_id: string; hidden_worry: string[] | null; read_beyond: string[] | null }>).map((r) => [r.message_id, r]));
    const withTags = hits.map((h) => ({ ...h, hidden_worry: tagOf.get(h.message_id)?.hidden_worry ?? [], read_beyond: tagOf.get(h.message_id)?.read_beyond ?? [] }));
    return rerankComposeHits(withTags, o.meta, k);
  } catch (e) {
    console.warn(JSON.stringify({ tag: "compose-rag:failed", error: e instanceof Error ? e.message : String(e) }));
    return [];
  }
}
