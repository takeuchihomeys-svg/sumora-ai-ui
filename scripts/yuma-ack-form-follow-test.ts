// scripts/yuma-ack-form-follow-test.ts — 了承の返事（ack_form）: ブレインが決めた形に下書きが従うかを、竹内さんの実送信の番で確かめる（テスト専用の会話・DeepSeek）
//   2026-10-15 作る人（zenryoku-ack-1015）。材料: scripts/audit-ack-form-takeuchi.ts --out の json（前の約束→お客様の了承だけ→竹内さんの返事）。
//   1番ごとに: 直前の会話（最大8通・名前は YUMA に）をテスト専用の会話に入れ → ブレイン（ACK_FORM_BRAIN=on）→ その答案で generate-reply を版ごとに1回。
//   見る物: ブレインの ack_form／下書きの形（待ちの形の1文があるか）／約束・日付の言い直し／竹内さんの形との一致。
//   版: --versions=base,new（base＝ACK_FORM_FOLLOW=off の旧・new＝既定）。--force-takeuchi でブレインの ack_form を竹内さんの形に置き換えて生成だけ確かめる。
// 実行: REPLAY_FLOOR_FILE=scripts/.replay-out/ackform-floor.json LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-ack-form-follow-test.ts \
//         --floor=scripts/.replay-out/ackform-floor.json --conv=YUMA5 [--in=scripts/.replay-out/ack-form-takeuchi.json] [--only=0,3] [--versions=base,new] [--out=…jsonl]
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
import { acquireTestConversation } from "./lib/test-conv-lease";
import { MSG_SEP } from "../app/lib/reply-context";
import { splitSentencesJa, sentenceSimilarity } from "../app/lib/draft-repeat";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const IN = arg("in", "scripts/.replay-out/ack-form-takeuchi.json");
const OUT = arg("out", "scripts/.replay-out/ack-form-follow.jsonl");
const FLOOR_FILE = arg("floor");
const VERSIONS = arg("versions", "base,new").split(",");
const ONLY = arg("only").split(",").filter(Boolean).map(Number);
const FORCE_TAKEUCHI = process.argv.includes("--force-takeuchi");
const PREFIX = "ackf-";
const OFF_ENV: Record<string, string> = { ACK_FORM_FOLLOW: "off" };
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const own: string[] = [];
type Case = { conv: string; at: string; family: string; promiseForm: string; promise: string; takeuchiForm: "wait_line" | "receive_only"; reply: string; history: Array<{ sender: string; text: string | null; createdAt: string; isAix: boolean }> };

const ACK_REPLY_HEAD = /^(?:はい|かしこまりました|承知|全然|ありがとう)/;
const DATE_RE = /(?:明日|本日|明後日|週明け|月末|[0-9０-９]{1,2}月[0-9０-９]{1,2}日|[0-9０-９]{1,2}\/[0-9０-９]{1,2}|[月火水木金土日]曜)/;
const mask = (s: string) => s.replace(/[^\s、。！!？?／\n]{1,12}(?:さん|様)/g, (m) => (/管理会社|担当|皆|お客|オーナー|大家/.test(m) ? m : "YUMAさん"));

function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}
/** 下書きの形: wait＝「次第」の文がある／restate＝前の約束の文とほぼ同じ文・前の約束の日付を書いた */
export function draftForm(draft: string, promise: string): { form: "wait_line" | "receive_only"; restate: boolean; dateEcho: boolean; waitSentence: string | null } {
  const ss = splitSentencesJa(draft);
  const wait = ss.find((s) => /(?:次第|(?:出来|でき)(?:ましたら|たら)|出ましたら(?=[^。！!\n]{0,12}(?:お送り|ご連絡させて)))/.test(s)) ?? null;
  const restate = ss.some((s) => sentenceSimilarity(s, promise) >= 0.72);
  const pd = promise.match(DATE_RE)?.[0] ?? null;
  const dateEcho = !!pd && draft.includes(pd);
  return { form: wait ? "wait_line" : "receive_only", restate, dateEcho, waitSentence: wait };
}

