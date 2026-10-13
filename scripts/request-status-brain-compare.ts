// scripts/request-status-brain-compare.ts — 確認事項の「済み／まだ」をブレイン（request_status）と決定論の網（旧 v1・今 v2）で比べる
//   2026-10-13 竹内さんの決定（P0 9eb6aa9c「判断はすべてブレイン基準」）④: 入れる前に直近30日の会話で「ブレインの判断」と「今の決定論」を比べ、
//   竹内さん（スタッフ）の実際の対応に合う方を数える。試しは DeepSeek・テスト専用の会話（--conv=auto）。
//   手順書: memory/test_protocol_brain.md（入口 setupLlmTest・YUMA2〜・本番の会話は読むだけ・書類の手前で切る・名前を伏せる・自分の行だけ消す）
//
//   1会話＝その会話の最後のお客様の番の時点（そこまでの会話・14日）をテスト専用の会話に写し、ブレインを1回（全体の分析・DeepSeek）。
//   出す物: 候補ごとに 網v1／網v2／ブレイン の状態と、その後のこちらの送信（目で読んで「実際の対応」を決める）＝ scripts/.replay-out/request-status-compare-<label>.jsonl
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/request-status-brain-compare.ts --conv=auto --label=rs1 [--n=12] [--days=30] [--only=<会話id8,...>]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
import { acquireTestConversation, type TestConvLease } from "./lib/test-conv-lease";
import { maskExamText } from "./lib/brain-exam-mask";
import { isTestConversation } from "../app/lib/test-conversations";
import { buildRequestLedger, requestKey, TOPIC_JA, type LedgerMsg, type LedgerItem } from "../app/lib/request-ledger";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const LABEL = arg("label", "rs1"), N = Number(arg("n", "12")), DAYS = Number(arg("days", "30"));
const ONLY = arg("only").split(",").filter(Boolean);
const PREFIX = "rscmp-";
const OUT = `scripts/.replay-out/request-status-compare-${LABEL}.jsonl`;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type M = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
const POST_APPLY = new Set(["applying", "application", "screening", "contract", "contracted", "lost"]);
const one = (s: string | null | undefined, n: number) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const toLm = (ms: ReadonlyArray<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>): LedgerMsg[] => ms.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }));
function netBoth(lm: LedgerMsg[], now: number): { v1: LedgerItem[]; v2: LedgerItem[] } {
  process.env.REQUEST_LEDGER_COVER_V2 = "off"; const v1 = buildRequestLedger(lm, now);
  delete process.env.REQUEST_LEDGER_COVER_V2; const v2 = buildRequestLedger(lm, now);
  return { v1, v2 };
}

