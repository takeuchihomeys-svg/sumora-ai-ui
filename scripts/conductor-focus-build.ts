// scripts/conductor-focus-build.ts — 竹内さんの番の「重点」と、状況の文 v1/v2 の埋め込みを手元に作る（作業員5・11/05・読むだけ・LLM なし・埋め込みだけ）
//
// KB P0 575a7cd5（重点を先に決める）・P1 977cbded（埋め込む形を揃える）・396d3b7f（作業員4の試し）。
//   竹内さん本人の送信（staff_writer=takeuchi・sure・申込の書類の手前まで）から、お客様の発言への一手を番にし、
//   正解の重点（conductor-focus の focusOfTakeuchiTurn）と、v1（今の表と同じ文）・v2（その番の時点の材料を揃えた文）を埋め込んで exam-cache に置く。
//   AIX の種類は line_message_id で取れない時、同じ会話の送信の15分前〜2分後の aix_usage_logs で取る（brain_weaknesses 291）。
//   置き場は .claude/exam-cache/conductor-focus だけ（git に入れない）。伏せ: compose-name-mask＋maskPII（＋URL・電話は maskContactBits）。
//   営業時間（JST 9〜22時）は動かない。費用: text-embedding-3-small 約 200 tokens×2×番 ≒ 1,000番で $0.01 未満。
// 実行: npx tsx --env-file=.env.local scripts/conductor-focus-build.ts [--days=90] [--max=1500]
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestConversation } from "../app/lib/test-conversations";
import { maskPII, maskForEmbedding } from "../app/lib/pii-mask";
import { customerNameTokens, maskCustomerNames } from "../app/lib/compose-name-mask";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { APPLY_DOCS_RE, maskContactBits, turnSituationText } from "../app/lib/conductor-turn-vectors";
import { focusOfTakeuchiTurn, openPromiseAt, turnSituationTextV2, type HistMsg } from "../app/lib/conductor-focus";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const DAYS = Math.min(120, Math.max(7, Number(arg("days", "90"))));
const MAX = Math.min(3000, Math.max(50, Number(arg("max", "1500"))));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const OUT = join(process.cwd(), "..", "..", "exam-cache", "conductor-focus");

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null; staff_writer: string | null; staff_writer_confidence: string | null };
type Aix = { conversation_id: string; created_at: string; aix_type: string; line_message_id: string | null };
const COLS = "id, conversation_id, sender, text, created_at, is_aix_generated, line_message_id, staff_writer, staff_writer_confidence";