let h: LlmTestHarness | null = null;
let CONV = "";
function writeFloor(floor: string | null) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: CONV, floor, status: "proposing", messageIdPrefix: PREFIX } : {}));
}
async function cleanup() { if (own.length) await sb.from("messages").delete().in("id", own); own.length = 0; }

async function main() {
  if (!process.env.REPLAY_FLOOR_FILE || process.env.REPLAY_FLOOR_FILE.replace(/\\/g, "/") !== FLOOR_FILE.replace(/\\/g, "/")) throw new Error("REPLAY_FLOOR_FILE と --floor を同じにする");
  const lease = acquireTestConversation(arg("conv", "YUMA5"), "yuma-ack-form-follow-test");
  CONV = lease.id;
  h = await setupLlmTest("yuma-ack-form-follow-test");
  h.assertTestConversation(CONV);
  process.env.ACK_FORM_BRAIN = "on";
  const all = (JSON.parse(readFileSync(IN, "utf8")) as Case[]).filter((c) => ACK_REPLY_HEAD.test(c.reply.trim()));
  const cases = ONLY.length ? ONLY.map((i) => all[i]).filter(Boolean) : all;
  console.log(`番 ${cases.length}（材料 ${all.length}）・会話 ${lease.name}・版 ${VERSIONS.join(",")}${FORCE_TAKEUCHI ? "・ack_form を竹内さんの形に固定" : ""}`);
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const { POST } = await import("../app/api/generate-reply/route");
  for (const [ci, c] of cases.entries()) {
    const hist = c.history.slice(-8).map((m) => ({ ...m, text: mask(String(m.text ?? "")) }));
    // 申込の書類・本人確認書類などが入った番は使わない（前で切ると了承の番が無くなる）
    const cut = h.cutBeforeApplicationMaterial(hist);
    if (cut.cutAt !== null) { console.log(`\n[${ci + 1}/${cases.length} ${c.conv.slice(0, 8)}] 飛ばす（${cut.reason}）`); continue; }
    h.assertSceneSafe(hist.map((m) => m.text), `${c.conv.slice(0, 8)}`);
    await h.waitUntilYumaQuiet(own, { conversationId: CONV });
    const lastAt = Date.parse(hist[hist.length - 1].createdAt);
    const shift = Date.now() + 60_000 - lastAt;
    const at = (iso: string) => new Date(Date.parse(iso) + shift).toISOString();
    const runId = randomUUID().slice(0, 8);
    const out: Record<string, unknown> = { i: all.indexOf(c), conv: c.conv.slice(0, 8), family: c.family, promiseForm: c.promiseForm, takeuchi: c.takeuchiForm, promise: c.promise };
    try {
      const ins = await sb.from("messages").insert(hist.map((m, i) => ({ conversation_id: CONV, sender: m.sender, text: m.text, is_aix_generated: m.isAix, created_at: at(m.createdAt), line_message_id: `${PREFIX}${runId}-${i}` }))).select("id");
      if (ins.error) throw new Error(ins.error.message);
      own.push(...(ins.data ?? []).map((x) => x.id as string));
      writeFloor(new Date(Date.parse(at(hist[0].createdAt)) - 5_000).toISOString());
      await new Promise((r) => setTimeout(r, 1200));
      h.assertTestConversation(CONV, "brain");
      const meta = await runInDeepseekScope(async () => {
        setDeepseekScope({ conversationId: CONV, mark: { kind: "all" } });
        return analyzeConversation(CONV, true, "proposing", null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
      }) as unknown as Record<string, unknown> | null;
      if (!meta) throw new Error("ブレインが null");
      const tc = (meta.turn_contract ?? null) as Record<string, unknown> | null;
      out.brainAck = (tc?.ack_form as string | undefined) ?? null;
      out.action = meta.action ?? null; out.reply_mode = meta.reply_mode ?? null;
      const useAck = FORCE_TAKEUCHI ? c.takeuchiForm : out.brainAck;
      const metaForGen = { ...meta, reply_mode: "auto_reply", action: null, turn_contract: tc ? { ...tc, ack_form: useAck } : { asks: [], close_only: true, must_not: [], proposals: [], ack_form: useAck } };
      const lastStaff = hist.map((m) => m.sender).lastIndexOf("staff");
      const cust = hist.slice(lastStaff + 1).filter((m) => m.sender === "customer").map((m) => m.text);
      for (const ver of VERSIONS) {
        const prev = Object.fromEntries(Object.keys(OFF_ENV).map((k) => [k, process.env[k]]));
        try {
          for (const [k, v] of Object.entries(OFF_ENV)) { if (ver === "base") process.env[k] = v; else delete process.env[k]; }
          // 生成の動的ブロックを番ごとに残す（どの注記が待ちの形・言い直しを書かせたかをたどる）
          if (arg("prompts")) { const d = `${arg("prompts")}/${all.indexOf(c)}-${ver}`; mkdirSync(d, { recursive: true }); process.env.DEBUG_PROMPT_DIR = d; }
          const body = {
            message: cust.join(MSG_SEP), customerMessages: cust, state: "proposing", conversationId: CONV, customerName: "YUMA", hasViewed: false, activeTaskTypes: [], hasStaffReplied: true,
            recentMessages: hist.map((m) => ({ sender: m.sender, text: m.text, createdAt: at(m.createdAt), isAix: m.isAix })),
            brainMetaDirect: { meta: metaForGen, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
            shadowNoWrite: true, testSceneMaterials: "on",
          };
          const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
          const ct = res.headers.get("content-type") ?? "";
          const draft = ct.includes("application/json") ? "" : parseStream(await res.text());
          const f = draftForm(draft, c.promise);
          out[ver] = { draft, ...f, followBrain: useAck ? f.form === useAck && !f.restate && !f.dateEcho : null, matchTakeuchi: f.form === c.takeuchiForm && !f.restate && !f.dateEcho };
          console.log(`\n[${ci + 1}/${cases.length} ${out.conv} ${c.family}・${c.promiseForm} ${ver}] 竹内=${c.takeuchiForm} ブレイン=${out.brainAck ?? "-"}${FORCE_TAKEUCHI ? `（生成は竹内さんの形 ${useAck} に固定）` : ""} 下書き=${f.form}${f.restate ? "・言い直し" : ""}${f.dateEcho ? "・日付" : ""}\n   約束「${c.promise.slice(0, 50)}」\n   下書き: ${draft.replace(/\n/g, "⏎").slice(0, 200)}`);
        } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
      }
    } catch (e) { out.error = e instanceof Error ? e.message : String(e); console.error(`   失敗: ${out.error}`); }
    finally { writeFloor(null); await cleanup(); }
    appendFileSync(OUT, JSON.stringify(out) + "\n");
  }
  const rows = readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>).filter((r) => !r.error);
  for (const ver of VERSIONS) {
    const d = rows.filter((r) => r[ver] && r.brainAck);
    console.log(`${ver}: ブレインが決めた番 ${d.length} のうち従った ${d.filter((r) => r[ver].followBrain).length}｜竹内さんと同じ形 ${rows.filter((r) => r[ver]?.matchTakeuchi).length}/${rows.filter((r) => r[ver]).length}｜言い直し・日付 ${rows.filter((r) => r[ver]?.restate || r[ver]?.dateEcho).length}`);
  }
  console.log(`ブレインの ack_form と竹内さんの一致 ${rows.filter((r) => r.brainAck === r.takeuchi).length}/${rows.length}（決めなかった ${rows.filter((r) => !r.brainAck).length}）`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { writeFloor(null); try { await cleanup(); } catch (e) { console.error("片付け失敗", e); } if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
