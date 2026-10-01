// scripts/yuma-replay-scenarios.ts
// 2026-10-01 竹内「LINEの自動返信を強化するために、出来ていない穴を見つけて改善する。実際のLINEのようにできていない部分をみつける。
//   一連の流れをYUMAにLINEでテストで繰り返して漏れなどをみつける…AIXでの返信も自動でおこなって、実際自動反映できていない部分もみつける…
//   自動返信をするにおいてのボトルネックをみつけて改善していく。ブレインや返信はDEEPSEEKのAPIを使って行う…テスト繰り返して最終だけクロードで」
//
// 本番の実際の会話から選んだ場面（scripts/replay-scenarios.json・名前は伏せ済み）を YUMA（竹内さん本人のテスト用の会話）に1つずつ入れ、
//   自動の道（ブレイン → 返信か AIX か → 下書き or AIX の文 → 最終チェック → 自動送信の関所）を最後まで通し、スタッフが実際にした事と比べる。
//   ・書くのは YUMA の messages（場面の通・line_message_id="replay-…"）だけ。場面ごとに消す（失敗しても finally で消す）
//   ・ブレインは analyzeConversation を直接呼ぶ（判断の保存・AIX要対応・カレンダー・通知を作らない）。全項目の層（strategy なし）＝YUMA の戦略を混ぜない
//   ・下書きは手元の開発サーバの /api/generate-reply を「書かない呼び方」（shadowNoWrite・テスト用の会話だけ）＋ブレインの判断を直接（bg-async と同じ T1）で
//     → ai_draft・ai_draft_check・ログは書かれない。reply_mode=aix の時は本番と同じく下書きを作らない（作ると [AIX誘導中] とグループ通知が走る経路がある）
//   ・AIX の文は /api/aix/action（文を返すだけ・送らない）。会話だけで作れる AIX は作り、材料の要る AIX は「何が足りないか」を記録する
//   ・LINE には何も送らない（送信の API は呼ばない）
//
// 実行（試行錯誤＝ブレインも DeepSeek。起動コマンドにだけ付ける・.env.local は書き換えない）:
//   開発サーバ（別ディレクトリの写し）: LLM_TEST_MODE=deepseek-all LLM_ALT_ACTIONS=reply_generate,brain_fresh,brain_full,property_send npx next dev --webpack -p 3377
//   LLM_TEST_MODE=deepseek-all LLM_ALT_ACTIONS=reply_generate,brain_fresh,brain_full REPLAY_BASE=http://localhost:3377 \
//     npx tsx --env-file=.env.local scripts/yuma-replay-scenarios.ts [--only=id,id] [--stage=cost,viewing] [--label=r1] [--no-gen] [--no-aix]
// 最終（本番と同じ組み合わせ＝ブレイン・判定・最終チェックは Claude・本文は DeepSeek）: 開発サーバも本スクリプトも LLM_TEST_MODE を外して --only で数件
//
// 出力: %TEMP% ではなく REPLAY_OUT（既定 scripts/.replay-out/<label>.jsonl）に1場面1行＋最後に場面ごとの表と llm_usage_logs の model の集計
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { judgeTurn, isAgree, type Verdict } from "../app/lib/line-watch-judge";
import { sceneKeyOf } from "../app/lib/line-watch-turn";
import { canAutoReply } from "../app/lib/auto-reply-policy";
import { auditSimTurn } from "../app/lib/customer-sim";
import { dedupeRepeatedEmoji } from "../app/lib/emoji-repeat";
import { propertyNamePrefill } from "../app/lib/aix-prefill";
import { classifyAixAutofill, type AixAutofill } from "../app/lib/aix-autofill-readiness";
import { firstReplyStateOrNull } from "../app/lib/conversation-status";
import { MSG_SEP } from "../app/lib/reply-context";

