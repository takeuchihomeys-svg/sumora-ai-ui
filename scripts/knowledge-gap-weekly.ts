// scripts/knowledge-gap-weekly.ts — 知識の穴の自動の拾い出し（毎週）。竹内さん 10/29「知識弱い部分も見つけ出していく」（KB P1）
//
// 2026-10-29 作業員5。本番の見張り（line_watch_turns）の直近 N 日で、下書きが「確認します」「分かりかねます」とぼかした番のうち、
//   同じ番の実送信が約束せずに具体の事実で答えた番を拾い、DeepSeek で知識の候補（会社の事実・手続き・一般・物件の記録）を1件1行で取り出す。
//   スタッフだけが知る事（管理会社の答え・募集状況・交渉・日程）は知識の穴に数えない（AIX の番）。分け方は app/lib/knowledge-gap.ts。
//   根拠の送信が竹内さんの手（messages.staff_writer=takeuchi）の候補は「入れてよい候補」（根拠の送信の id 付き）、それ以外は「竹内さんに聞く ○×」。
//   出力: 件数・上位10件（実例付き）・○× の質問案（Markdown）＋ 作業員1の毎週の原因の表（scripts/line-watch-miss-causes.ts）に章として読み込める JSON（GapChapter）。
//   書き込み: --kb の時だけ設計知見（system_design_thinking）に1行（scripts/kb-insert.ts）。会社の事実のコードには書かない（統括に候補を見せてから）。
//   LLM: DeepSeek だけ（8番ずつ・30日で 15〜20回・数セント）。お客様の名前・番号は伏せて渡す（maskPII）。
//
//   --with-lines: 網③ 外れの番で、実送信だけにある事実の1文（〜となります・〜可能です・〜手配させて頂きます）がある番（作業員1の 7683・5508・5964・8466 の形）
//   --with-ab: 作業員1の原因の表の「要読む A/B」（下書きに無い事実がスタッフの文にある番・ぼかしていない）も網に足す（net=missing）
// 実行: npx tsx --env-file=.env.local scripts/knowledge-gap-weekly.ts [--days=30] [--batch=8] [--limit=N] [--out=<dir>] [--no-llm] [--with-ab] [--kb]
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  isGapTurn, answeringStaffTexts, knownFactOf, gapStatus, staffOnlyFactLines, gapExtractPrompt, parseGapExtract, groupGapCandidates, gapChapterMarkdown, GAP_EXTRACT_SYSTEM, KNOWLEDGE_KINDS,
  type GapTurnRow, type GapExtract, type GapEvidence, type GapChapter, type GapChapterRow, type GapKind,
} from "../app/lib/knowledge-gap";
import { maskPII } from "../app/lib/pii-mask";
import { classifyMiss, isTextMiss, type MissRow } from "../app/lib/line-watch-miss-cause";
import { COMPANY_FACTS } from "../app/lib/company-facts";
import { PROCEDURE_FACTS } from "../app/lib/procedure-question";
import { callDeepSeek } from "../app/lib/vision-alt-provider";
import { altPriceOf } from "../app/lib/llm-price";
import { flushLlmUsage, recordAltUsage, setScriptRouteLabel } from "../app/lib/llm-usage-recorder";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const arg = (f: string, d = "") => argv.find((a) => a.startsWith(`--${f}=`))?.slice(f.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const BATCH = Number(arg("batch", "8"));
const LIMIT = Number(arg("limit", "0"));
const OUT = arg("out", join(process.env.TEMP ?? ".", "knowledge-gap"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

const YUMA_LIKE = /^(?:dd34f5b0|a7ac4c90)/; // テスト用の会話は数えない（YUMA・YUMA5 ほか下で名前でも外す）

type TurnRow = GapTurnRow & { customer_last_at: string | null; verdict: string | null; verdict_detail: Record<string, unknown> | null; draft_last: string | null };
async function fetchTurns(): Promise<TurnRow[]> {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const out: TurnRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("line_watch_turns")
      .select("id, conversation_id, customer_turn_at, customer_last_at, scene_key, draft_first, draft_last, staff_texts, staff_aix, verdict, verdict_detail")
      .gte("customer_turn_at", since).order("customer_turn_at", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(`line_watch_turns: ${error.message}`);
    out.push(...((data ?? []) as TurnRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

type Msg = { id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null };
async function messagesOf(convId: string, fromIso: string, toIso: string): Promise<Msg[]> {
  const { data } = await sb.from("messages").select("id, sender, text, created_at, staff_writer")
    .eq("conversation_id", convId).gte("created_at", fromIso).lte("created_at", toIso).order("created_at", { ascending: true }).limit(60);
  return (data ?? []) as Msg[];
}

async function main() {
  setScriptRouteLabel("script:knowledge-gap-weekly");
  const turns = await fetchTurns();
  const convIds = [...new Set(turns.map((t) => t.conversation_id))];
  const names = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, customer_name").in("id", convIds.slice(i, i + 200));
    for (const r of data ?? []) names.set(String(r.id), String(r.customer_name ?? ""));
  }
  const isTest = (id: string) => YUMA_LIKE.test(id) || /^YUMA\d?$/i.test(names.get(id) ?? "");
  const live = turns.filter((t) => !isTest(t.conversation_id));
  const vague = live.filter((t) => /確認|分かりかね|わかりかね|お調べ/.test(t.draft_first ?? "") && (t.draft_first ?? "").length > 0);
  const netOf = (t: TurnRow): "vague" | "missing" | "line" | null => {
    if (isGapTurn(t)) return "vague";
    if (has("with-ab") && isTextMiss(t) && classifyMiss(t as unknown as MissRow).cause === "要読む:A/B" && answeringStaffTexts(t).length) return "missing";
    // 網③: 実送信だけにある事実の1文（下書きがぼかしていない番も・外れの番だけ）
    if (has("with-lines") && isTextMiss(t) && answeringStaffTexts(t).some((x) => staffOnlyFactLines(t.draft_last ?? t.draft_first, x.text).length)) return "line";
    return null;
  };
  const nets = new Map(live.map((t) => [t.id, netOf(t)]));
  let picked = live.filter((t) => nets.get(t.id));
  if (LIMIT) picked = picked.slice(0, LIMIT);
  console.log(`直近 ${DAYS} 日: 返信の番 ${live.length}（テスト会話を除く）・下書きに確認／分かりかね ${vague.length}・拾った番 ${picked.length}（ぼかし ${picked.filter((t) => nets.get(t.id) === "vague").length}${has("with-ab") ? `・抜け A/B ${picked.filter((t) => nets.get(t.id) === "missing").length}` : ""}${has("with-lines") ? `・実送信だけの事実の文 ${picked.filter((t) => nets.get(t.id) === "line").length}` : ""}）`);

  // 材料（お客様の発言・実送信の id と書き手）
  type Item = { turn: typeof picked[number]; customer: string; staff: string; staffMsgId: string | null; writer: string | null; aixSent: string[] };
  const items: Item[] = [];
  for (const t of picked) {
    const ans = answeringStaffTexts(t);
    const lastAt = ans.map((s) => s.at ?? "").filter(Boolean).sort().pop() ?? t.customer_last_at ?? t.customer_turn_at;
    const msgs = await messagesOf(t.conversation_id, new Date(Date.parse(t.customer_turn_at) - 2000).toISOString(), new Date(Date.parse(lastAt) + 5000).toISOString());
    const customer = msgs.filter((m) => m.sender === "customer" && Date.parse(m.created_at) <= Date.parse(t.customer_last_at ?? t.customer_turn_at) + 2000).map((m) => m.text ?? "").join("\n");
    const staffMsgs = msgs.filter((m) => m.sender === "staff");
    // 根拠の送信: 答えた通と時刻（±3秒）か本文の頭で合う staff の通
    const first = ans[0];
    const hit = staffMsgs.find((m) => first.at && Math.abs(Date.parse(m.created_at) - Date.parse(first.at)) <= 3000)
      ?? staffMsgs.find((m) => (m.text ?? "").slice(0, 20) === first.text.slice(0, 20)) ?? null;
    const writers = ans.map((s) => staffMsgs.find((m) => s.at && Math.abs(Date.parse(m.created_at) - Date.parse(s.at)) <= 3000)?.staff_writer ?? null);
    const tkIdx = writers.findIndex((w) => w === "takeuchi");
    const evMsg = tkIdx >= 0 ? staffMsgs.find((m) => ans[tkIdx].at && Math.abs(Date.parse(m.created_at) - Date.parse(ans[tkIdx].at!)) <= 3000) ?? hit : hit;
    items.push({
      turn: t, customer, staff: ans.map((s) => s.text).join("\n---\n"),
      staffMsgId: evMsg?.id ?? null, writer: tkIdx >= 0 ? "takeuchi" : (hit?.staff_writer ?? writers.find(Boolean) ?? null),
      aixSent: (t.staff_aix ?? []).map((a) => String(a.aix_type ?? "")).filter(Boolean),
    });
  }

  // DeepSeek で知識の候補を取り出す（8番ずつ）
  const extracts = new Map<number, GapExtract>();
  const usage = { calls: 0, failed: 0, input: 0, cacheHit: 0, output: 0, usd: 0, model: "" };
  if (!has("no-llm")) {
    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH);
      const prompt = gapExtractPrompt(chunk.map((x, k) => {
        const nm = [names.get(x.turn.conversation_id) ?? null];
        return { n: k + 1, customer: maskPII(x.customer, nm), draft: maskPII(x.turn.draft_first ?? "", nm), staff: maskPII(x.staff, nm), aixSent: x.aixSent };
      }));
      const t0 = Date.now();
      usage.calls++;
      const maxTokens = 120 + chunk.length * 110;
      const res = await callDeepSeek(GAP_EXTRACT_SYSTEM, prompt, { thinking: false, temperature: 0, maxTokens, timeoutMs: 90_000 });
      if (res) {
        usage.model = res.model;
        usage.input += res.usage.input; usage.cacheHit += res.usage.cacheHit; usage.output += res.usage.output;
        recordAltUsage({ model: res.model, action: "knowledge-gap", conversationId: null, usage: { input_tokens: res.usage.cacheMiss, cache_read_input_tokens: res.usage.cacheHit, output_tokens: res.usage.output }, status: 200, errorType: null, durationMs: Date.now() - t0, sysHead: GAP_EXTRACT_SYSTEM, sysKeyFull: null, maxTokens });
      }
      const parsed = res ? parseGapExtract(res.text) : new Map<number, GapExtract>();
      chunk.forEach((x, k) => { const v = parsed.get(k + 1); if (v) extracts.set(x.turn.id, v); else usage.failed++; });
      process.stdout.write(`\r  DeepSeek ${Math.min(i + BATCH, items.length)}/${items.length}`);
    }
    console.log("");
    const price = altPriceOf(usage.model || "deepseek");
    if (price) usage.usd = ((usage.input - usage.cacheHit) * price.in + usage.cacheHit * price.read + usage.output * price.out) / 1e6;
  }

  const evOf = (x: Item): GapEvidence => ({
    turnId: x.turn.id, conversationId: x.turn.conversation_id, at: x.turn.customer_turn_at, scene: x.turn.scene_key,
    draftHead: (x.turn.draft_first ?? "").replace(/\s+/g, " ").slice(0, 120), staffHead: x.staff.replace(/\s+/g, " ").slice(0, 200), staffMsgId: x.staffMsgId, writer: x.writer,
  });
  const byKind: Record<string, number> = {};
  const rows: GapChapterRow[] = [];
  const pairs: Array<{ ex: GapExtract; ev: GapEvidence }> = [];
  for (const x of items) {
    const ex = extracts.get(x.turn.id);
    const kind: GapKind = ex?.kind ?? "none";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const ev = evOf(x);
    rows.push({ turnId: x.turn.id, scene: x.turn.scene_key, draftHead: ev.draftHead.slice(0, 60), staffHead: ev.staffHead.slice(0, 80), kind, candidate: ex?.fact ?? "", building: ex?.building ?? null, backed: x.writer === "takeuchi", staffMsgId: x.staffMsgId });
    if (ex) pairs.push({ ex, ev });
  }
  const candidates = groupGapCandidates(pairs);
  // 既にある事実（会社の事実・手続きの事実）に当たる候補は「届かなかった」に分ける（知識の穴ではない）
  const known = [...COMPANY_FACTS.map((k) => ({ id: k.id, fact: k.fact })), ...knownProcedureFacts()];
  for (const c of candidates) if (c.kind !== "property") c.knownFactId = knownFactOf(c.fact, known);
  const chapter: GapChapter = {
    generatedAt: new Date().toISOString(), days: DAYS,
    counts: { turns: live.length, vague: vague.length, picked: items.length, byKind, knowledge: candidates.length, backed: candidates.filter((c) => gapStatus(c) === "backed").length, ask: candidates.filter((c) => gapStatus(c) === "ask").length, known: candidates.filter((c) => gapStatus(c) === "known").length, property: candidates.filter((c) => gapStatus(c) === "property").length },
    candidates, rows,
  };
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(join(OUT, `knowledge-gap-${stamp}.json`), JSON.stringify(chapter, null, 1));
  const md = gapChapterMarkdown(chapter);
  writeFileSync(join(OUT, `knowledge-gap-${stamp}.md`), md);
  console.log(`\n${md}\n`);
  console.log(`知識の番 ${rows.filter((r) => KNOWLEDGE_KINDS.has(r.kind)).length}／スタッフだけが知る事 ${byKind.staff_only ?? 0}／事実でない ${byKind.none ?? 0}`);
  if (!has("no-llm")) console.log(`DeepSeek ${usage.calls}回（答えなし ${usage.failed}番）・入力 ${usage.input}（キャッシュ ${usage.cacheHit}）・出力 ${usage.output}・約 $${usage.usd.toFixed(4)}・${usage.model}`);
  console.log(`出力: ${join(OUT, `knowledge-gap-${stamp}.json`)}（作業員1の表の章は GapChapter をそのまま読む）`);

  // 設計知見に1行（--kb の時だけ・事例＝P3）
  if (has("kb") && candidates.length) {
    const top = candidates.slice(0, 10).map((c, i) => `${i + 1}) [${c.kind}${c.building ? `・${c.building}` : ""}] ${c.fact}（${c.evidence.length}番・${c.backedByTakeuchi ? `裏取り ${c.evidence.find((e) => e.writer === "takeuchi")?.staffMsgId ?? ""}` : "要 ○×"}）`).join(" ");
    const kb = {
      title: `知識の穴の候補 ${stamp}（直近${DAYS}日・下書きがぼかし実送信が答えた番）`,
      category: "ai_design",
      insight: `拾った番 ${items.length}（会社の事実 ${byKind.company ?? 0}・手続き ${byKind.procedure ?? 0}・一般 ${byKind.general ?? 0}・物件の記録 ${byKind.property ?? 0}・スタッフだけ ${byKind.staff_only ?? 0}）。候補 ${candidates.length}（入れてよい ${chapter.counts.backed}・○× ${chapter.counts.ask}）。上位: ${top}`,
      rationale: "竹内さん 10/29「知識弱い部分も見つけ出していく」。外れの3つのうち『材料が AI に届いていない』の知識の側を毎週数える。会社の事実のコードへの反映は統括が候補を見てから",
      context: `scripts/knowledge-gap-weekly.ts の毎週の出力（${stamp}）`,
      applied_to: "scripts/knowledge-gap-weekly.ts, app/lib/knowledge-gap.ts",
      tags: ["知識の穴", "line-watch", "会社の事実"],
      priority: 3,
    };
    const f = join(OUT, `knowledge-gap-${stamp}.kb.json`);
    writeFileSync(f, JSON.stringify(kb));
    // 環境変数はこの実行のまま渡す（--env-file は付けない）
    const r = spawnSync("npx", ["tsx", "scripts/kb-insert.ts", f], { stdio: "inherit", env: process.env, shell: true });
    console.log(`設計知見に登録: ${r.status === 0 ? "済み" : `失敗（${r.status}）`}`);
  }
  await flushLlmUsage();
}
main().catch((e) => { console.error(e); process.exit(1); });
function knownProcedureFacts(): Array<{ id: string; fact: string }> {
  return Object.entries(PROCEDURE_FACTS).map(([k, v]) => ({ id: `procedure:${k}`, fact: String(v) }));
}