async function pageAll<T>(q: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await q(i);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[]; out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function embed(texts: string[]): Promise<number[][]> {
  const key = (process.env.OPENAI_API_KEY ?? "").replace(/^﻿/, "");
  const out: number[][] = [];
  let tokens = 0;
  for (let i = 0; i < texts.length; i += 100) {
    const r = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: texts.slice(i, i + 100).map((t) => maskForEmbedding(t).slice(0, 2000)) }) });
    if (!r.ok) throw new Error(`embeddings ${r.status}`);
    const j = (await r.json()) as { data: Array<{ index: number; embedding: number[] }>; usage?: { total_tokens: number } };
    tokens += j.usage?.total_tokens ?? 0;
    for (const d of j.data.sort((a, b) => a.index - b.index)) out.push(d.embedding);
  }
  console.log(`埋め込み ${texts.length}本・${tokens} tokens・約 $${((tokens / 1e6) * 0.02).toFixed(4)}`);
  return out;
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const sends = (await pageAll<Msg>((i) => sb.from("messages").select(COLS).eq("staff_writer", "takeuchi").eq("staff_writer_confidence", "sure").neq("sender", "customer")
    .gte("created_at", since).order("created_at", { ascending: true }).range(i, i + 999))).filter((m) => !isTestConversation(m.conversation_id)).slice(-MAX * 2);
  console.log(`竹内さんの送信 ${sends.length}`);
  const convIds = [...new Set(sends.map((s) => s.conversation_id))];
  const turns: Array<Record<string, unknown>> = [];
  let skippedApply = 0, aixByLine = 0, aixByTime = 0, aixNone = 0;
  for (let ci = 0; ci < convIds.length; ci += 20) {
    const convs = convIds.slice(ci, ci + 20);
    const sinceC = new Date(Date.parse(since) - 7 * 86_400_000).toISOString();
    const [cv, msgs, aix] = await Promise.all([
      sb.from("conversations").select("id, customer_name, property_customer_id, status").in("id", convs),
      pageAll<Msg>((i) => sb.from("messages").select(COLS).in("conversation_id", convs).gte("created_at", sinceC).order("created_at", { ascending: true }).range(i, i + 999)),
      pageAll<Aix>((i) => sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type, line_message_id").in("conversation_id", convs).gte("created_at", sinceC).order("created_at", { ascending: true }).range(i, i + 999)),
    ]);
    const convOf = new Map(((cv.data ?? []) as Array<{ id: string; customer_name: string | null; property_customer_id: string | null; status: string | null }>).map((c) => [c.id, c]));
    const byLine = new Map(aix.filter((a) => a.line_message_id).map((a) => [a.line_message_id as string, a]));
    const aixOf = (m: Msg): { type: string | null; by: "line" | "time" | null } => {
      if (!m.is_aix_generated) return { type: null, by: null };
      const a = m.line_message_id ? byLine.get(m.line_message_id) : undefined;
      if (a) return { type: a.aix_type, by: "line" };
      const t = Date.parse(m.created_at);
      const near = aix.filter((x) => x.conversation_id === m.conversation_id && Date.parse(x.created_at) >= t - 15 * 60_000 && Date.parse(x.created_at) <= t + 2 * 60_000)
        .sort((x, y) => Math.abs(Date.parse(x.created_at) - t) - Math.abs(Date.parse(y.created_at) - t))[0];
      return near ? { type: near.aix_type, by: "time" } : { type: "aix_unknown", by: null };
    };
    for (const conv of convs) {
      const all = msgs.filter((m) => m.conversation_id === conv);
      const c = convOf.get(conv);
      const tokens = customerNameTokens([c?.customer_name ?? null]);
      const mask = (t: string) => maskContactBits(maskPII(maskCustomerNames(t, tokens)));
      const hist: HistMsg[] = all.map((m) => ({ sender: m.sender, text: mask(m.text ?? ""), created_at: m.created_at, aixType: aixOf(m).type }));
      const seen = new Set<string>();
      for (let k = 0; k < all.length; k++) {
        const s = all[k];
        if (s.sender === "customer" || s.staff_writer !== "takeuchi" || s.staff_writer_confidence !== "sure" || s.created_at < since) continue;
        if (k === 0 || all[k - 1].sender !== "customer") continue; // お客様の発言への一手だけ
        let j = k - 1; while (j >= 0 && all[j].sender === "customer") j--;
        const turnAt = all[j + 1].created_at, key = `${conv}|${turnAt}`;
        if (seen.has(key)) continue; seen.add(key);
        const pv = all.slice(Math.max(0, k - 12), k + 1);
        if (APPLY_DOCS_RE.test(pv.map((m) => m.text ?? "").join("\n"))) { skippedApply++; continue; }
        const custText = all.slice(j + 1, k).map((m) => m.text ?? "").join("\n");
        const before = hist.slice(0, j + 1);
        const ax = aixOf(s);
        if (ax.by === "line") aixByLine++; else if (ax.by === "time") aixByTime++; else if (s.is_aix_generated) aixNone++;
        const route = s.is_aix_generated ? "aix" : "reply";
        const focus = focusOfTakeuchiTurn({ route, aixType: ax.type, text: hist[k].text ?? "", openPromise: !!openPromiseAt(before) });
        const scene = resolveReplyScene({ customerText: custText }).scene;
        const last = [...all.slice(0, j + 1)].reverse().find((m) => m.sender !== "customer" && (m.text ?? "").trim());
        const lastKind = !last ? null : last.is_aix_generated ? `AIX:${aixOf(last).type}` : "返信";
        turns.push({
          id: s.id, conv, pc: c?.property_customer_id ?? null, at: turnAt, scene, route, aix: ax.type, focus,
          v1: turnSituationText({ scene, stage: c?.status ?? null, customerMasked: mask(custText), lastStaffKind: lastKind }),
          v2: turnSituationTextV2({ scene, hist: before, customerMasked: mask(custText), nowMs: Date.parse(turnAt) }),
        });
      }
    }
  }
  turns.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const use = turns.slice(-MAX);
  console.log(`番 ${use.length}（申込の書類で外す ${skippedApply}）・AIX の種類 line ${aixByLine}／時刻 ${aixByTime}／不明 ${aixNone}`);
  const e1 = await embed(use.map((t) => String(t.v1)));
  const e2 = await embed(use.map((t) => String(t.v2)));
  const r = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5);
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `turns-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(use.map((t, i) => ({ ...t, e1: r(e1[i]), e2: r(e2[i]) }))));
  console.log(`書いた ${file}`);
})().catch((e) => { console.error(e); process.exit(1); });