type Analyze = typeof import("../app/lib/brain-core").analyzeConversation;
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
let h: LlmTestHarness | null = null;
async function loadBrain(): Promise<Analyze> {
  // ⚠ fetch の包みは brain-core を読み込む前（Anthropic SDK は作られた時点の fetch を握る）。使用量の記録も入れる（model を後で確かめる）
  // 2026-10-01 共通の入口（scripts/lib/llm-test-harness.ts・手順書 memory/test_protocol_brain.md）: テストの種類の明示（deepseek-all／LLM_TEST_FINAL_CLAUDE=1）・包みの順・記録の待ち・Claude の歯止め・YUMA だけ
  h = await setupLlmTest("yuma-replay-scenarios");
  return (await import("../app/lib/brain-core")).analyzeConversation;
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.REPLAY_BASE ?? "http://localhost:3377";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ONLY = arg("only").split(",").filter(Boolean);
const STAGES = arg("stage").split(",").filter(Boolean);
const LABEL = arg("label", `r-${new Date().toISOString().slice(5, 16).replace(/[:T-]/g, "")}`);
const NO_GEN = args.includes("--no-gen");
const NO_AIX = args.includes("--no-aix");
const REPS = Math.max(1, Number(arg("reps", "1")));
const OUT_DIR = process.env.REPLAY_OUT ?? "scripts/.replay-out";
// 2026-10-02 ⑫（竹内「DEEPSEEKで一連の流れを実際にYUMAにLINEで送りまくって…自動で繰り返し続ける」）:
//   --file=<場面の json>（一連の流れ scripts/.replay-out/flows-*.json も読める）／--prefix=<line_message_id の頭>（同時に走る他の担当の "replay-d1002-" 等と分ける）
//   --send: 出来た文（返信の下書き＝送信前の関門を通した形／作れた AIX の文）を本番の送信 API で YUMA の LINE に実際に送る（scripts/lib/yuma-line-send.ts）。
//     竹内さんの指示で試行錯誤（deepseek-all）の文も送る（送るのは竹内さん本人のテスト用の LINE だけ・宛先は毎回読み直す）。
//     LINE の月の上限の確かめ（送った後の残りが上限の30%・本番の見込みを下回るなら送らない）・1巡の上限 --send-cap（既定 40）・
//     スタッフの宣言の文（本番がブレインを分析し直してグループに通知する）は送らない。送った後に本番が書く記録は自分の line id の物だけ消す
const SCEN_FILE = arg("file", "scripts/replay-scenarios.json");
const PREFIX = arg("prefix", "replay-");
const SEND = args.includes("--send");
const SEND_CAP = Number(arg("send-cap", "40"));
// 場面より前の YUMA の記録を読まない線（app/lib/test-replay-floor.ts）。開発サーバも同じファイルを読む（起動コマンドに REPLAY_FLOOR_FILE を付ける）
const FLOOR_FILE = process.env.REPLAY_FLOOR_FILE ?? "";
function writeFloor(floor: string | null, status?: string) {
  if (!FLOOR_FILE) return;
  writeFileSync(FLOOR_FILE, JSON.stringify(floor ? { conversationId: YUMA, floor, status, messageIdPrefix: PREFIX } : {}));
}

type Ctx = { s: string; t: string; aix?: boolean; img?: boolean };
type Scenario = {
  id: string; stage: string; stage_ja: string; src: string; context: Ctx[]; customer: string[];
  staff: { aix: Array<{ aix: string; cp: string | null }>; texts: string[]; aix_texts: string[] };
  expect: { accept: string[]; why: string; must?: string[]; mustNot?: string[] };
};

let cleanup: string[] = [];
const sendState: { enabled: boolean; sent: number; ids: string[]; windows: string[]; quota: unknown } = { enabled: false, sent: 0, ids: [], windows: [], quota: null };
// 2026-10-01 申込の書類（氏名・生年月日・住所・勤務先・年収）が場面に入っていたら LLM に渡さない（DeepSeek に個人情報を出さない・申込以降は対象外）。
//   最初の版の場面の作り方（申込へ押下より前だけ）では申込フォームの記入済みの通が混ざり、2場面が DeepSeek に渡った＝場面の作り方も直した
export const APPLICATION_PII_RE = /申込者様記入欄|同居人記入欄|緊急連絡先欄|生年月日|年収|勤務先電話|フリガナs*[ァ-ヶ]/;
function hasApplicationPii(sc: Scenario): boolean {
  return [...sc.context.map((m) => m.t), ...sc.customer].some((t) => APPLICATION_PII_RE.test(t ?? ""));
}
async function insertScene(sc: Scenario): Promise<{ msgs: Array<{ sender: string; text: string; created_at: string; is_aix_generated: boolean }> }> {
  // 他の担当も YUMA に場面を入れる（同時に走る）ので、自分の場面が一番新しくなるよう先の時刻に置く（最後のお客様の発言＝今+120分）
  const all: Ctx[] = [...sc.context, ...sc.customer.map((t) => ({ s: "customer", t }))];
  const end = Date.now() + 120 * 60_000;
  const rows = all.map((m, i) => ({
    conversation_id: YUMA, sender: m.s === "customer" ? "customer" : "staff", text: m.t || (m.img ? "[画像]" : ""),
    is_aix_generated: !!m.aix, line_message_id: `${PREFIX}${randomUUID()}`,
    created_at: new Date(end - (all.length - 1 - i) * 90_000).toISOString(),
  }));
  const ins = await sb.from("messages").insert(rows).select("id");
  if (ins.error) throw new Error(`場面を作れず: ${ins.error.message}`);
  cleanup.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  writeFloor(new Date(Date.parse(rows[0].created_at) - 1000).toISOString(), sc.stage === "first_contact" ? "hearing" : "proposing");
  // 線を読む側は1秒覚えるので、書き換えが届くまで少し待つ
  await new Promise((r) => setTimeout(r, 1200));
  return { msgs: rows.map((r) => ({ sender: r.sender, text: r.text, created_at: r.created_at, is_aix_generated: r.is_aix_generated })) };
}
async function removeScene() {
  writeFloor(null);
  if (!cleanup.length) return;
  await sb.from("messages").delete().in("id", cleanup);
  cleanup = [];
}

function parseStream(raw: string): { text: string; finalCheck: Record<string, unknown> | null; meta: Record<string, unknown> | null } {
  const s = String(raw ?? "");
  let meta: Record<string, unknown> | null = null;
  let body = s;
  const nl = s.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(s.slice(0, nl)); if (j && typeof j === "object" && !Array.isArray(j)) { meta = j; body = s.slice(nl + 1); } } catch { /* 1行目が本文 */ } }
  let finalCheck: Record<string, unknown> | null = null;
  const m = body.match(/<<<FINAL_CHECK:([\s\S]*?)>>>/);
  if (m) { try { finalCheck = JSON.parse(m[1]); } catch { finalCheck = null; } }
  return { text: body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim(), finalCheck, meta };
}
/** cron/auto-reply-dispatch の hasBlock と同じ読み方 */
function hasBlock(check: unknown): boolean {
  if (!check || typeof check !== "object") return false;
  const c = check as Record<string, unknown>;
  if (c.ok === false) return true;
  const items = Array.isArray(c.issues) ? c.issues : Array.isArray(c.items) ? c.items : [];
  return items.some((it) => { const sev = (it as Record<string, unknown>)?.severity; return sev === "block" || sev === "error"; });
}