let h: LlmTestHarness | null = null; let lease: TestConvLease | null = null; let own: string[] = []; let floorPath = "";
async function main() {
  lease = acquireTestConversation(arg("conv", "auto"), `request-status-${LABEL}`);
  const CONV = lease.id;
  floorPath = `scripts/.replay-out/request-status-floor-${LABEL}-${lease.tag}.json`;
  process.env.REPLAY_FLOOR_FILE = floorPath; // supabase を読む前（brain-core の import 前）に要る
  writeFileSync(floorPath, "{}");
  mkdirSync("scripts/.replay-out", { recursive: true });
  // ── 本番の会話を読む（読むだけ）
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: M[] = [];
  for (let i = 0; i < 400_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message); msgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const { data: convs } = await sb.from("conversations").select("id, customer_name, status").in("id", [...by.keys()].slice(0, 1000));
  const convInfo = new Map(((convs ?? []) as Array<{ id: string; customer_name: string | null; status: string | null }>).map((c) => [c.id, c]));
  // ── 試す会話を選ぶ（最後のお客様の番の時点で、こちらの送信の後の候補がある会話・網の v1/v2 が分かれる・まだが残る会話を先に）
  type Sample = { cid: string; ctx: M[]; score: number };
  const samples: Sample[] = [];
  for (const [cid, list] of by) {
    if (ONLY.length && !ONLY.some((p) => cid.startsWith(p))) continue;
    const ci = convInfo.get(cid); if (!ci || POST_APPLY.has(String(ci.status ?? ""))) continue;
    let end = list.length - 1; while (end >= 0 && list[end].sender !== "customer") end--;
    if (end < 0) continue;
    const snapAt = Date.parse(list[end].created_at);
    let ctx = list.slice(0, end + 1).filter((m) => snapAt - Date.parse(m.created_at) <= 14 * 86_400_000).slice(-60);
    if (!h) h = await setupLlmTest(`request-status-${LABEL}`.slice(0, 60));
    const cut = h.cutBeforeApplicationMaterial(ctx); ctx = cut.kept;
    if (ctx.length < 4 || ctx[ctx.length - 1].sender !== "customer") continue;
    const { v1, v2 } = netBoth(toLm(ctx), snapAt + 1000);
    const answeredWindow = v2.filter((x) => ctx.some((m) => m.sender !== "customer" && Date.parse(m.created_at) > Date.parse(x.saidAt)));
    if (!answeredWindow.length) continue;
    const differ = v1.filter((x, k) => v2[k] && x.status !== v2[k].status).length;
    const notDone = answeredWindow.filter((x) => x.status !== "done").length;
    samples.push({ cid, ctx, score: differ * 3 + notDone * 2 + Math.min(answeredWindow.length, 4) });
  }
  samples.sort((a, b) => b.score - a.score);
  const pick = samples.slice(0, N);
  if (!h) h = await setupLlmTest(`request-status-${LABEL}`.slice(0, 60));
  console.log(`テストの会話: ${lease.name}（${CONV}）・候補の会話 ${samples.length} から ${pick.length}・model ${h.run}`);
  const analyzeConversation = (await import("../app/lib/brain-core")).analyzeConversation;
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  if (!existsSync(OUT)) writeFileSync(OUT, "");
  for (const s of pick) {
    const name = convInfo.get(s.cid)?.customer_name ?? null;
    const staffNames: string[] = [];
    const texts = s.ctx.map((m) => maskExamText(m.text, name, staffNames) || "[画像]");
    try {
      h.assertSceneSafe(texts, s.cid.slice(0, 8));
    } catch (e) { console.warn(`  飛ばす ${s.cid.slice(0, 8)}: ${e instanceof Error ? e.message.split("\n")[0] : e}`); continue; }
    await h.waitUntilYumaQuiet(own, { maxWaitMin: 30, conversationId: CONV });
    // 元の間隔を保って未来の時刻へずらす（最後の通＝今＋2分）
    const shift = Date.now() + 120_000 - Date.parse(s.ctx[s.ctx.length - 1].created_at);
    const times = s.ctx.map((m) => new Date(Date.parse(m.created_at) + shift).toISOString());
    const row: Record<string, unknown> = { label: LABEL, conv: s.cid.slice(0, 8), at: new Date().toISOString() };
    try {
      writeFileSync(floorPath, JSON.stringify({ conversationId: CONV, floor: new Date(Date.parse(times[0]) - 1000).toISOString(), status: "proposing", messageIdPrefix: PREFIX, keepPropertyCustomer: true }));
      h.assertTestConversation(CONV, "brain");
      const ins = await sb.from("messages").insert(s.ctx.map((m, k) => ({ conversation_id: CONV, sender: m.sender, text: texts[k], is_aix_generated: !!m.is_aix_generated, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[k] }))).select("id");
      if (ins.error) throw new Error(ins.error.message);
      own = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
      await new Promise((r) => setTimeout(r, 1300));
      const copy = s.ctx.map((m, k) => ({ ...m, text: texts[k], created_at: times[k] }));
      const lm = toLm(copy);
      const { v1, v2 } = netBoth(lm, Date.now() + 200_000);
      const meta = await runInDeepseekScope(async () => {
        setDeepseekScope({ conversationId: CONV, mark: { kind: "all" } });
        return analyzeConversation(CONV, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null } as never);
      }) as unknown as Record<string, unknown> | null;
      const rs = (meta?.request_status ?? null) as { items: Array<{ key: string; status: string; via: string | null }> } | null;
      const bmap = new Map((rs?.items ?? []).map((x) => [x.key, x]));
      row.items = v2.map((x, k) => {
        const after = copy.filter((m) => m.sender !== "customer" && Date.parse(m.created_at) > Date.parse(x.saidAt)).slice(0, 3).map((m) => `${m.is_aix_generated ? "AIX" : "手"}: ${one(m.text, 140)}`);
        const b = bmap.get(requestKey(x));
        return { topic: TOPIC_JA[x.topic], quote: x.quote, v1: v1[k]?.status ?? null, v2: x.status, brain: b ? `${b.status}${b.via ? `・${b.via}` : ""}` : "（判断なし）", after };
      });
      row.brainItems = rs?.items.length ?? 0; row.candidates = v2.length;
      console.log(`\n■ ${s.cid.slice(0, 8)}（候補 ${v2.length}・ブレインの判断 ${rs?.items.length ?? 0}）`);
      for (const it of row.items as Array<{ topic: string; quote: string; v1: string; v2: string; brain: string; after: string[] }>) {
        console.log(`  [${it.topic}]「${one(it.quote, 50)}」 網v1=${it.v1} 網v2=${it.v2} ブレイン=${it.brain}`);
        for (const a of it.after) console.log(`      ${a}`);
      }
    } catch (e) { row.error = e instanceof Error ? e.message : String(e); console.warn(`  失敗 ${s.cid.slice(0, 8)}: ${row.error}`); }
    finally {
      writeFileSync(floorPath, "{}");
      if (own.length) { const del = await sb.from("messages").delete().in("id", own); if (del.error) console.error(`⛔ 自分の行を消せない: ${del.error.message}`); own = []; }
      appendFileSync(OUT, JSON.stringify(row) + "\n");
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(async () => {
  if (floorPath) writeFileSync(floorPath, "{}");
  if (own.length) await sb.from("messages").delete().in("id", own);
  lease?.release();
  if (h) await h.finish();
  setTimeout(() => process.exit(process.exitCode ?? 0), 800);
});
