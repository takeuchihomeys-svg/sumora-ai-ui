// scripts/yuma-aix-brain-link-test.ts — AIX の文の生成にブレインの判断が届いた時の前後を、本番の場面×竹内さんの実送信で比べる
//
// 2026-10-13 竹内「AIX テンプレートで文が生成される所の文の質が今悪い…実際に竹内が送っているのと比べてずれている部分や、ちゃんと届いていない部分を改善」
//   番: scripts/audit-r9s2-aix-cases.ts が本番から作る（竹内さんが送った AIX の通が正解・会話は申込の書類の手前で切り名前は YUMA・伏せ済み）。
//   1番ごとに: テスト専用の会話（YUMA2〜5・LINE なし・--conv=auto で鍵を取る）に場面の会話を入れる（線＝REPLAY_FLOOR_FILE で過去の行を読まない）
//     → ブレインを1回回す（その番の判断＝turn_contract・お客様の状態）→ 同じ判断を本文 testBrainMeta で渡して AIX の文を 前（--toggle=off）／後（on）で作る
//     → 自分が入れた行（messages・aix_generate_log）だけ id で消す。
//   出力は scripts/.replay-out/r11-aix-<label>.jsonl（scripts/audit-r11-aix-score.ts --labels=<label> --cases=<番のファイル> で採点できる形）＋ <label>.brain.jsonl（判断）
//   手順書 memory/test_protocol_brain.md どおり（共通の入口・試行錯誤は DeepSeek・最後の Claude は種類ごとに1〜2回・テスト専用の会話だけ）。
// 実行:
//   NODE_OPTIONS=--require=<als.cjs> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-aix-brain-link-test.ts --label=link1 --cases=scripts/.replay-out/aixlink-cases.json --actions=viewing_invite,property_send,rec-template [--per=10] [--conv=auto] [--toggle=AIX_BRAIN_CONTRACT]
import { AsyncLocalStorage } from "node:async_hooks";
// next の after()/workAsyncStorage が読む前に置く（--require の .cjs の代わり）
(globalThis as unknown as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
import { acquireTestConversation, type TestConvLease } from "./lib/test-conv-lease";
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { shiftDaysFor } from "./lib/scenario-date-shift";
import { shiftExamText } from "./lib/brain-exam-dates";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const LABEL = arg("label", "link");
const PER = Number(arg("per", "99"));
const ACTIONS = arg("actions", "").split(",").filter(Boolean);
const IDS = arg("ids", "").split(",").filter(Boolean);
const CASES = arg("cases", "scripts/.replay-out/aixlink-cases.json").split(",");
const TOGGLE = arg("toggle", "AIX_BRAIN_CONTRACT");
const CONV_ARG = arg("conv", "auto");
const REPS = Math.max(1, Number(arg("reps", "2")));
const OUT_DIR = "scripts/.replay-out";
const PREFIX = `aixlink-${LABEL}-`;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type Msg = { sender: string; text: string; createdAt?: string; rawCreatedAt?: string; isAix?: boolean; imageUrl?: string };
type Case = { id: string; action: string; route: "aix/action" | "aix-template-generate"; body: Record<string, unknown>; sent: string; inputText: string };
let h: LlmTestHarness | null = null;
let lease: TestConvLease | null = null;
let own: string[] = [];
let floorFile = "";
const writeFloor = (conv: string, floor: string | null) => writeFileSync(floorFile, floor ? JSON.stringify({ conversationId: conv, floor }) : "");

async function main() {
  lease = acquireTestConversation(CONV_ARG, `aixlink-${LABEL}`);
  const CONV = lease.id;
  if (lease.isYuma) throw new Error("この試しはテスト専用の会話（YUMA2〜5）で回す（--conv=auto）");
  floorFile = `${OUT_DIR}/aixlink-floor-${LABEL}-${lease.tag}.json`;
  process.env.REPLAY_FLOOR_FILE = floorFile; // supabase の読み込みより前に
  writeFloor(CONV, null);
  h = await setupLlmTest(`yuma-aix-brain-link-${LABEL}`.slice(0, 60));
  h.assertTestConversation(CONV, "ブレイン・AIX");
  (globalThis as unknown as Record<string, unknown>).AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const analyzeConversation = (await import("../app/lib/brain-core")).analyzeConversation;
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { extractStrategy } = await import("../app/lib/brain-layers");
  const { POST: aixPost } = await import("../app/api/aix/action/route");
  const { POST: tplPost } = await import("../app/api/aix-template-generate/route");
  const { buildAixContractNote } = await import("../app/lib/aix-brain-contract");

  const all: Case[] = CASES.filter((f) => existsSync(f)).flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as { cases: Case[] }).cases);
  const keyOf = (c: Case) => c.route === "aix-template-generate" ? "rec-template" : c.action;
  const per: Record<string, number> = {};
  const list = all.filter((c) => {
    const k = keyOf(c);
    if (ACTIONS.length && !ACTIONS.includes(k)) return false;
    if (IDS.length && !IDS.includes(c.id)) return false;
    per[k] = (per[k] ?? 0) + 1; return per[k] <= PER;
  });
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/r11-aix-${LABEL}.jsonl`, brainFile = `${OUT_DIR}/r11-aix-${LABEL}.brain.jsonl`;
  writeFileSync(outFile, ""); writeFileSync(brainFile, "");
  console.log(`=== ${list.length}番 × before/after label=${LABEL} 会話=${lease.name} mode=${process.env.LLM_TEST_MODE ?? (process.env.LLM_TEST_FINAL_CLAUDE ? "final-claude" : "-")} ===`);
  const store = { afterContext: { after: () => {} }, route: "/api/aix/action", isStaticGeneration: false } as never;

  let n = 0;
  // 場面の日付を今日以降にずらす（brain-exam と同じ・7日の倍数＝曜日はそのまま）。正解（竹内さんの送信）も同じだけずらして採点の番に書き出す
  const shifted: Case[] = [];
  const shiftCase = (c0: Case & { at?: string }): Case => {
    const at = Date.parse(String(c0.at ?? ""));
    const days = Number.isFinite(at) ? shiftDaysFor(`x ${new Date(at).toISOString()}`) : 0;
    if (!days) return c0;
    const yr = new Date(at + 9 * 3600e3).getUTCFullYear();
    const sh = (s: unknown) => typeof s === "string" ? shiftExamText(s, days, yr, at) : s;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c0.body)) {
      if (k === "recent_messages" || k === "recentMessages") body[k] = (v as Msg[]).map((m) => ({ ...m, text: String(sh(m.text) ?? "") }));
      else body[k] = sh(v);
    }
    return { ...c0, body, sent: String(sh(c0.sent)), inputText: String(sh(c0.inputText)) };
  };
  for (const c0 of list) {
    const c = shiftCase(c0);
    shifted.push(c);
    writeFileSync(`${OUT_DIR}/aixlink-cases-${LABEL}.json`, JSON.stringify({ cases: shifted }, null, 1));
    const t0 = new Date().toISOString();
    const msgs = ((c.body.recent_messages ?? c.body.recentMessages) as Msg[] | undefined) ?? [];
    try {
      h.assertSceneSafe(msgs.map((m) => m.text), c.id);
      await h.waitUntilYumaQuiet(own, { maxWaitMin: 30, conversationId: CONV });
      const times = h.sceneTimes(msgs.length, { stepSec: 60 });
      writeFloor(CONV, new Date(Date.parse(times[0]) - 1000).toISOString());
      const insertMsgs = async (from: number, to: number) => {
        if (to <= from) return;
        const ins = await sb.from("messages").insert(msgs.slice(from, to).map((m, k) => ({ conversation_id: CONV, sender: m.sender === "customer" ? "customer" : "staff", text: m.text || "[画像]", is_aix_generated: !!m.isAix, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[from + k] }))).select("id");
        if (ins.error) throw new Error(ins.error.message);
        own = [...own, ...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id)];
        await new Promise((r) => setTimeout(r, 1200));
      };
      const brain = (o: Record<string, unknown>) => runInDeepseekScope(async () => {
        setDeepseekScope({ conversationId: CONV, mark: { kind: "all" } });
        return analyzeConversation(CONV, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", ...o } as never);
      }) as unknown as Promise<Record<string, unknown> | null>;
      // 本番と同じ2層（brain-exam の prod と同じ）: 最後のお客様の連投の前までで全体の分析（戦略）→ 連投を入れて今回の発言の層
      let lastCust = msgs.length - 1; while (lastCust >= 0 && msgs[lastCust].sender !== "customer") lastCust--;
      let burst = lastCust; while (burst - 1 >= 0 && msgs[burst - 1].sender === "customer") burst--;
      let meta: Record<string, unknown> | null = null;
      if (lastCust >= 0 && burst > 0) {
        await insertMsgs(0, burst);
        const m0 = await brain({ prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
        const strategy = m0 ? extractStrategy(m0 as never, "combined", 0, new Date().toISOString()) : null;
        await insertMsgs(burst, msgs.length);
        meta = await brain({ prevPhase: (m0?.checkpoint_stage as string | null) ?? null, prevAix: m0 && m0.reply_mode === "aix" ? (m0.action as string | null) ?? null : null, prevMeta: m0 ?? undefined, mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy });
      } else {
        await insertMsgs(0, msgs.length);
        meta = await brain({ prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
      }
      const recent = msgs.map((m, k) => ({ ...m, createdAt: times[k], rawCreatedAt: times[k] }));
      const action = c.route === "aix-template-generate" ? String(c.body.actionType ?? "") : String(c.body.action ?? "");
      const note = buildAixContractNote({ meta: meta as never, action, checkPattern: (c.body.check_pattern as string | undefined) ?? null, messages: recent, env: { AIX_BRAIN_CONTRACT: "on" } });
      appendFileSync(brainFile, JSON.stringify({ id: c.id, action: keyOf(c), aix: meta?.action ?? null, mode: meta?.reply_mode ?? null, tc: meta?.turn_contract ?? null, mind: meta?.customer_mindset ?? null, note }) + "\n");
      for (let rep = 0; rep < REPS; rep++) for (const v of (rep % 2 ? ["after", "before"] : ["before", "after"]) as Array<"before" | "after">) {
        process.env[TOGGLE] = v === "before" ? "off" : "on";
        const t1 = Date.now();
        let text = "", err = "";
        try {
          if (c.route === "aix/action") {
            const body = { ...c.body, conversation_id: CONV, customer_name: "YUMA", recent_messages: recent, testBrainMeta: meta, testFlags: { rules_r9: "off" } };
            const res = await workAsyncStorage.run(store, () => aixPost(new Request("http://localhost/api/aix/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never)) as Response;
            const j = await res.json().catch(() => ({})) as Record<string, unknown>;
            text = String((c.action === "estimate_sheet" ? j.coverLetter : j.message_text) ?? "");
            if (!text) err = String(j.error ?? JSON.stringify(j).slice(0, 160));
          } else {
            const body = { ...c.body, conversationId: CONV, customerName: "YUMA", recentMessages: recent, testBrainMeta: meta };
            const res = await workAsyncStorage.run(store, () => tplPost(new Request("http://localhost/api/aix-template-generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never)) as Response;
            const j = await res.json().catch(() => ({})) as Record<string, unknown>;
            text = String(j.text ?? "");
            if (!text) err = String(j.error ?? JSON.stringify(j).slice(0, 160));
          }
        } catch (e) { err = `失敗: ${e instanceof Error ? e.message : String(e)}`; }
        n++;
        appendFileSync(outFile, JSON.stringify({ id: c.id, action: keyOf(c), v, rep, ms: Date.now() - t1, text, err: err || null, contract: !!note }) + "\n");
        console.log(`[${n}] ${c.id} ${v} r${rep + 1} 本質${note ? "あり" : "なし"} ${err ? "ERR " + err.slice(0, 120) : text.replace(/\n+/g, "／").slice(0, 110)}`);
      }
      delete process.env[TOGGLE];
    } catch (e) {
      console.error(`× ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
      appendFileSync(outFile, JSON.stringify({ id: c.id, action: keyOf(c), v: "before", rep: 0, text: "", err: String(e) }) + "\n");
    } finally {
      writeFloor(CONV, null);
      if (own.length) { await sb.from("messages").delete().in("id", own); own = []; }
      // 自分の回で作った生成の記録だけ（この会話・この番の開始の後）
      const g = await sb.from("aix_generate_log").select("id").eq("conversation_id", CONV).gte("created_at", t0);
      const gid = ((g.data ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (gid.length) await sb.from("aix_generate_log").delete().in("id", gid);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    try { if (floorFile) writeFileSync(floorFile, ""); } catch { /* */ }
    if (own.length) await sb.from("messages").delete().in("id", own);
    lease?.release();
    if (h) await h.finish();
    setTimeout(() => process.exit(process.exitCode ?? 0), 800);
  });