async function generateDraft(sc: Scenario, msgs: Array<{ sender: string; text: string; created_at: string; is_aix_generated: boolean }>, meta: Record<string, unknown>, status: string) {
  const units = sc.customer.map((t) => t.trim()).filter(Boolean);
  const staffEngaged = sc.context.some((m) => m.s === "staff" && m.t.trim() && m.t.trim() !== "[画像]");
  const body = {
    // 本番の bg-async と同じ: 連投は MSG_SEP でつなぐ・こちらが何も送っていなければ first_reply（初回の挨拶を付ける判定がこれを見る）
    message: units.join(MSG_SEP), customerMessages: units, state: firstReplyStateOrNull(status, staffEngaged) ?? status, conversationId: YUMA, customerName: "YUMA",
    hasViewed: false, activeTaskTypes: [], hasStaffReplied: staffEngaged,
    recentMessages: msgs.slice(-25).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated })),
    brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
    shadowNoWrite: true,
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { text: "", finalCheck: null, skipped: String(j.reason ?? j.error ?? `HTTP ${res.status}`), ms: Date.now() - t0 };
  }
  const p = parseStream(await res.text());
  return { ...p, skipped: null as string | null, ms: Date.now() - t0 };
}

async function generateAix(sc: Scenario, msgs: Array<{ sender: string; text: string; created_at: string; is_aix_generated: boolean }>, action: string, fill: AixAutofill, status: string) {
  if (!fill.request && fill.level === "auto") return { text: "[電話をかけるボタン＋定型の案内（固定）]" as string | null, skipped: null as string | null, ms: 0 };
  if (!fill.request) return { text: null as string | null, skipped: fill.blockers.join("・") || "材料なし", ms: 0 };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    action, account: "sumora", conversation_id: YUMA, customer_name: "YUMA", conversation_status: status,
    recent_messages: msgs.slice(-20).map((m) => ({ sender: m.sender, text: m.text, rawCreatedAt: m.created_at, createdAt: m.created_at, isAix: m.is_aix_generated })),
    ...fill.request,
  }), signal: AbortSignal.timeout(240_000) });
  const j = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { text: (String(j.message_text ?? "").trim() || null), skipped: j.error ? `ERROR ${String(j.error).slice(0, 80)}` : null, ms: Date.now() - t0 };
}

