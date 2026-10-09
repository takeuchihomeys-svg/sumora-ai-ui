// scripts/yuma-memo-dryrun.ts — お客様のメモの DeepSeek 読み取りを、過去の実会話（写し）に DB に書かずに当てる（dry-run）
//   10/08 竹内さん「1週間ではなくテストで試したらよいのでは」。手順書 memory/test_protocol_brain.md どおり:
//   本番の会話は読むだけ・申込の書類の手前で切る（cutBeforeApplicationMaterial）・申込到達より前だけ・名前は「YUMA」・他は maskPII（memoLlmMessages）。
//   LLM は YUMA の写しとして呼ぶ（deepseek-scope=YUMA・記録の conversationId も YUMA）。メモは手元で当てるだけ（customer_memos に書かない）。
//   本番と同じく差分で読む: 会話をお客様の番の区切りで STEPS 回に分けて、前回の水位より後の通だけを渡す。
//   出力: 会話ごとの全行（種類・中身・根拠の言葉）と ⚠（根拠の言葉が渡した通に無い）→ --out の jsonl も
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-memo-dryrun.ts [--n=40] [--days=75] [--steps=3] [--seed=1] [--out=scripts/.replay-out/memo-dryrun.jsonl] [--only=<id頭,..>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { isTestConversation } from "../app/lib/test-conversations";
import { cutBeforeApplicationMaterial } from "../app/lib/test-pii-guard";
import {
  EMPTY_MEMO, MEMO_LLM_SYSTEM, resolveOpSources, applyMemoOps, buildMemoLlmUser, liveItems, memoLlmMessages, parseMemoLlmOutput, MEMO_KIND_JA,
  type MemoMsg, type StoredMemo,
} from "../app/lib/customer-memo";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg("n", "40")); const DAYS = Number(arg("days", "75")); const STEPS = Number(arg("steps", "3")); const SEED = Number(arg("seed", "1"));
const OUT = arg("out", "scripts/.replay-out/memo-dryrun.jsonl"); const ONLY = arg("only", "").split(",").filter(Boolean);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const norm = (s: string) => s.normalize("NFKC").replace(/[\s、。・！!？?「」『』（）()〜~…⏎]/g, "");
const hash = (s: string) => { let h = SEED; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
let h: LlmTestHarness | null = null;

async function main() {
  h = await setupLlmTest("yuma-memo-dryrun");
  const { callDeepSeekRead } = await import("../app/lib/vision-alt-provider");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { recordAltUsage } = await import("../app/lib/llm-usage-recorder");
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  // 候補: 期間内にお客様の発言が15通以上・テスト/グループ以外。申込到達の会話は到達の前まで
  const { data: convs } = await sb.from("conversations").select("id, customer_name, line_source_type, status").order("updated_at", { ascending: false }).limit(1500);
  const outs: Array<{ conversation_id: string; applied_at: string | null }> = [];
  for (let i = 0; ; i += 1000) { const { data } = await sb.from("deal_outcomes").select("conversation_id, applied_at").not("applied_at", "is", null).range(i, i + 999); outs.push(...((data ?? []) as typeof outs)); if ((data ?? []).length < 1000) break; }
  const appliedAt = new Map<string, number>(); for (const o of outs) { const t = Date.parse(o.applied_at!); if (!appliedAt.has(o.conversation_id) || t < appliedAt.get(o.conversation_id)!) appliedAt.set(o.conversation_id, t); }
  const pool = ((convs ?? []) as Array<{ id: string; customer_name: string | null; line_source_type: string | null }>)
    .filter((c) => !isTestConversation(c.id) && c.line_source_type !== "group" && (!ONLY.length || ONLY.some((p) => c.id.startsWith(p))))
    .sort((a, b) => hash(a.id) - hash(b.id));
  const results: Array<Record<string, unknown>> = [];
  let used = 0, totalItems = 0, ungrounded = 0, calls = 0, broken = 0; const droppedAll: string[] = [];
  for (const c of pool) {
    if (used >= N) break;
    const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", c.id).gte("created_at", since).order("created_at").limit(160);
    let msgs = ((ms ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated } as MemoMsg));
    const ap = appliedAt.get(c.id); if (ap) msgs = msgs.filter((m) => Date.parse(m.createdAt) < ap);
    msgs = cutBeforeApplicationMaterial(msgs).kept;
    if (msgs.filter((m) => m.sender === "customer").length < 15) continue;
    // 名前は YUMA に（表示名・本文中の呼び名）
    const name = (c.customer_name ?? "").trim();
    const rename = (t: string | null | undefined) => (name && name.length >= 2 ? String(t ?? "").split(name).join("YUMA") : String(t ?? ""));
    msgs = msgs.map((m) => ({ ...m, text: rename(m.text) }));
    try { h.assertSceneSafe(msgs.map((m) => m.text), `memo-${c.id.slice(0, 6)}`); } catch (e) { console.log(`  飛ばす ${c.id.slice(0, 6)}: ${e instanceof Error ? e.message.slice(0, 80) : e}`); continue; }
    used++;
    // お客様の番の区切りで STEPS 回に分ける
    const custIdx = msgs.map((m, i) => (m.sender === "customer" && (i === 0 || msgs[i - 1].sender !== "customer") ? i : -1)).filter((i) => i >= 0);
    const cuts = Array.from({ length: STEPS }, (_, k) => k === STEPS - 1 ? msgs.length : custIdx[Math.floor(((k + 1) * custIdx.length) / STEPS)] ?? msgs.length);
    let memo: StoredMemo = { ...EMPTY_MEMO, items: [], hiddenRuleIds: [] };
    let from = 0; const sentAll: MemoMsg[] = []; let seq = 0;
    for (const to of cuts) {
      const part = msgs.slice(from, to).slice(-30); from = to;
      if (!part.some((m) => m.sender === "customer")) continue;
      const send = memoLlmMessages(part, ["YUMA"]);
      sentAll.push(...send);
      const nowMs = Date.parse(part[part.length - 1].createdAt) + 60_000;
      const user = buildMemoLlmUser({ memo, nowMs, msgs: send });
      h.assertYuma(YUMA, "memo");
      const read = await runInDeepseekScope(async () => { setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } }); return callDeepSeekRead(MEMO_LLM_SYSTEM, user, { maxTokens: 900, timeoutMs: 40_000 }, (t) => parseMemoLlmOutput(t)); });
      for (const a of read.attempts) {
        calls++;
        recordAltUsage({ model: a.res?.model ?? "deepseek-flash", action: "customer_memo", conversationId: YUMA, usage: { input_tokens: Math.max(0, (a.res?.usage.input ?? 0) - (a.res?.usage.cacheHit ?? 0)), output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 }, status: a.res ? 200 : 0, errorType: a.ok ? null : "empty_or_unparsable", durationMs: a.ms, sysHead: "【お客様のメモ・dry-run】", sysKeyFull: null, maxTokens: 900 });
      }
      if (!read.value) { broken++; continue; }
      const resolved = resolveOpSources(read.value, send);
      for (const d of resolved.dropped) { droppedAll.push(`${c.id.slice(0, 6)} ${d.why}: ${d.op.op === "retire" ? "" : `${d.op.op === "add" ? d.op.kind : "update"} ${d.op.text}「${d.op.quote ?? ""}」`}`); }
      memo = applyMemoOps(memo, resolved.ops, { origin: "llm", nowIso: new Date(nowMs).toISOString(), newId: () => `l-${++seq}` }).memo;
    }
    const corpus = norm(sentAll.map((m) => m.text ?? "").join("\n"));
    const nowEnd = Date.parse(msgs[msgs.length - 1].createdAt) + 60_000;
    const items = liveItems(memo, nowEnd);
    console.log(`\n## ${c.id.slice(0, 8)}（通 ${msgs.length}・お客様の番 ${custIdx.length}・${msgs[0].createdAt.slice(5, 10)}〜${msgs[msgs.length - 1].createdAt.slice(5, 10)}）`);
    const rows = items.map((x) => {
      const q = norm(x.sourceQuote ?? "");
      const ok = !q || corpus.includes(q.slice(0, Math.min(16, q.length)));
      totalItems++; if (!ok) ungrounded++;
      console.log(`  ${ok ? " " : "⚠"} ${MEMO_KIND_JA[x.kind]}: ${x.text}${x.property ? `（${x.property}）` : ""}${x.certainty === "maybe" ? "（たぶん）" : ""} ＝${(x.sourceAt ?? "").slice(5, 16)}「${x.sourceQuote ?? ""}」${x.expiresAt ? ` 〜${x.expiresAt.slice(5, 10)}` : ""}`);
      return { kind: x.kind, text: x.text, quote: x.sourceQuote, at: x.sourceAt, by: x.sourceBy, certainty: x.certainty, expires: x.expiresAt, grounded: ok };
    });
    const retired = memo.items.filter((x) => x.retiredAt).map((x) => ({ kind: x.kind, text: x.text, reason: x.retiredReason }));
    if (retired.length) console.log(`  （外した ${retired.length}: ${retired.map((r) => `${r.text}＝${r.reason}`).join("／").slice(0, 200)}）`);
    results.push({ conv: c.id.slice(0, 8), msgs: msgs.length, items: rows, retired });
  }
  console.log(`
== 線で落とした op ${droppedAll.length}`); for (const d of droppedAll) console.log("  " + d.slice(0, 160));
  writeFileSync(OUT, results.map((r) => JSON.stringify(r)).join("\n"));
  console.log(`\n== 会話 ${used}・行 ${totalItems}・⚠ 根拠の言葉が渡した通に無い ${ungrounded}・読み取り ${calls}回（崩れ ${broken}）→ ${OUT}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