function judgeText(draft: string, staffTexts: string[]): { verdict: Verdict | null; reason: string } {
  if (!draft || !staffTexts.length) return { verdict: null, reason: "比べる文が無い" };
  const now = new Date().toISOString();
  const j = judgeTurn({ draft, brainAction: null, brainReplyMode: "reply", hasBrain: true, window: { closed: true, texts: staffTexts.map((t) => ({ at: now, text: t, burst: true })), presses: [], aixMessages: 0, aixMessagesBurst: 0 } });
  return { verdict: j.verdict, reason: j.detail.reason };
}

async function main() {
  const file = JSON.parse(readFileSync(SCEN_FILE, "utf8")) as { scenarios: Scenario[] };
  const list = file.scenarios.filter((s) => (!ONLY.length || ONLY.includes(s.id)) && (!STAGES.length || STAGES.includes(s.stage)));
  const testMode = process.env.LLM_TEST_MODE ?? "";
  const analyzeConversation = await loadBrain();
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/${LABEL}.jsonl`;
  writeFileSync(outFile, "");
  const t0 = new Date().toISOString();
  if (!FLOOR_FILE) console.warn("⚠ REPLAY_FLOOR_FILE なし＝YUMA の過去の記録（送った物件・見積書・内覧の予定）が場面に混ざる");
  // 実送信の前の確かめ（LINE の月の上限・本番の見込み）と、送る前の YUMA の要対応（送信の本文で「済み」にされた物を戻すため）
  let pendingBefore: Array<{ id: string }> = [];
  if (SEND) {
    const ysend = await import("./lib/yuma-line-send");
    const q = await ysend.quotaGate(SEND_CAP);
    console.log(`=== LINE の月の上限 ${JSON.stringify(q)} ===`);
    sendState.quota = q;
    sendState.enabled = q.ok;
    if (!q.ok) console.warn(`⛔ 実送信を止める: ${q.reason}（DeepSeek の確かめだけ続ける）`);
    const { data } = await sb.from("aix_action_items").select("id").eq("conversation_id", YUMA).eq("status", "pending");
    pendingBefore = (data ?? []) as Array<{ id: string }>;
  }
  console.log(`=== YUMA 再生 ${list.length}場面×${REPS} label=${LABEL} floor=${FLOOR_FILE ? "あり" : "なし"} test-mode=${testMode || "（なし＝本番と同じ）"} alt=${process.env.LLM_ALT_ACTIONS ?? "-"} base=${BASE} ===`);
  const rows: Array<Record<string, unknown>> = [];
  for (const sc of list) for (let rep = 0; rep < REPS; rep++) {
    const status = sc.stage === "first_contact" ? "hearing" : "proposing";
    const rec: Record<string, unknown> = { id: sc.id, stage: sc.stage, stage_ja: sc.stage_ja, rep, accept: sc.expect.accept, staff_aix: sc.staff.aix.map((a) => a.aix), staff_text: sc.staff.texts.join("\n").slice(0, 600) };
    if (hasApplicationPii(sc)) { console.warn(`⛔ ${sc.id}: 申込の書類（個人情報）が入っているので流さない`); continue; }
    // 2026-10-02 ⑫: 手順書の個人情報の網（1通ずつ・本人確認書類・収入の書類・個人の値）も当てる（一連の流れは掘る側の線だけに頼らない）
    {
      const { applicationMaterialReason } = await import("../app/lib/test-pii-guard");
      const bad = [...sc.context.map((m) => m.t), ...sc.customer].map((t) => applicationMaterialReason(t ?? "")).find(Boolean);
      if (bad) { console.warn(`⛔ ${sc.id}: ${bad} が入っているので流さない`); continue; }
    }
    try {
      const { msgs } = await insertScene(sc);
      const tb = Date.now();
      const meta = await runInDeepseekScope(async () => {
        // YUMA は竹内さん本人のテスト用の会話＝線は全部（kind=all）。本番のブレインはこの印を置かない（Claude のまま）
        setDeepseekScope({ conversationId: YUMA, mark: { kind: "all" } });
        return analyzeConversation(YUMA, true, status, null, "brain", { autoSendEnabled: true, customerName: "YUMA", prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null });
      }) as unknown as Record<string, unknown>;
      rec.brain_ms = Date.now() - tb;
      if (!meta) throw new Error("ブレインが判断を返さなかった（null）");
      const action = typeof meta?.action === "string" && meta.action.trim() ? meta.action.trim() : null;
      const replyMode = typeof meta?.reply_mode === "string" ? meta.reply_mode : null;
      const scene = sceneKeyOf({ brainAction: action, brainReplyMode: replyMode, convStatus: status });
      const decided = scene.path === "AIX" ? (action ?? "aix") : "reply";
      rec.brain = { action, check_pattern: meta?.check_pattern ?? null, reply_mode: replyMode, source: meta?.decision_source ?? null, direction: String(meta?.reply_direction ?? "").slice(0, 200), stage: meta?.checkpoint_stage ?? null, two_choice: meta?.two_choice_mode === true };
      rec.decided = decided;
      rec.path_ok = sc.expect.accept.includes(decided);
      // ── 下書き（reply_mode=aix 以外。2択＝AIX の提案＋下書きも本番どおり作る）──
      let draft = "";
      let fc: Record<string, unknown> | null = null;
      if (!NO_GEN && replyMode !== "aix") {
        const g = await generateDraft(sc, msgs, meta, status);
        draft = g.text; fc = g.finalCheck; rec.gen_ms = g.ms; if (g.skipped) rec.gen_skipped = g.skipped;
        rec.draft = draft;
        const issues = Array.isArray(fc?.issues) ? (fc!.issues as Array<Record<string, unknown>>) : [];
        rec.final_check = fc ? { ok: fc.ok ?? null, issues: issues.map((i) => `${String(i.code)}:${String(i.severity)}`).slice(0, 12), revision: (fc.tpo_debug as Record<string, unknown> | undefined)?.revisionOutcome ?? null, tpo: (fc.tpo_debug as Record<string, unknown> | undefined)?.tpo_label ?? null } : null;
      }
      // ── 自動送信の関所（自動に切り替えた会話と見なす）──
      const gate = canAutoReply({ autoSendEnabled: true, lastSender: "customer", replyMode, suggestedAixAction: action, draft, draftHasBlock: hasBlock(fc), status, hasPendingScheduled: false });
      rec.gate = gate.reason;
      // ── 文の比べ（返信の道）──
      if (draft) {
        const tj = judgeText(draft, sc.staff.texts);
        rec.text_verdict = tj.verdict; rec.text_reason = tj.reason;
        const hist = [...sc.context.map((m) => ({ sender: m.s, text: m.t })), ...sc.customer.map((t) => ({ sender: "customer", text: t }))];
        const audit = auditSimTurn({ sentText: draft, historyBefore: hist }).map((f) => `${f.kind}:${f.detail}`);
        if (dedupeRepeatedEmoji(draft).changes.length) audit.push("emoji_repeat");
        for (const re of sc.expect.mustNot ?? []) if (new RegExp(re).test(draft)) audit.push(`mustNot:${re}`);
        for (const re of sc.expect.must ?? []) if (!new RegExp(re).test(draft)) audit.push(`must:${re}`);
        rec.audit = audit;
      }
      // ── AIX の自動反映（ブレインが AIX を選んだ時）──
      if (action && !NO_AIX) {
        const custText = sc.customer.join("\n");
        const staffSent = [...sc.context].reverse().filter((m) => m.s === "staff").flatMap((m) => [...m.t.matchAll(/🌟\s*([^\n]+)/g)].map((x) => x[1].trim()));
        const prefName = propertyNamePrefill({ customerTurnText: custText, staffSent });
        const fill = classifyAixAutofill({ action, checkPattern: (meta?.check_pattern as string | null) ?? null, customerText: custText, contextTexts: sc.context.map((m) => m.t), staffTexts: sc.context.filter((m) => m.s === "staff").map((m) => m.t), propertyName: prefName?.value ?? null });
        rec.aix_fill = { level: fill.level, blockers: fill.blockers, prefilled: fill.prefilled };
        const g = await generateAix(sc, msgs, action, fill, status);
        rec.aix_text = g.text; rec.aix_ms = g.ms; if (g.skipped) rec.aix_skipped = g.skipped;
        if (g.text && sc.staff.aix_texts.length) { const tj = judgeText(g.text, sc.staff.aix_texts); rec.aix_text_verdict = tj.verdict; rec.aix_text_reason = tj.reason; }
        if (g.text) {
          const hist = [...sc.context.map((m) => ({ sender: m.s, text: m.t })), ...sc.customer.map((t) => ({ sender: "customer", text: t }))];
          rec.aix_audit = auditSimTurn({ sentText: g.text, historyBefore: hist }).map((f) => `${f.kind}:${f.detail}`);
        }
      }
      // 自動で正しく送れたか: 道が正しく・関所を通り・文が一致（同じ/同じ事）・検査の指摘なし
      rec.auto_correct = !!rec.path_ok && gate.ok && isAgree(rec.text_verdict as Verdict) && !((rec.audit as string[] | undefined)?.length);
      // ── 実送信（--send・YUMA の LINE だけ）──
      if (sendState.enabled) {
        const { draftToSendableText } = await import("../app/lib/draft-text");
        const { detectPlaceholders } = await import("../app/lib/validate-reply");
        const { ALLOWED_EMOJIS } = await import("../app/lib/emoji-allowlist");
        const ysend = await import("./lib/yuma-line-send");
        const isAixText = !draft && typeof rec.aix_text === "string" && !String(rec.aix_text).startsWith("[");
        const raw = draft || (isAixText ? String(rec.aix_text) : "");
        const sendable = raw ? (draftToSendableText(raw)?.trim() ?? "") : "";
        const ph = sendable ? detectPlaceholders(sendable) : [];
        rec.line_risks = sendable ? ysend.lineRenderRisks(sendable, ALLOWED_EMOJIS) : [];
        if (!raw) rec.send = "送らず: 文なし";
        else if (!sendable) rec.send = "送らず: 送信前の関門で送れない形";
        else if (ph.length) rec.send = `送らず: 未置換 ${ph.join(" ")}`;
        else if (sendState.sent >= SEND_CAP) rec.send = `送らず: 1巡の上限 ${SEND_CAP}`;
        else if (await ysend.promiseTriggersBrain(sendable)) rec.send = "送らず: スタッフの宣言（本番がブレインを分析し直してグループに通知するため）";
        else {
          const r = await ysend.sendToYuma(sendable);
          sendState.sent += r.ok ? 1 : 0;
          if (r.ok) { sendState.ids.push(...r.ids); sendState.windows.push(r.sentAt); }
          rec.send = r.ok ? `送った（${isAixText ? "AIX" : "返信"}・LINE id ${r.ids.join(",")}）` : `失敗 ${r.status} ${r.error ?? ""}`;
          rec.sent_text = sendable;
        }
      }
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
    } finally {
      await removeScene();
    }
    rows.push(rec);
    appendFileSync(outFile, JSON.stringify(rec) + "\n");
    const b = rec.brain as Record<string, unknown> | undefined;
    console.log(`\n【${sc.id}｜${sc.stage_ja}】 ${rec.path_ok ? "✓" : "✗"} 道=${String(rec.decided)}（正解 ${sc.expect.accept.join("|")}） src=${String(b?.source ?? "-")} mode=${String(b?.reply_mode ?? "-")} 関所=${String(rec.gate)} ${rec.text_verdict ? `文=${String(rec.text_verdict)}(${String(rec.text_reason)})` : ""}${rec.error ? ` ERROR ${String(rec.error)}` : ""}`);
    console.log(`   お客様: ${sc.customer.join(" / ").replace(/\n/g, " ").slice(0, 120)}`);
    if (rec.draft) console.log(`   下書き: ${String(rec.draft).replace(/\n/g, " / ").slice(0, 260)}`);
    if (sc.staff.texts.length) console.log(`   実際　: ${sc.staff.texts.join(" || ").replace(/\n/g, " / ").slice(0, 260)}`);
    if ((rec.audit as string[] | undefined)?.length) console.log(`   検査　: ${(rec.audit as string[]).join(" ／ ")}`);
    if (rec.final_check) console.log(`   最終C : ${JSON.stringify(rec.final_check)}`);
    if (rec.send) console.log(`   実送信: ${String(rec.send)}${(rec.line_risks as string[] | undefined)?.length ? ` ／ LINE の崩れ: ${(rec.line_risks as string[]).join("・")}` : ""}`);
    if (rec.aix_fill) console.log(`   AIX反映: ${JSON.stringify(rec.aix_fill)}${rec.aix_text ? `\n   AIX文 : ${String(rec.aix_text).replace(/\n/g, " / ").slice(0, 220)}${rec.aix_text_verdict ? ` [${String(rec.aix_text_verdict)}]` : ""}` : rec.aix_skipped ? ` 作らず: ${String(rec.aix_skipped)}` : ""}`);
  }
  // ── まとめ（場面ごと）──
  console.log(`\n=== まとめ（${LABEL}）===`);
  const by = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) { const k = String(r.stage_ja); if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  let P = 0, T = 0, G = 0, A = 0, N = 0;
  for (const [k, rs] of by) {
    const p = rs.filter((r) => r.path_ok).length;
    const withText = rs.filter((r) => r.text_verdict);
    const t = withText.filter((r) => isAgree(r.text_verdict as Verdict)).length;
    const g = rs.filter((r) => r.gate === "ok").length;
    const a = rs.filter((r) => r.auto_correct).length;
    P += p; T += t; G += g; A += a; N += rs.length;
    console.log(`${k.padEnd(12)} n=${rs.length} 道 ${pct(p, rs.length)}・文の一致 ${t}/${withText.length}・関所を通る ${g}・自動で正しく ${a}  関所: ${[...new Set(rs.map((r) => String(r.gate)))].join(",")}`);
  }
  console.log(`合計 n=${N} 道 ${pct(P, N)}・文の一致 ${T}・関所を通る ${G}・自動で正しく ${A}`);
  // ── 実送信の後片付け（本番が送信の後に書いた YUMA の記録のうち、自分の送信に結び付く物だけ）──
  if (SEND && sendState.sent > 0) {
    await new Promise((r) => setTimeout(r, 40_000));
    const ysend = await import("./lib/yuma-line-send");
    const side = await ysend.sideRowsSince(sendState.windows[0]);
    const myIds = new Set(sendState.ids);
    const facts = (side.sent_facts ?? []).filter((r) => myIds.has(String(r.line_message_id ?? "")));
    if (facts.length) await sb.from("sent_facts").delete().in("id", facts.map((r) => String(r.id)));
    // 送信の本文で「済み」にされた YUMA の要対応（done_by=staff_text・自分の送信の時刻以降）を元に戻す
    const { data: doneRows } = await sb.from("aix_action_items").select("id, done_at, done_by").in("id", pendingBefore.map((p) => p.id).length ? pendingBefore.map((p) => p.id) : ["00000000-0000-0000-0000-000000000000"]).eq("status", "done").eq("done_by", "staff_text").gte("done_at", sendState.windows[0]);
    const revert = ((doneRows ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (revert.length) await sb.from("aix_action_items").update({ status: "pending", done_at: null, done_by: null, resolution_note: null }).in("id", revert);
    const others = Object.entries(side).filter(([t]) => t !== "sent_facts").map(([t, rs]) => `${t} ${rs.length}行`).join("・");
    console.log(`\n=== 実送信 ${sendState.sent}通（LINE id ${sendState.ids.length}）・後片付け: sent_facts ${facts.length}行を消した・要対応 ${revert.length}件を戻した・同じ時間の他の記録（他の担当の物を含みうる・消していない）: ${others} ===`);
    appendFileSync(outFile, JSON.stringify({ _send: true, sent: sendState.sent, ids: sendState.ids, quota: sendState.quota, cleaned_facts: facts.map((r) => r.id), reverted_items: revert, side_counts: Object.fromEntries(Object.entries(side).map(([t, rs]) => [t, rs.length])) }) + "\n");
  }
  const { data: logs } = await sb.from("llm_usage_logs").select("action, model, env").gte("created_at", t0).eq("conversation_id", YUMA);
  const tally = new Map<string, number>();
  let ds = 0, all = 0;
  for (const l of (logs ?? []) as Array<Record<string, unknown>>) { const key = `${String(l.model)}`; tally.set(key, (tally.get(key) ?? 0) + 1); all++; if (/deepseek/i.test(String(l.model))) ds++; }
  console.log(`\n=== llm_usage_logs（YUMA・この回）DeepSeek ${ds}/${all} ===`);
  for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${k} × ${v}`);
  appendFileSync(outFile, JSON.stringify({ _summary: true, models: Object.fromEntries(tally), deepseek: ds, total: all, t0 }) + "\n");
  console.log(`\n→ ${outFile}`);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await removeScene(); if (h) await h.finish().catch((e) => console.warn("finish:", String(e))); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
