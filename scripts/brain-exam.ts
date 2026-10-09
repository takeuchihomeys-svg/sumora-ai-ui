// scripts/brain-exam.ts — ブレインの試験（読み違えた実例の正解つきの問題を、今のブレインに全部解かせて点数を出す）
//
// 2026-10-08 竹内さん①「読み違えた実例を正解つきの『試験問題』にして、ブレインを直すたびに全部解かせ、前より悪くならないか確かめる」
//   問題: scripts/brain-exam/problems.json（scripts/brain-exam-add.ts が spec.json から作る・伏せた会話の写し＋台帳の写し＋正解）
//   解かせ方: 問題ごとに、その番の時点までの会話（伏せた物）を YUMA に未来の時刻で入れ、ブレインを回す。
//     手順は memory/test_protocol_brain.md どおり: YUMA だけ・共通の入口・同時1本（他の担当の写しが終わるまで待つ）・自分の行だけ消す・条件の行は戻す。
//     REPLAY_FLOOR_FILE で YUMA の過去の記録を読まない（messages は自分の印の行だけ）。日付は今日にずらす（曜日はそのまま）。時刻の「今」はその番の JST の時。
//   判定: ①道（返信／約束の種類／AIX の種類×ピッカー）は決まった計算（scripts/lib/brain-exam-score.ts）
//         ②依頼の一覧（asks）が答え方つきで入ったか・③言ってはいけない事を守ったか、は DeepSeek の判定（--no-judge で止める）
//   モデル: 既定は LLM_TEST_MODE=deepseek-all（ブレインも DeepSeek）。本番のブレイン（Claude）で回すのは LLM_TEST_FINAL_CLAUDE=1（場面ごとに1〜2回・--only か --per-type で絞る）。
//           判定はどちらでも DeepSeek を直に呼ぶ（記録の外なので費用はこのスクリプトが数えて出す）。
//
// 2026-10-09 竹内さん「テストの際ブレインの判断を邪魔している部分も調査」で見つかった試験の穴を直した（scripts だけ・app は触らない）:
//   ① 台帳: 問題の ledger（その番の時点の aix_usage_logs・sent_properties・property_pickups・estimate_records・viewings・viewing_history・sent_facts）を
//      YUMA に写す（場面の時刻へずらす・内覧の告知は送らない印・自分の id を控えて消す）。--no-ledger で止める
//   ② 本番と同じ2層: --layer=prod（既定）＝その番の前までの会話で全体の分析（戦略の層）→ 戦略・前回の AIX・前回の判断を渡して今回の発言の層。--layer=combined で旧（1回・戦略なし）
//   ③ 条件の行: 写した後に読み直して確かめる（前の実行の要約の書き戻しが遅れて混ざる）・線の表に無い表（deal_outcomes 等）の YUMA の行を数えて出す
//   ④ 3段の採点: 本質の道（LLM が最初に出した答え＝決まりで直される前）・最終の道（今まで）・下書き（--draft: 返信・2段が正解の問題だけ、
//      ブレインの答案を固定して generate-reply を同じプロセスで1回流し、下書きの道・依頼・言ってはいけない事を DeepSeek で判定）
//
// 実行（必ず両方の環境変数を付ける・.env.local には書かない）:
//   REPLAY_FLOOR_FILE=scripts/.replay-out/brain-exam-floor-<label>.json LLM_TEST_MODE=deepseek-all \
//     npx tsx --env-file=.env.local scripts/brain-exam.ts --label=base-ds [--draft] [--layer=prod|combined] [--no-ledger] [--only=q001,q002] [--types=出し切り] [--per-type=1] [--repeat=1] [--no-judge] [--baseline=<前の label>]
//   最後の Claude:  REPLAY_FLOOR_FILE=… LLM_TEST_FINAL_CLAUDE=1 npx tsx --env-file=.env.local scripts/brain-exam.ts --label=base-claude --per-type=1
//   結果だけ並べ直す（ブレインを回さない）: npx tsx --env-file=.env.local scripts/brain-exam.ts --report=<label> [--baseline=<label>]
//   2026-10-09 竹内さん承認（巡を速く）: --conv=auto|YUMA2〜YUMA5 で LINE につながっていないテスト専用の会話を使う（鍵のファイルで担当ごとに占有・
//     scripts/lib/test-conv-lease.ts）。線のファイル（REPLAY_FLOOR_FILE を付けなければ brain-exam-floor-<label>-<会話>.json を自動で）・条件の行の写しの控えも会話ごと。
//     --conv を付けなければ今まで通り YUMA。--only-type=<型> は --types= と同じ（関係する問題だけ回す）
// 結果: scripts/brain-exam/results/<label>.jsonl（問題×回）・<label>.summary.txt・<label>.meta.json（構成）。途中で止めても同じ label で続きから。
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { acquireTestConversation, type TestConvLease } from "./lib/test-conv-lease";
import { shiftExamText } from "./lib/brain-exam-dates";
import { brainPathCode, judgePath, problemScore, rateByType, aixFamily, judgeCurrentProperty, type BrainExamOutput, type ProblemScore, type PathCode } from "./lib/brain-exam-score";
import { similarity } from "../app/lib/property-name-match";
import type { ExamProblem, LedgerRow } from "./brain-exam-add";

const PROBLEMS_FILE = "scripts/brain-exam/problems.json";
const RESULTS_DIR = "scripts/brain-exam/results";
const PREFIX = "bexam-";
const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);
const LABEL = arg("label", arg("report"));
const ONLY = arg("only").split(",").filter(Boolean);
const TYPES = (arg("types") || arg("only-type")).split(",").filter(Boolean);
// 2026-10-09: テスト用の会話（既定 YUMA・--conv=auto|YUMA2〜YUMA5）。main で鍵を取ってから決まる
const CONV_ARG = arg("conv");
let lease: TestConvLease | null = null;
let CONV: string = YUMA;
let CONV_TAG = "yuma";
const PER_TYPE = Number(arg("per-type", "0"));
// 10/09: --majority＝ブレインも判定も3回の過半数（関所の既定にする。--repeat / --judge-repeat で上書き）
const MAJORITY = flag("majority");
const REPEAT = Math.max(1, Number(arg("repeat", MAJORITY ? "3" : "1")));
const JUDGE_REPEAT = Math.max(1, Number(arg("judge-repeat", MAJORITY ? "3" : "1")));
const NO_JUDGE = flag("no-judge");
const BASELINE = arg("baseline");
const GAP_MS = Number(arg("gap-ms", "2000"));
const LAYER = arg("layer", "prod") === "combined" ? "combined" : "prod";
const USE_LEDGER = !flag("no-ledger");
const DRAFT = flag("draft");
// 10/08 竹内さん: 出し切りの正解は search-exhausted（出し切ったら AIX 全力サポート）が入るまで「新着待ちの返信 or 全力サポート」の両方、入ったら全力サポートだけ。
//   spec の acceptWhen.searchExhausted がその時の正解。入ったか＝brain-core が search-exhausted を読んでいて SEARCH_EXHAUSTED_ZENRYOKU が off でない（--exhausted-rule=on|off で上書き）
const EXHAUSTED_RULE = arg("exhausted-rule") ? arg("exhausted-rule") === "on" : (() => { try { return readFileSync("app/lib/brain-core.ts", "utf8").includes('from "@/app/lib/search-exhausted"') && process.env.SEARCH_EXHAUSTED_ZENRYOKU !== "off"; } catch { return false; } })();
type AcceptWhen = { acceptWhen?: { searchExhausted?: string[]; searchExhaustedAsks?: ExamProblem["asks"] } };
function acceptOf(p: { accept: string[] } & AcceptWhen): string[] { return EXHAUSTED_RULE && p.acceptWhen?.searchExhausted?.length ? p.acceptWhen.searchExhausted : p.accept; }
/** 10/09: 全力サポートが正解の時は依頼も AIX の文で応える（spec の acceptWhen.searchExhaustedAsks）。それ以外はそのまま */
function effectiveProblem(p: ExamProblem): ExamProblem {
  const ea = (p as ExamProblem & AcceptWhen).acceptWhen?.searchExhaustedAsks;
  return EXHAUSTED_RULE && p.acceptWhen?.searchExhausted?.length && ea?.length ? { ...p, asks: ea } : p;
}
/** 10/09: 場面の日付のずらしを、お客様の日だけの言い方・竹内さんの実送信・正解（依頼の要点・言ってはいけない事）にも当てる（brain-exam-dates） */
function shiftProblem(p: ExamProblem, days: number): ExamProblem {
  if (!days) return p;
  const atMs = Date.parse(p.at);
  const yr = new Date(atMs + 9 * 3600_000).getUTCFullYear();
  const sh = (t: string, ref = atMs) => shiftExamText(t, days, yr, ref);
  return {
    ...p,
    context: p.context.map((m) => ({ ...m, t: sh(m.t, atMs - m.ago * 60_000) })),
    customer: sh(p.customer), staffText: sh(p.staffText ?? ""),
    asks: (p.asks ?? []).map((a) => ({ ...a, q: sh(a.q), point: sh(a.point) })),
    ng: (p.ng ?? []).map((x) => sh(x)),
  };
}
const OUT = `${RESULTS_DIR}/${LABEL}.jsonl`;
// 条件の行の写しの控え（YUMA は今まで通りの名前・テスト専用の会話は会話の名前で分ける＝他の会話の実行を待たない）
let PC_BACKUP = `scripts/.replay-out/.brain-exam-${LABEL}-yuma-pc-backup.json`;
const LEDGER_OWN_FILE = `scripts/.replay-out/.brain-exam-${LABEL}-ledger-ids.json`;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ?? "");
let h: LlmTestHarness | null = null;
let own: string[] = [];
let ownLedger: Record<string, string[]> = {};
let pcRestore: { id: string; row: Record<string, unknown> } | null = null;
const judgeCost = { calls: 0, usd: 0, fail: 0 };

type Verdict = { code: string; acceptHit: string | null; mustNotHit: string | null; ok: boolean };
type ResultRow = {
  id: string; rep: number; type: string; tags: string[]; label: string; model: string; at: string; layer?: string;
  brain: Record<string, unknown> | null; path: Verdict;
  asks: Array<{ q: string; covered: boolean; why: string; /** 10/09: 答え方（返信／約束／AIX の区別）だけ合うか（要点は見ない） */ route?: boolean }> | null; ng: Array<{ text: string; violated: boolean; why: string }> | null;
  score: ProblemScore; error?: string;
  /** 10/09: LLM が最初に出した答え（決まりで直される前）と、その道 */
  raw?: Record<string, unknown> | null; essence?: Verdict | null;
  /** 10/09: 判断の出どころ（決まり・補正・信号）。brain-core の meta にある物だけ */
  trace?: Record<string, unknown>;
  /** 10/09: 下書き（--draft） */
  draft?: { text: string | null; skipped?: string; code: string; ok: boolean; asks: boolean[] | null; ng: boolean[] | null; pass: boolean } | null;
  ledger?: { inserted: Record<string, number>; errors: string[] };
  pcMismatch?: string[];
};

// ─── YUMA の写し（yuma-r10-brain-replay と同じ線） ─────────────────────────
function floorFile(): string { return String(process.env.REPLAY_FLOOR_FILE ?? ""); }
function writeFloor(floor: string | null) {
  writeFileSync(floorFile(), JSON.stringify(floor ? { conversationId: CONV, floor, status: "proposing", messageIdPrefix: PREFIX, keepPropertyCustomer: true } : {}));
}
async function waitOtherPcCopies(maxMin = 240) {
  const deadline = Date.now() + maxMin * 60_000;
  let n = 0;
  for (;;) {
    // 2026-10-09: 同じ会話の写しだけ待つ（YUMA は今まで通り -yuma-pc-backup・テスト専用の会話は -yuma2-pc-backup 等）
    const re = CONV_TAG === "yuma" ? /^\..*-yuma-pc-backup\.json$/ : new RegExp(`^\\..*-${CONV_TAG}-pc-backup\\.json$`);
    const busy = readdirSync("scripts/.replay-out").filter((f) => re.test(f) && `scripts/.replay-out/${f}` !== PC_BACKUP)
      .filter((f) => { try { return readFileSync(`scripts/.replay-out/${f}`, "utf8").trim().length > 0; } catch { return false; } });
    if (!busy.length) return;
    if (Date.now() > deadline) throw new Error(`他の担当の再生が YUMA の条件の行を写したまま（${busy.join(",")}）`);
    // 10/09: 他の担当の試験は問題ごとに条件の行を戻す（数秒だけ空く）→ 60秒おきに見ると隙間を逃して待ち続ける。2〜3秒おきに見る（ログは1分に1回）
    if (n++ % 25 === 0) console.warn(`  … 他の担当の再生が YUMA の条件の行を写し中（${busy.join(",")}）→ 空くまで待ちます`);
    await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 1000)));
  }
}
async function yumaPcId(): Promise<string> {
  const { data } = await sb.from("conversations").select("property_customer_id").eq("id", CONV).maybeSingle();
  const id = (data?.property_customer_id as string | null) ?? null; if (!id) throw new Error(`${lease?.name ?? "YUMA"} の条件の行が無い${CONV === YUMA ? "" : "（テスト専用の会話の行を SQL で作ってから・memory/test_protocol_brain.md 9.7）"}`); return id;
}
async function pcFields(): Promise<readonly string[]> { return (await import("./brain-exam-add")).PC_FIELDS; }
function pcPatchOf(pc: Record<string, unknown> | null): Record<string, unknown> {
  const blank = Object.fromEntries(Object.keys(pcRestore?.row ?? {}).map((k) => [k, null]));
  const patch: Record<string, unknown> = { ...blank, ...(pc ?? {}) };
  if (patch.property_send_count === null) patch.property_send_count = 0;
  return patch;
}
async function writePc(yumaPc: string, pc: Record<string, unknown> | null) {
  if (!pcRestore) {
    const { data } = await sb.from("property_customers").select((await pcFields()).join(", ")).eq("id", yumaPc).maybeSingle();
    pcRestore = { id: yumaPc, row: (data ?? {}) as unknown as Record<string, unknown> };
    writeFileSync(PC_BACKUP, JSON.stringify(pcRestore));
  }
  const { error } = await sb.from("property_customers").update(pcPatchOf(pc)).eq("id", yumaPc);
  if (error) throw new Error(`条件の行の写し: ${error.message}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (typeof a === "number" && Number(a) === Number(b)) || (typeof b === "number" && Number(a) === Number(b));
/** 10/09 ③: 写した条件の行を読み直して確かめる（前の実行のブレインが要約を遅れて書き戻すと混ざる）。違う列の名前を返す */
async function verifyPc(yumaPc: string, want: Record<string, unknown>): Promise<string[]> {
  const { data } = await sb.from("property_customers").select(Object.keys(want).join(", ")).eq("id", yumaPc).maybeSingle();
  const row = (data ?? {}) as unknown as Record<string, unknown>;
  return Object.keys(want).filter((k) => !same(row[k], want[k]) && !(/_at$/.test(k) && want[k] && row[k] && Date.parse(String(row[k])) === Date.parse(String(want[k]))));
}
async function restorePc() {
  if (!pcRestore) return;
  const r = await sb.from("property_customers").update(pcRestore.row).eq("id", pcRestore.id);
  if (r.error) { console.error(`⛔ YUMA の条件の行を戻せない（控え ${PC_BACKUP} に残す）: ${r.error.message}`); return; }
  // 遅れて来る要約の書き戻しで上書きされていないか確かめる
  await new Promise((res) => setTimeout(res, 1500));
  const diff = await verifyPc(pcRestore.id, pcRestore.row);
  if (diff.length) { await sb.from("property_customers").update(pcRestore.row).eq("id", pcRestore.id); console.warn(`  条件の行を戻した後に書き戻しがあったので戻し直した（${diff.join(",")}）`); }
  writeFileSync(PC_BACKUP, ""); pcRestore = null;
}

// ─── 10/09 ① 台帳の写し ───────────────────────────────────────────────
const LEDGER_ORDER = ["aix_usage_logs", "estimate_records", "sent_properties", "property_pickups", "viewings", "viewing_history", "sent_facts"] as const;
function saveOwnLedger() { writeFileSync(LEDGER_OWN_FILE, JSON.stringify(ownLedger)); }
async function deleteOwnLedger() {
  for (const [t, ids] of Object.entries(ownLedger)) {
    if (!ids.length) continue;
    const r = await sb.from(t).delete().in("id", ids);
    if (r.error) console.error(`⛔ 台帳の写し ${t} を消せない（${ids.length}件・控え ${LEDGER_OWN_FILE}）: ${r.error.message}`);
    else ownLedger[t] = [];
  }
  saveOwnLedger();
}
/** 元の時刻（番の何分前か）→ 場面の時刻。その行より前の最後の通の直後に置く（線より後・会話の順を保つ） */
function sceneTimeOf(agoMin: number, ctxAgo: number[], times: string[], k: number): string {
  let i = -1;
  for (let j = 0; j < ctxAgo.length; j++) if (ctxAgo[j] >= agoMin) i = j;
  const base = i < 0 ? Date.parse(times[0]) - 600 : Date.parse(times[i]) + 2000;
  return new Date(base + Math.min(k, 50) * 20).toISOString();
}
async function insertLedger(p: ExamProblem, times: string[], yumaPc: string, shiftDays: number): Promise<{ inserted: Record<string, number>; errors: string[] }> {
  const { LEDGER_TABLES } = await import("./brain-exam-add");
  const inserted: Record<string, number> = {}, errors: string[] = [];
  const ctxAgo = p.context.map((m) => m.ago);
  const atMs = Date.parse(p.at);
  const aixIdMap = new Map<string, string>();
  const shiftDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(Date.parse(v.slice(0, 10) + "T00:00:00Z") + shiftDays * 86_400_000).toISOString().slice(0, 10) + v.slice(10) : v;
  for (const t of LEDGER_ORDER) {
    const rows = (p.ledger?.[t] ?? []) as LedgerRow[];
    if (!rows.length) continue;
    const c = LEDGER_TABLES[t];
    const objs = rows.map((lr, k) => {
      const o: Record<string, unknown> = { ...lr.row };
      const oldId = o.id; delete o.id;
      o.conversation_id = CONV;
      if ("property_customer_id" in o) o.property_customer_id = yumaPc;
      for (const col of c.times) {
        const v = o[col];
        if (typeof v !== "string") continue;
        o[col] = col === c.time ? sceneTimeOf(lr.ago, ctxAgo, times, k) : sceneTimeOf(Math.round((atMs - Date.parse(v)) / 60_000), ctxAgo, times, k);
      }
      for (const col of c.dates ?? []) o[col] = shiftDate(o[col]);
      if (t === "viewings" || t === "viewing_history") { o.pre_announce_sent = true; o.post_announce_sent = true; o.cheer_sent = true; } // 本番の告知の cron に拾わせない
      if ("line_message_id" in o && o.line_message_id) o.line_message_id = `${PREFIX}l-${randomUUID()}`;
      if (t === "estimate_records") o.aix_usage_log_id = o.aix_usage_log_id ? aixIdMap.get(String(o.aix_usage_log_id)) ?? null : null;
      return { o, oldId };
    });
    const r = await sb.from(t).insert(objs.map((x) => x.o)).select("id");
    if (r.error) { errors.push(`${t}: ${r.error.message.slice(0, 120)}`); continue; }
    const ids = ((r.data ?? []) as Array<{ id: string | number }>).map((x) => String(x.id));
    ownLedger[t] = [...(ownLedger[t] ?? []), ...ids]; saveOwnLedger();
    if (t === "aix_usage_logs") objs.forEach((x, i) => { if (x.oldId != null && ids[i]) aixIdMap.set(String(x.oldId), ids[i]); });
    inserted[t] = ids.length;
  }
  return { inserted, errors };
}

// ─── 10/09 ④ LLM が最初に出した答え（決まりで直される前）を控える ─────────────────────
let rawBrainOutputs: Array<Record<string, unknown>> = [];
// 10/09 試しの材料（brain-core を直さずに、試験の側でブレインのプロンプトに足す・既定は何もしない）:
//   BRAIN_EXAM_INJECT_FILE=<json>  … { "*": "全問に足す文", "q001": "その問題だけに足す文" }。ブレインの呼び出し（brain_full/brain_fresh）の最後の user の文に足す
//   BRAIN_EXAM_THINK=<予算トークン> … ブレインの呼び出しで思考を有効にする（DeepSeek の thinking:enabled・難しい場面だけ深く考えさせる試し）
//   使った時は label を別にする（基準と混ぜない）。本番に入れる物は案として報告する
let currentProblemId = "";
const INJECT: Record<string, string> = (() => { const f = process.env.BRAIN_EXAM_INJECT_FILE; if (!f) return {}; try { return JSON.parse(readFileSync(f, "utf8")) as Record<string, string>; } catch (e) { throw new Error(`BRAIN_EXAM_INJECT_FILE が読めない: ${e instanceof Error ? e.message : e}`); } })();
const THINK = Number(process.env.BRAIN_EXAM_THINK ?? "0");
const THINK_IDS = (process.env.BRAIN_EXAM_THINK_ONLY ?? "").split(",").filter(Boolean);
const injectStats = { calls: 0, chars: 0 };
function injectBody(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  const add = [INJECT["*"], INJECT[currentProblemId]].filter(Boolean).join("\n\n");
  const think = THINK > 0 && (!THINK_IDS.length || THINK_IDS.includes(currentProblemId));
  if (!add && !think) return init;
  try {
    const b = JSON.parse(init.body) as { messages?: Array<{ role: string; content: unknown }>; thinking?: unknown; max_tokens?: number };
    if (add && b.messages?.length) {
      const last = [...b.messages].reverse().find((m) => m.role === "user");
      if (last) {
        const block = `\n\n【試験の追加の材料（判断の手本・判断表）】\n${add}`;
        if (typeof last.content === "string") last.content += block;
        else if (Array.isArray(last.content)) (last.content as Array<Record<string, unknown>>).push({ type: "text", text: block });
        injectStats.calls++; injectStats.chars += add.length;
      }
    }
    if (think) { b.thinking = { type: "enabled", budget_tokens: THINK }; b.max_tokens = Math.max(b.max_tokens ?? 0, THINK + 6000); }
    return { ...init, body: JSON.stringify(b) };
  } catch { return init; }
}
function installRawBrainCapture() {
  const prev = globalThis.fetch;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const hv0 = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-sumora-llm-action");
    if (hv0 && /^brain_(?:full|fresh|fresh_claude)$/.test(hv0)) init = injectBody(init);
    const res = await prev(input as never, init);
    try {
      const hv = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-sumora-llm-action");
      if (hv && /^brain_(?:full|fresh|fresh_claude)$/.test(hv)) {
        const j = await res.clone().json() as { content?: Array<{ type: string; text?: string }> };
        const text = j.content?.find((c) => c.type === "text")?.text ?? "";
        const fb = text.indexOf("{"), lb = text.lastIndexOf("}");
        if (fb >= 0 && lb > fb) { try { rawBrainOutputs.push({ ...(JSON.parse(text.slice(fb, lb + 1)) as Record<string, unknown>), _call: hv }); } catch { /* 読めない時は控えない */ } }
      }
    } catch { /* 控えるだけ・失敗しても本体は止めない */ }
    return res;
  }) as typeof fetch;
  globalThis.fetch = wrapped;
}
// 10/09: ブレインの出力では AIX の種類は aix の欄（action は「スタッフが次にすべき事」の自由文・reply_mode=aix は「人の確認」の意味）。aix を控えないと本質の道が AIX にならなかった
const RAW_KEYS = ["reply_mode", "aix", "action", "check_pattern", "reply_direction", "key_topics", "avoid_topics", "customer_questions", "next_steps", "reason", "turn_contract", "asks"];
function rawPlanOf(o: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!o) return null;
  return Object.fromEntries(RAW_KEYS.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== "").map((k) => [k, o[k]]));
}
const AIX_KEYS = new Set(["property_recommendation", "property_send", "property_pickup", "property_search", "viewing_invite", "meeting_place", "application_push", "property_check_result", "acknowledge_check", "estimate_sheet", "cost_explain", "cost_breakdown", "condition_hearing", "guarantor_info", "phone_call", "zenryoku_support", "followup_revive"]);
/** 本質の道: LLM が AIX を選んでいれば決まった計算、そうでなければ判定の分類（rawPathCode） */
function codeFromString(c: string): PathCode {
  const s = c.trim();
  if (s.startsWith("AIX:")) { const a = s.slice(4).split("/")[0]; return { codes: [s, `AIX:${aixFamily(a)}`, "AIX"], hard: [s, `AIX:${aixFamily(a)}`, "AIX"], label: s }; }
  if (s.startsWith("2段")) return { codes: [s, "2段"], hard: [s, "2段"], label: s };
  return { codes: [s], hard: [s], label: s };
}

// ─── 判定（DeepSeek を直に・記録の外なので費用はここで数える） ─────────────────
const PLAN_KEYS = ["current_property", "reply_mode", "action", "check_pattern", "alt_actions", "two_stage", "first_contact_pickup", "reply_direction", "key_topics", "avoid_topics", "customer_questions", "next_steps", "reply_opener", "far_move_in", "appeal_timing", "hesitancy_pattern", "customer_concern", "turn_contract", "asks", "request_ledger"] as const;
export function planOf(meta: Record<string, unknown> | null): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const k of PLAN_KEYS) { const v = meta[k]; if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length) && v !== "") out[k] = v; }
  return out;
}
const TRACE_KEYS = ["decision_source", "decision_source_no_aix", "two_stage", "dropped_direction", "scene_evidence", "aix_suppressed_by_accept_rate", "signal_aix_result", "checkpoint_stage", "customer_intent"];
const AIX_JA: Record<string, string> = { property_recommendation: "物件オススメ", property_send: "物件を送る（ピックアップした）", property_pickup: "物件ピックアップ", property_search: "物件検索", viewing_invite: "内覧調整", meeting_place: "待ち合わせ場所（内覧の確定）", application_push: "申込へ", property_check_result: "物件確認した（管理会社に確認した結果）", acknowledge_check: "確認した", estimate_sheet: "見積書送る", cost_explain: "初期費用を説明", cost_breakdown: "初期費用について", condition_hearing: "条件ヒアリング（フォーム）", guarantor_info: "保証会社について", phone_call: "電話をかける", zenryoku_support: "全力サポート", followup_revive: "追客フォロー" };
const ROUTE_JA: Record<string, string> = { reply: "返信の本文で答える", promise: "後でやると約束する返信（確認・見積・ピックアップ・撮影・交渉）", aix: "AIX（スタッフが確かめた事・検索の結果・見積・内覧の段取りを送る）", none: "答えない" };
const PATH_CHOICES = ["返信", "2段:pickup", "2段:check", "2段:estimate", "2段:photo", "なし"];

async function deepseekJson(sys: string, user: string): Promise<Record<string, unknown> | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い（判定に使う）");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../app/lib/llm-price");
  const model = process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, max_tokens: 1400, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(90_000),
      });
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const pr = altPriceOf(model);
      if (pr && j.usage) judgeCost.usd += (((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6) * (pr.peakDouble && isDeepseekPeakAt(new Date()) ? 2 : 1);
      judgeCost.calls++;
      return JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")) as Record<string, unknown>;
    } catch (e) { if (attempt === 1) { judgeCost.fail++; console.warn(`  判定の失敗: ${e instanceof Error ? e.message : e}`); } }
  }
  return null;
}
function contextText(p: ExamProblem) {
  const lastStaff = [...p.context].reverse().filter((m) => m.s === "staff").slice(0, 2).reverse().map((m) => `${m.aix ? "【AIX】" : ""}${m.t}`.slice(0, 300));
  return `【お客様の今の発言（連投）】\n${p.customer}\n\n【直前のこちらの送信】\n${lastStaff.join("\n―\n") || "（なし＝初回）"}`;
}
function asksNgText(p: ExamProblem) {
  return `【正解の依頼の一覧】\n${(p.asks ?? []).map((a, i) => `${i + 1}. 「${a.q}」→ 答え方: ${[a.route, ...(a.routes ?? []).filter((r) => r !== a.route)].map((r) => ROUTE_JA[r]).join(" または ")}／要点: ${a.point}`).join("\n") || "（なし）"}\n\n【言ってはいけない事】\n${(p.ng ?? []).map((x, i) => `${i + 1}. ${x}`).join("\n") || "（なし）"}`;
}
type JudgeOut = { asks: boolean[]; asksWhy: string[]; ng: boolean[]; ngWhy: string[]; rawPath: string | null; route: boolean[] };
/** 答案（最終）の依頼・言ってはいけない事＋本質の答え（LLM の最初の出力）の道の分類 */
const maj = (xs: boolean[]) => xs.filter(Boolean).length * 2 > xs.length;
const modeOf = <T,>(xs: T[]): T | null => { const c = new Map<T, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); let best: T | null = null, n = 0; for (const [k, v] of c) if (v > n) { best = k; n = v; } return best; };
/** 10/09: 判定を JUDGE_REPEAT 回して過半数（依頼・答え方・言ってはいけない事は項目ごと・本質の道は多数） */
async function judge(p: ExamProblem, meta: Record<string, unknown> | null, raw: Record<string, unknown> | null, needRawPath: boolean): Promise<JudgeOut | null> {
  const outs: JudgeOut[] = [];
  for (let k = 0; k < JUDGE_REPEAT; k++) { const o = await judgeOnce(p, meta, raw, needRawPath); if (o) outs.push(o); }
  if (!outs.length) return null;
  if (outs.length === 1) return outs[0];
  const col = (f: (o: JudgeOut) => boolean[], n: number) => Array.from({ length: n }, (_, i) => maj(outs.map((o) => f(o)[i])));
  const na = (p.asks ?? []).length, nn = (p.ng ?? []).length;
  return { asks: col((o) => o.asks, na), route: col((o) => o.route, na), ng: col((o) => o.ng, nn), asksWhy: outs[0].asksWhy.map((w, i) => `${w}（判定 ${outs.filter((o) => o.asks[i]).length}/${outs.length}）`), ngWhy: outs[0].ngWhy, rawPath: modeOf(outs.map((o) => o.rawPath)) };
}
async function judgeOnce(p: ExamProblem, meta: Record<string, unknown> | null, raw: Record<string, unknown> | null, needRawPath: boolean): Promise<JudgeOut | null> {
  const asks = p.asks ?? [], ng = p.ng ?? [];
  if (!asks.length && !ng.length && !needRawPath) return { asks: [], asksWhy: [], ng: [], ngWhy: [], rawPath: null, route: [] };
  const plan = planOf(meta);
  const act = String(plan.action ?? "");
  const sys = [
    "あなたは賃貸仲介の LINE 接客で『次の一手を決める AI（ブレイン）』の答案を採点する係です。",
    "ブレインの答案は JSON（reply_mode=aix なら action の AIX をスタッフが送る番／two_stage は約束の返信の種類／reply_direction は返信の方向／key_topics は返信に必ず入れる事／avoid_topics は言わない事／customer_questions はお客様の質問の一覧／turn_contract・asks があればこの番の依頼の一覧と答え方）。",
    "採点は推測で甘くしない。答案のどこにも書かれていない事は『入っていない』。",
    "① asks: 正解の依頼ごとに、答案がその依頼を『正解の答え方』で扱う指示になっているか（covered）。",
    "  - 答え方 reply: 返信の中で答える指示がある（要点と食い違わない）。確認すると約束して答えを保留する指示なら false。",
    "  - 答え方 promise: 後でやる（確認・見積・ピックアップ・撮影・交渉）と約束する指示がある。約束の中身が要点と違えば false。",
    "  - 答え方 aix: 答案の AIX（action/alt_actions）がその依頼に合う種類か、方向がその AIX で応えると言っている。",
    "  - 要点に具体の中身（時間・金額・仕組み）がある時、答案がそれと食い違う中身を指示していたら false。中身が無くても『答える』指示があれば true。",
    "  - route: 要点の中身は見ずに、答え方（reply＝返信の本文で答える／promise＝後でやると約束する／aix＝AIX で応える／none＝触れない）の区別だけが正解と同じか。",
    "② ng: 正解の『言ってはいけない事』ごとに、答案がそれを言う／する指示になっているか（violated）。はっきり指示している時だけ true。",
    `③ raw_path: 【LLM の最初の答え】（決まりで直される前）が、この番の返信をどの道にしようとしていたかを1つ選ぶ: ${PATH_CHOICES.join(" / ")}（返信＝約束なしで答える／2段:〇＝後で送る・確認する約束の返信／なし＝お客様の連絡待ちで送らない）。【LLM の最初の答え】が無ければ null。`,
    '出力は JSON だけ: {"asks":[{"i":1,"route":true,"covered":true,"why":"20字"}],"ng":[{"i":1,"violated":false,"why":"20字"}],"raw_path":"返信"}',
  ].join("\n");
  const user = [
    contextText(p),
    `【ブレインの答案（最終）】\n${JSON.stringify(plan, null, 1)}${act ? `\n（AIX の名前: ${AIX_JA[act] ?? act}）` : ""}`,
    `【LLM の最初の答え】\n${needRawPath && raw ? JSON.stringify(raw, null, 1) : "（なし）"}`,
    asksNgText(p),
  ].join("\n\n");
  const o = await deepseekJson(sys, user);
  if (!o) return null;
  const A = (o.asks ?? []) as Array<{ i: number; covered: boolean; route?: boolean; why?: string }>, G = (o.ng ?? []) as Array<{ i: number; violated: boolean; why?: string }>;
  const a = asks.map((_, i) => A.find((x) => x.i === i + 1)), g = ng.map((_, i) => G.find((x) => x.i === i + 1));
  if (a.some((x) => !x) || g.some((x) => !x)) { judgeCost.fail++; return null; }
  const rp = typeof o.raw_path === "string" && PATH_CHOICES.includes(o.raw_path) ? o.raw_path : null;
  // 要点が合えば答え方も合う（covered ⇒ route）
  return { asks: a.map((x) => !!x!.covered), route: a.map((x) => !!x!.covered || x!.route !== false), asksWhy: a.map((x) => String(x!.why ?? "")), ng: g.map((x) => !!x!.violated), ngWhy: g.map((x) => String(x!.why ?? "")), rawPath: rp };
}
/** 下書きの判定（道の分類・依頼・言ってはいけない事） */
async function judgeDraft(p: ExamProblem, draft: string): Promise<{ code: string; asks: boolean[]; ng: boolean[] } | null> {
  const outs: Array<{ code: string; asks: boolean[]; ng: boolean[] }> = [];
  for (let k = 0; k < JUDGE_REPEAT; k++) { const o = await judgeDraftOnce(p, draft); if (o) outs.push(o); }
  if (outs.length <= 1) return outs[0] ?? null;
  return { code: modeOf(outs.map((o) => o.code)) ?? "返信", asks: (p.asks ?? []).map((_, i) => maj(outs.map((o) => o.asks[i]))), ng: (p.ng ?? []).map((_, i) => maj(outs.map((o) => o.ng[i]))) };
}
async function judgeDraftOnce(p: ExamProblem, draft: string): Promise<{ code: string; asks: boolean[]; ng: boolean[] } | null> {
  const sys = [
    "あなたは賃貸仲介の LINE 接客で、AI が書いた返信の下書きを採点する係です。推測で甘くしない。",
    `① path: 下書きの道を1つ: ${PATH_CHOICES.filter((x) => x !== "なし").join(" / ")}（返信＝約束なしで答える／2段:pickup＝お部屋をピックアップして送ると約束／2段:check＝確認すると約束／2段:estimate＝見積書を作って送ると約束／2段:photo＝撮影して送ると約束）。複数の約束がある時は一番主な物。`,
    "② asks: 正解の依頼ごとに、下書きがその依頼に正解の答え方で応えているか（covered）。答えを保留して確認の約束にしていたら reply の依頼は false。",
    "③ ng: 正解の『言ってはいけない事』を下書きが言っているか（violated）。",
    '出力は JSON だけ: {"path":"返信","asks":[{"i":1,"covered":true}],"ng":[{"i":1,"violated":false}]}',
  ].join("\n");
  const o = await deepseekJson(sys, `${contextText(p)}\n\n【下書き】\n${draft}\n\n${asksNgText(p)}`);
  if (!o) return null;
  const A = (o.asks ?? []) as Array<{ i: number; covered: boolean }>, G = (o.ng ?? []) as Array<{ i: number; violated: boolean }>;
  const code = typeof o.path === "string" && PATH_CHOICES.includes(o.path) ? o.path : "返信";
  return { code, asks: (p.asks ?? []).map((_, i) => !!A.find((x) => x.i === i + 1)?.covered), ng: (p.ng ?? []).map((_, i) => !!G.find((x) => x.i === i + 1)?.violated) };
}
function parseStream(raw: string): string {
  let body = String(raw ?? "");
  const nl = body.indexOf("\n");
  if (nl >= 0) { try { const j = JSON.parse(body.slice(0, nl)); if (j && typeof j === "object") body = body.slice(nl + 1); } catch { /* */ } }
  return body.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
}

// ─── 集計 ─────────────────────────────────────────────────────────────
function readResults(label: string): ResultRow[] {
  const f = `${RESULTS_DIR}/${label}.jsonl`;
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ResultRow) : [];
}
/** 問題ごとに回を束ねる（合格は全ての回の過半数が合格・道も同じ） */
function perProblem(rows: ResultRow[]) {
  const m = new Map<string, ResultRow[]>();
  for (const r of rows) { if (r.error) continue; m.set(r.id, [...(m.get(r.id) ?? []), r]); }
  return [...m].map(([id, rs]) => {
    const pass = rs.filter((r) => r.score.pass).length, path = rs.filter((r) => r.score.path).length;
    const asksHit = rs.reduce((s, r) => s + (r.score.asks?.hit ?? 0), 0), asksN = rs.reduce((s, r) => s + (r.score.asks?.n ?? 0), 0);
    const ngOk = rs.reduce((s, r) => s + (r.score.ng?.ok ?? 0), 0), ngN = rs.reduce((s, r) => s + (r.score.ng?.n ?? 0), 0);
    const ess = rs.filter((r) => r.essence).length, essOk = rs.filter((r) => r.essence?.ok).length;
    const dr = rs.filter((r) => r.draft), drOk = rs.filter((r) => r.draft?.pass).length, drPath = rs.filter((r) => r.draft?.ok).length;
    // 10/09 物差しを分ける: 道（過半数）／依頼の答え方（道＋全部の依頼の答え方＋言ってはいけない事・要点は見ない）／要点（旧の合格）／下書きの要点
    const routeOk = (r: ResultRow) => r.score.path && (!r.asks || r.asks.every((a) => a.route ?? a.covered)) && (!r.ng || !r.ng.some((g) => g.violated));
    const routeN = rs.filter(routeOk).length;
    return { id, type: rs[0].type, tags: rs[0].tags, n: rs.length, pass: pass * 2 > rs.length, passN: pass, pathN: path, pathMaj: path * 2 > rs.length, routeN, routeMaj: routeN * 2 > rs.length, routeKnown: rs.some((r) => r.asks?.some((a) => a.route !== undefined)), drMaj: dr.length ? drOk * 2 > dr.length : null, asksHit, asksN, ngOk, ngN, ess: ess, essOk, dr: dr.length, drOk, drPath, codes: [...new Set(rs.map((r) => r.path.code))], rows: rs };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
/** 保存した答案を今の正解（出し切りの決まりの切り替え・spec の直し）で採点し直す（asks・言ってはいけない事の判定はそのまま） */
function rescore(rows: ResultRow[], probs: Map<string, ExamProblem>): ResultRow[] {
  return rows.map((r) => {
    const p = probs.get(r.id);
    if (!p || r.error || !r.brain) return r;
    const acc = acceptOf(p), mn = p.mustNot ?? [];
    const pv = judgePath(brainPathCode(r.brain as BrainExamOutput), acc, mn);
    const asks = r.asks ? r.asks.map((a) => a.covered) : null, ng = r.ng ? r.ng.map((g) => g.violated) : null;
    const essence = r.essence ? (() => { const v = judgePath(codeFromString(r.essence!.code), acc, mn); return { ...r.essence!, acceptHit: v.acceptHit, mustNotHit: v.mustNotHit, ok: v.ok }; })() : r.essence;
    const draft = r.draft ? (() => { const v = judgePath(codeFromString(r.draft!.code), acc, mn); return { ...r.draft!, ok: v.ok, pass: v.ok && (!r.draft!.asks || r.draft!.asks.every(Boolean)) && (!r.draft!.ng || !r.draft!.ng.some(Boolean)) }; })() : r.draft;
    return { ...r, path: { ...r.path, acceptHit: pv.acceptHit, mustNotHit: pv.mustNotHit, ok: pv.ok }, score: problemScore(pv, asks, ng), essence, draft };
  });
}
function summarize(label: string, baseline: string | null): string {
  const probs = existsSync(PROBLEMS_FILE) ? new Map((JSON.parse(readFileSync(PROBLEMS_FILE, "utf8")) as ExamProblem[]).map((p) => [p.id, effectiveProblem(p)])) : new Map<string, ExamProblem>();
  const rows = rescore(readResults(label), probs);
  const pp = perProblem(rows);
  const L: string[] = [];
  const pct = (a: number, b: number) => `${a}/${b}（${b ? Math.round((a / b) * 100) : 0}%）`;
  const model = [...new Set(rows.map((r) => r.model))].join(",");
  const errs = rows.filter((r) => r.error);
  const metaFile = `${RESULTS_DIR}/${label}.meta.json`;
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown> : null;
  L.push(`（出し切りの決まり: ${EXHAUSTED_RULE ? "search-exhausted あり＝全力サポートだけ正解" : "search-exhausted なし＝新着待ちの返信か全力サポート"}）`);
  if (meta) L.push(`（構成: 層=${meta.layer}・台帳=${meta.ledger ? "写す" : "写さない"}・下書き=${meta.draft ? "あり" : "なし"}・開始 ${meta.startedAt}・HEAD ${meta.head}${meta.floorGaps ? `・線の表に無い YUMA の行 ${JSON.stringify(meta.floorGaps)}` : ""}）`);
  L.push(`# ブレインの試験 ${label}（${model}・問題 ${pp.length}・回 ${rows.length - errs.length}${errs.length ? `・失敗 ${errs.length}` : ""}）`);
  const totalPass = pp.filter((p) => p.pass).length;
  const aH = pp.reduce((s, p) => s + p.asksHit, 0), aN = pp.reduce((s, p) => s + p.asksN, 0);
  const gO = pp.reduce((s, p) => s + p.ngOk, 0), gN = pp.reduce((s, p) => s + p.ngN, 0);
  const pathAll = pp.reduce((s, p) => s + p.pathN, 0), runAll = pp.reduce((s, p) => s + p.n, 0);
  const essN = pp.reduce((s, p) => s + p.ess, 0), essOk = pp.reduce((s, p) => s + p.essOk, 0);
  const drN = pp.reduce((s, p) => s + p.dr, 0), drOk = pp.reduce((s, p) => s + p.drOk, 0), drPath = pp.reduce((s, p) => s + p.drPath, 0);
  L.push(`合格（道・依頼・言ってはいけない事が全部）: ${pct(totalPass, pp.length)}｜最終の道: ${pct(pathAll, runAll)}｜依頼が入った: ${pct(aH, aN)}｜言ってはいけない事を守った: ${pct(gO, gN)}`);
  {
    const pc2 = (f: (p: (typeof pp)[number]) => boolean, ps2 = pp) => pct(ps2.filter(f).length, ps2.length);
    const known = pp.filter((p) => p.routeKnown || !(p.rows[0].asks ?? []).length);
    const drs = pp.filter((p) => p.drMaj !== null);
    const nRep = Math.max(...pp.map((p) => p.n), 1);
    L.push(`物差し（目標90%は①道と②答え方・③④は文の中身の参考。問題ごと${nRep > 1 ? `・${nRep}回の過半数` : "・1回"}${JUDGE_REPEAT > 1 ? `・判定 ${JUDGE_REPEAT}回の過半数` : ""}）: ①道 ${pc2((p) => p.pathMaj)}｜②依頼の答え方（道＋依頼ごとに返信／約束／AIX の区別＋言ってはいけない事・要点は見ない）${!pp.some((p) => p.routeKnown) ? "-（この回は答え方の判定なし＝10/09 より前）" : known.length === pp.length ? pc2((p) => p.routeMaj) : `${pc2((p) => p.routeMaj, known)}（答え方の判定がある ${known.length} 問）`}｜③要点まで（旧の合格）${pc2((p) => p.pass)}｜④下書きの要点（返信・2段が正解の問題）${drs.length ? pct(drs.filter((p) => p.drMaj).length, drs.length) : "-"}`);
  }
  if (essN || drN) L.push(`3段: 本質の道（LLM の最初の答え）${pct(essOk, essN)} → 最終の道 ${pct(pathAll, runAll)}${drN ? ` → 下書き（返信・2段が正解の問題）道 ${pct(drPath, drN)}・合格 ${pct(drOk, drN)}` : ""}`);
  // 2026-10-09 主語の抜け: spec の property（今の番の物件の正解）がある問題だけ、ブレインの current_property を照らす
  const propRows = pp.map((p) => ({ p, want: probs.get(p.id)?.property, have: (p.rows[p.rows.length - 1].brain as Record<string, unknown> | null)?.current_property as string | undefined }))
    .filter((x) => !!x.want);
  if (propRows.length) {
    const ok = propRows.filter((x) => judgeCurrentProperty(x.want, x.have, similarity) === true);
    L.push(`今の番の物件（current_property・正解のある ${propRows.length}問）: ${pct(ok.length, propRows.length)}${propRows.filter((x) => !ok.includes(x)).map((x) => ` ✕${x.p.id}=${x.have ?? "null"}（正解 ${x.want}）`).join("").slice(0, 400)}`);
  }
  L.push(`\n## 型ごと（合格／最終の道／依頼${essN ? "／本質の道" : ""}${drN ? "／下書きの合格" : ""}）`);
  const rt = rateByType(pp.map((p) => ({ type: p.type, tags: p.tags, score: { path: p.pathN * 2 > p.n, asks: { hit: p.asksHit, n: p.asksN }, ng: null, pass: p.pass } })));
  for (const t of rt) {
    const ofType = pp.filter((p) => (t.type.startsWith("（札）") ? (p.tags ?? []).includes(t.type.slice(4)) : p.type === t.type));
    const e = ofType.reduce((s, p) => s + p.essOk, 0), en = ofType.reduce((s, p) => s + p.ess, 0), d = ofType.reduce((s, p) => s + p.drOk, 0), dn = ofType.reduce((s, p) => s + p.dr, 0);
    L.push(`  ${t.type.padEnd(16, "　")} 合格 ${pct(t.pass, t.n)}・道 ${pct(t.path, t.n)}・依頼 ${pct(t.asksHit, t.asksN)}${en ? `・本質 ${pct(e, en)}` : ""}${dn ? `・下書き ${pct(d, dn)}` : ""}`);
  }
  const lost = pp.filter((p) => p.rows.some((r) => r.essence?.ok && !r.path.ok));
  if (lost.length) {
    L.push(`\n## 本質は正解・最終で外れ（決まり・補正が LLM の答えを変えた番）${lost.length}`);
    for (const p of lost) { const r = p.rows[p.rows.length - 1]; L.push(`  ${p.id} [${p.type}] 本質=${r.essence?.code} → 最終=${r.path.code}・出どころ=${String(r.trace?.decision_source ?? r.trace?.decision_source_no_aix ?? "-")}${r.trace?.two_stage ? `・2段=${r.trace.two_stage}` : ""}`); }
  }
  const draftLost = pp.filter((p) => p.rows.some((r) => r.path.ok && r.draft && !r.draft.ok));
  if (draftLost.length) {
    L.push(`\n## 最終の道は正解・下書きで外れ（生成の途中で道が変わった番）${draftLost.length}`);
    for (const p of draftLost) { const r = p.rows[p.rows.length - 1]; L.push(`  ${p.id} [${p.type}] 最終=${r.path.code} → 下書き=${r.draft?.code}${r.draft?.skipped ? `（${r.draft.skipped}）` : ""}「${String(r.draft?.text ?? "").replace(/\n/g, "⏎").slice(0, 60)}」`); }
  }
  L.push(`\n## 問題ごと（✕＝不合格）`);
  for (const p of pp) {
    const pr = probs.get(p.id);
    const last = p.rows[p.rows.length - 1];
    const missAsk = last.asks?.filter((a) => !a.covered).map((a) => `「${a.q.slice(0, 24)}」`).join("") ?? "";
    const vio = last.ng?.filter((g) => g.violated).map((g) => `「${g.text.slice(0, 24)}」`).join("") ?? "";
    L.push(`  ${p.pass ? "○" : "✕"} ${p.id} [${p.type}] ${last.essence ? `本質=${last.essence.code} ` : ""}ブレイン=${p.codes.join("/")}${last.draft ? ` 下書き=${last.draft.code}${last.draft.pass ? "○" : "✕"}` : ""}${p.n > 1 ? `（合格 ${p.passN}/${p.n}）` : ""} 正解=${pr ? acceptOf(pr).join("|") : "?"}${last.path.mustNotHit ? ` ⛔${last.path.mustNotHit}` : ""}${missAsk ? ` 抜け${missAsk}` : ""}${vio ? ` 違反${vio}` : ""}${last.ledger?.errors.length ? ` 台帳の写しの失敗${last.ledger.errors.length}` : ""}${last.pcMismatch?.length ? ` 条件の行の混ざり(${last.pcMismatch.join(",")})` : ""}`);
  }
  if (baseline) {
    const bRows = rescore(readResults(baseline), probs);
    const bp = new Map(perProblem(bRows).map((p) => [p.id, p]));
    const bModel = [...new Set(bRows.map((r) => r.model))].join(",");
    const crossModel = bModel !== model;
    const worse = pp.filter((p) => bp.get(p.id)?.pass && !p.pass), better = pp.filter((p) => bp.has(p.id) && !bp.get(p.id)!.pass && p.pass);
    const both = pp.filter((p) => bp.has(p.id));
    const bPath = both.reduce((s, p) => s + bp.get(p.id)!.pathN, 0), bRun = both.reduce((s, p) => s + bp.get(p.id)!.n, 0);
    const bA = both.reduce((s, p) => s + bp.get(p.id)!.asksHit, 0), bAN = both.reduce((s, p) => s + bp.get(p.id)!.asksN, 0);
    L.push(`\n## 前との物差し: 道 ${both.filter((p) => bp.get(p.id)!.pathMaj).length} → ${both.filter((p) => p.pathMaj).length}／答え方 ${both.filter((p) => bp.get(p.id)!.routeMaj).length} → ${both.filter((p) => p.routeMaj).length}（${both.length} 問）`);
    L.push(`\n## 前（${baseline}・${bModel}）との比べ${crossModel ? "（モデルが違う＝参考・関所にしない）" : ""}（両方で解いた ${both.length} 問）: 合格 前 ${both.filter((p) => bp.get(p.id)!.pass).length} → 今 ${both.filter((p) => p.pass).length}｜道 前 ${pct(bPath, bRun)} → 今 ${pct(both.reduce((s, p) => s + p.pathN, 0), both.reduce((s, p) => s + p.n, 0))}｜依頼 前 ${pct(bA, bAN)} → 今 ${pct(both.reduce((s, p) => s + p.asksHit, 0), both.reduce((s, p) => s + p.asksN, 0))}`);
    const typesAll = [...new Set(both.map((p) => p.type))];
    L.push(`  型ごとの合格（前→今）: ${typesAll.map((t) => { const x = both.filter((p) => p.type === t); return `${t} ${x.filter((p) => bp.get(p.id)!.pass).length}→${x.filter((p) => p.pass).length}/${x.length}`; }).join("・")}`);
    L.push(`  悪くなった ${worse.length}: ${worse.map((p) => `${p.id}[${p.type}] ${bp.get(p.id)!.codes.join("/")}→${p.codes.join("/")}`).join("、") || "なし"}`);
    L.push(`  良くなった ${better.length}: ${better.map((p) => `${p.id}[${p.type}] ${bp.get(p.id)!.codes.join("/")}→${p.codes.join("/")}`).join("、") || "なし"}`);
    if (worse.length && !crossModel) L.push(`  ⚠ 悪くなった問題がある＝この変更はそのまま入れない（DeepSeek の揺れか、--repeat=3 で回し直して確かめる）`);
  }
  L.push(`\n判定の費用（DeepSeek 直・この回の実行分）: ${judgeCost.calls}回 $${judgeCost.usd.toFixed(4)}${judgeCost.fail ? `・失敗 ${judgeCost.fail}` : ""}`);
  return L.join("\n");
}

// ─── 線のファイルの鍵（同じファイルを2つの実行で使わない） ───────────────────────
const floorLock = () => `${floorFile()}.lock`;
function lockFloor() {
  const f = floorLock();
  if (existsSync(f)) {
    try {
      const o = JSON.parse(readFileSync(f, "utf8")) as { pid: number; label: string };
      let alive = false; try { process.kill(o.pid, 0); alive = o.pid !== process.pid; } catch { alive = false; }
      if (alive) throw new Error(`線のファイル ${floorFile()} を他の実行（label=${o.label}・pid=${o.pid}）が使っている。REPLAY_FLOOR_FILE=scripts/.replay-out/brain-exam-floor-${LABEL}.json のように label ごとに分ける`);
    } catch (e) { if (e instanceof Error && e.message.startsWith("線のファイル")) throw e; }
  }
  writeFileSync(f, JSON.stringify({ pid: process.pid, label: LABEL, at: new Date().toISOString() }));
}
function unlockFloor() { try { const f = floorLock(); if (existsSync(f) && (JSON.parse(readFileSync(f, "utf8")) as { pid: number }).pid === process.pid) writeFileSync(f, ""); } catch { /* */ } }

// ─── 本体 ─────────────────────────────────────────────────────────────
function pick(all: ExamProblem[]): ExamProblem[] {
  let ps = all;
  if (ONLY.length) ps = ps.filter((p) => ONLY.includes(p.id));
  if (TYPES.length) ps = ps.filter((p) => TYPES.includes(p.type) || (p.tags ?? []).some((t) => TYPES.includes(t)));
  if (PER_TYPE > 0) { const c = new Map<string, number>(); ps = ps.filter((p) => { const n = c.get(p.type) ?? 0; if (n >= PER_TYPE) return false; c.set(p.type, n + 1); return true; }); }
  return ps;
}
/** 10/09 ③: 線（REPLAY_FLOOR）の表に無い・YUMA を conversation_id で持つ表の行（ブレインが読むと前の実行の状況が混ざる） */
async function floorGaps(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["deal_outcomes", "outcome_events", "conversation_stage_history"]) {
    const { count } = await sb.from(t).select("id", { count: "exact", head: true }).eq("conversation_id", CONV);
    if (count) out[t] = count;
  }
  return out;
}

async function main() {
  if (!LABEL) throw new Error("--label=<名前> が要る（結果のファイル名・続きからの印）");
  mkdirSync(RESULTS_DIR, { recursive: true });
  if (arg("report")) { const s = summarize(LABEL, BASELINE || null); console.log(s); writeFileSync(`${RESULTS_DIR}/${LABEL}.summary.txt`, s); return; }
  // 2026-10-09: --conv（テスト専用の会話）の時は鍵を取り、線のファイル・条件の写しの控えを会話ごとに分ける（REPLAY_FLOOR_FILE は supabase を読む前に要る＝ここで入れる）
  if (CONV_ARG) {
    lease = acquireTestConversation(CONV_ARG, `brain-exam-${LABEL}`);
    CONV = lease.id; CONV_TAG = lease.tag;
    if (!lease.isYuma) {
      PC_BACKUP = `scripts/.replay-out/.brain-exam-${LABEL}-${CONV_TAG}-pc-backup.json`;
      if (!floorFile()) process.env.REPLAY_FLOOR_FILE = `scripts/.replay-out/brain-exam-floor-${LABEL}-${CONV_TAG}.json`;
    }
    console.log(`テストの会話: ${lease.name}（${CONV}）${lease.lockFile ? `・鍵 ${lease.lockFile}` : ""}・線 ${floorFile()}`);
  }
  if (!floorFile()) throw new Error("REPLAY_FLOOR_FILE=scripts/.replay-out/brain-exam-floor-<label>.json を付けて起動する（YUMA の過去の記録を読まないため・supabase の読み込みより前に要る）");
  // 10/09: 同じ時間に他の担当も試験を回す → 記録の route と線のファイルを label ごとに分ける（同じ線のファイルを2つの実行で使うと、片方の片付けが線を消して YUMA の過去が混ざる）
  lockFloor();
  h = await setupLlmTest(`brain-exam-${LABEL}`.slice(0, 60));
  installRawBrainCapture(); // ← brain-core を読む前に（SDK は読んだ時の fetch を握る）
  const model = h.run === "final-claude" ? "claude（本番のブレイン）" : "deepseek-all";
  const analyzeConversation = (await import("../app/lib/brain-core")).analyzeConversation;
  const { extractStrategy } = await import("../app/lib/brain-layers");
  const { runInDeepseekScope, setDeepseekScope } = await import("../app/lib/deepseek-scope");
  const POST = DRAFT ? (await import("../app/api/generate-reply/route")).POST : null;
  const { MSG_SEP } = await import("../app/lib/reply-context");
  const problems = pick((JSON.parse(readFileSync(PROBLEMS_FILE, "utf8")) as ExamProblem[]).map(effectiveProblem));
  const callsPer = LAYER === "prod" ? 2 : 1;
  if (h.run === "final-claude" && problems.length * REPEAT * callsPer > 20 && !flag("allow-many-claude")) throw new Error(`最後の Claude は場面ごとに1〜2回（今 ${problems.length * REPEAT * callsPer} 回）。--per-type=1 か --only で絞る（全部回すなら --allow-many-claude・費用は1回 $0.04〜0.2）`);
  const gaps = await floorGaps();
  if (Object.keys(gaps).length) console.warn(`⚠ 線の表に無い表に YUMA の行がある（ブレインが読むと混ざる）: ${JSON.stringify(gaps)}`);
  let head = ""; try { head = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* */ }
  writeFileSync(`${RESULTS_DIR}/${LABEL}.meta.json`, JSON.stringify({ conv: lease?.name ?? "YUMA", layer: LAYER, ledger: USE_LEDGER, draft: DRAFT, exhaustedRule: EXHAUSTED_RULE, model, startedAt: new Date().toISOString(), head, floorGaps: Object.keys(gaps).length ? gaps : null, inject: process.env.BRAIN_EXAM_INJECT_FILE ?? null, think: THINK || null }, null, 1));
  console.log(`問題 ${problems.length}・回 ${REPEAT}・${model}・層 ${LAYER}・台帳 ${USE_LEDGER ? "写す" : "写さない"}・下書き ${DRAFT ? "あり" : "なし"}・判定 ${NO_JUDGE ? "なし" : "DeepSeek"}`);
  const yumaPc = await yumaPcId();
  if (existsSync(PC_BACKUP) && readFileSync(PC_BACKUP, "utf8").trim()) {
    const bk = JSON.parse(readFileSync(PC_BACKUP, "utf8")) as { id: string; row: Record<string, unknown> };
    const r = await sb.from("property_customers").update(bk.row).eq("id", bk.id);
    if (r.error) throw new Error(`前回の控えから YUMA の条件の行を戻せない: ${r.error.message}`);
    writeFileSync(PC_BACKUP, ""); console.warn("=== 前回の控えから YUMA の条件の行を戻した ===");
  }
  if (existsSync(LEDGER_OWN_FILE)) { ownLedger = JSON.parse(readFileSync(LEDGER_OWN_FILE, "utf8") || "{}"); await deleteOwnLedger(); }
  if (!existsSync(OUT)) writeFileSync(OUT, "");
  const done = new Set(readResults(LABEL).filter((r) => !r.error).map((r) => `${r.id}#${r.rep}`));
  const savedClock = process.env.TEST_CLOCK_JST_HOUR;
  const runBrain = (o: Parameters<typeof analyzeConversation>[5], pcOn: boolean) => runInDeepseekScope(async () => {
    setDeepseekScope({ conversationId: CONV, mark: { kind: "all" } });
    return analyzeConversation(CONV, true, "proposing", pcOn ? yumaPc : null, "brain", o);
  }) as unknown as Promise<Record<string, unknown> | null>;
  // 10/09（q060 の条件の行の混ざり）: 写した後でも、ブレインを回す間に他の担当が YUMA の条件の行を書き換えることがある。
  //   回す直前に読み直して違えば写し直す（ensurePc）・回した後にも読み直し（要約の書き戻しの列は除く）、違えばその問題を回し直す（最大2回）
  const PC_SELF_WRITE = new Set(["ai_summary", "ai_summary_json", "ai_summary_at", "personality_profile"]);
  let curPc: Record<string, unknown> | null = null;
  const pcDiff = async () => (await verifyPc(yumaPc, pcPatchOf(curPc))).filter((k) => !PC_SELF_WRITE.has(k));
  const ensurePc = async () => { let d = await pcDiff(); for (let k = 0; k < 2 && d.length; k++) { await writePc(yumaPc, curPc); /* 他の担当を待たない（互いに控えを持ったまま待つと詰まる） */ await new Promise((r) => setTimeout(r, 800)); d = await pcDiff(); } return d; };
  const runBrainChecked = async (o: Parameters<typeof analyzeConversation>[5], pcOn: boolean, row: ResultRow) => {
    const before = await ensurePc();
    const out = await runBrain(o, pcOn);
    // 回した後の違いはブレイン自身の条件の書き戻し（発言から条件を拾って property_customers に書く）が主＝混ざりとは数えず、印だけ残す。次の呼び出しの前に ensurePc が写し直す
    const after = await pcDiff();
    if (before.length) row.pcMismatch = [...new Set([...(row.pcMismatch ?? []), ...before])];
    if (after.length) (row as ResultRow & { pcWriteback?: string[] }).pcWriteback = [...new Set([...((row as ResultRow & { pcWriteback?: string[] }).pcWriteback ?? []), ...after])];
    return out;
  };
  const pcRetries = new Map<string, number>();
  for (const p of problems) for (let rep = 1; rep <= REPEAT; rep++) {
    if (done.has(`${p.id}#${rep}`)) continue;
    const row: ResultRow = { id: p.id, rep, type: p.type, tags: p.tags ?? [], label: LABEL, model, layer: LAYER, at: new Date().toISOString(), brain: null, path: { code: "", acceptHit: null, mustNotHit: null, ok: false }, asks: null, ng: null, score: { path: false, asks: null, ng: null, pass: false } };
    const acc = acceptOf(p), mn = p.mustNot ?? [];
    currentProblemId = p.id;
    curPc = p.pc;
    try {
      const jd = (x: number) => Math.floor((x + 9 * 3600_000) / 86_400_000);
      const diffDays = jd(Date.now()) - jd(Date.parse(p.at)); const shiftDays = diffDays <= 0 || (p as ExamProblem & { noDateShift?: boolean }).noDateShift ? 0 : Math.ceil(diffDays / 7) * 7; // 曜日を変えない（scenario-date-shift.shiftDaysFor と同じ）。10/09: 月の家賃の計算の問題（q060）はずらすと月の言い方（11月分・12月分）と食い違う＝spec の noDateShift
      // 10/09: 日付のずらしを会話・お客様の日だけの言い方・正解（要点・言ってはいけない事）に同じく当てる。判定にはずらした問題（ps）を渡す
      const ps = shiftProblem(p, shiftDays);
      const texts = ps.context.map((m) => m.t);
      h.assertSceneSafe(texts, p.id);
      await waitOtherPcCopies();
      await h.waitUntilYumaQuiet(own, { maxWaitMin: 120, conversationId: CONV });
      await waitOtherPcCopies();
      await writePc(yumaPc, p.pc);
      // 10/09 ③ 読み直して確かめる（前の実行の要約の書き戻しが遅れて来ると混ざる）
      await new Promise((r) => setTimeout(r, 800));
      let mism = await verifyPc(yumaPc, pcPatchOf(p.pc));
      if (mism.length) { await writePc(yumaPc, p.pc); await new Promise((r) => setTimeout(r, 800)); mism = await verifyPc(yumaPc, pcPatchOf(p.pc)); }
      if (mism.length) row.pcMismatch = mism;
      const times = h.sceneTimes(texts.length, { stepSec: 90 });
      // 連投の始まり（最後のお客様の通のまとまり）
      let burst = p.context.length; while (burst - 1 >= 0 && p.context[burst - 1].s === "customer") burst--;
      const insertMsgs = async (from: number, to: number) => {
        if (to <= from) return;
        const ins = await sb.from("messages").insert(p.context.slice(from, to).map((m, k) => ({ conversation_id: CONV, sender: m.s, text: texts[from + k] || "[画像]", is_aix_generated: m.aix, line_message_id: `${PREFIX}${randomUUID()}`, created_at: times[from + k] }))).select("id");
        if (ins.error) throw new Error(ins.error.message);
        own = [...own, ...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id)];
      };
      writeFloor(new Date(Date.parse(times[0]) - 1000).toISOString());
      if (USE_LEDGER) row.ledger = await insertLedger(p, times, yumaPc, shiftDays);
      process.env.TEST_CLOCK_JST_HOUR = String(p.hourJst);
      if (CONV === YUMA) h.assertYuma(CONV, "brain"); else h.assertTestConversation(CONV, "brain");
      const base = { autoSendEnabled: true, customerName: "YUMA" };
      let meta: Record<string, unknown> | null = null;
      const prodOk = LAYER === "prod" && burst > 0 && p.context.slice(0, burst).some((m) => m.s === "customer");
      if (prodOk) {
        // ② 本番と同じ2層: その番の前までの会話で全体の分析（戦略の層）→ 今回の発言の層に戦略・前回の AIX・前回の判断を渡す
        await insertMsgs(0, burst);
        await new Promise((r) => setTimeout(r, 1300));
        rawBrainOutputs = [];
        const m0 = await runBrainChecked({ ...base, prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null }, !!p.pc, row);
        const strategy = m0 ? extractStrategy(m0, "combined", 0, new Date().toISOString()) : null;
        await insertMsgs(burst, p.context.length);
        await new Promise((r) => setTimeout(r, 1300));
        for (let attempt = 0; attempt < 2 && !meta; attempt++) {
          rawBrainOutputs = [];
          meta = await runBrainChecked({
            ...base, prevPhase: (m0?.checkpoint_stage as string | null) ?? null, prevAix: m0 && m0.reply_mode === "aix" ? (m0.action as string | null) ?? null : null,
            prevMeta: (m0 ?? undefined) as never, mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy,
          }, !!p.pc, row);
        }
        row.trace = { ...(row.trace ?? {}), strategy: strategy ? "あり" : "なし（全体の分析が読めない）" };
      } else {
        await insertMsgs(0, p.context.length);
        await new Promise((r) => setTimeout(r, 1300));
        for (let attempt = 0; attempt < 2 && !meta; attempt++) {
          rawBrainOutputs = [];
          meta = await runBrainChecked({ ...base, prevPhase: null, prevAix: null, mode: "full", layer: "combined", strategy: null }, !!p.pc, row);
        }
        if (LAYER === "prod") row.trace = { strategy: "なし（初回・前の会話が無い）" };
      }
      if (!meta) throw new Error("ブレインが null");
      row.brain = planOf(meta);
      row.trace = { ...(row.trace ?? {}), ...Object.fromEntries(TRACE_KEYS.filter((k) => meta![k] !== undefined && meta![k] !== null).map((k) => [k, meta![k]])) };
      const rawOut = rawBrainOutputs[rawBrainOutputs.length - 1];
      row.raw = rawPlanOf(rawOut);
      const code = brainPathCode(meta as BrainExamOutput);
      const pv = judgePath(code, acc, mn);
      row.path = { code: code.label, acceptHit: pv.acceptHit, mustNotHit: pv.mustNotHit, ok: pv.ok };
      // 本質の道: LLM が AIX を選んでいれば決まった計算、それ以外は判定の分類
      const rawAction = String(row.raw?.aix ?? "").trim() || String(row.raw?.action ?? "").trim();
      const rawIsAix = AIX_KEYS.has(rawAction);
      const jg = NO_JUDGE ? null : await judge(ps, meta, row.raw ?? null, !!row.raw && !rawIsAix);
      if (jg) {
        row.asks = (p.asks ?? []).map((a, i) => ({ q: a.q, covered: jg.asks[i], why: jg.asksWhy[i], route: jg.route[i] }));
        row.ng = (p.ng ?? []).map((x, i) => ({ text: x, violated: jg.ng[i], why: jg.ngWhy[i] }));
      }
      const essCode = rawIsAix ? brainPathCode({ reply_mode: "aix", action: rawAction, check_pattern: (row.raw?.check_pattern as string | null) ?? null }) : jg?.rawPath ? codeFromString(jg.rawPath) : null;
      if (essCode) { const ev = judgePath(essCode, acc, mn); row.essence = { code: essCode.label, acceptHit: ev.acceptHit, mustNotHit: ev.mustNotHit, ok: ev.ok }; }
      row.score = problemScore(pv, jg ? jg.asks : null, jg ? jg.ng : null);
      // ④ 下書き（返信・2段が正解の問題だけ・ブレインの答案を固定して generate-reply を1回）
      // 10/09 --draft-first-only: 下書き（④）は1回目だけ（過半数の回の費用を抑える）
      if (POST && acc.some((a) => !a.startsWith("AIX")) && (rep === 1 || !flag("draft-first-only"))) {
        if (meta.reply_mode === "aix") row.draft = { text: null, skipped: "ブレインが AIX", code: code.label, ok: false, asks: null, ng: null, pass: false };
        else {
          const customer = p.context.slice(burst).map((_, k) => texts[burst + k]);
          const staffEngaged = p.context.some((m) => m.s === "staff" && m.t.trim() && m.t.trim() !== "[画像]");
          const body = {
            message: customer.join(MSG_SEP), customerMessages: customer, state: staffEngaged ? "proposing" : "first_reply", conversationId: CONV, customerName: "YUMA",
            hasViewed: false, activeTaskTypes: [], hasStaffReplied: staffEngaged,
            recentMessages: p.context.slice(-25).map((m, k, arr) => ({ sender: m.s, text: texts[p.context.length - arr.length + k], createdAt: times[times.length - arr.length + k], isAix: !!m.aix })),
            brainMetaDirect: { meta, customerName: "YUMA", conversationDirection: (meta.conversation_direction as Record<string, unknown> | undefined) ?? null, brainAnalyzedAt: new Date().toISOString() },
            shadowNoWrite: true, testSceneMaterials: "on", testExcludeReplyText: p.staffText ?? "",
          };
          let text: string | null = null, skipped: string | undefined;
          try {
            const res = await POST(new Request("http://localhost/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never) as Response;
            const ct = res.headers.get("content-type") ?? "";
            if (ct.includes("application/json")) { const j = await res.json().catch(() => ({})) as Record<string, unknown>; skipped = String(j.reason ?? j.error ?? res.status); }
            else text = parseStream(await res.text());
          } catch (e) { skipped = `失敗: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120); }
          if (text) {
            const dj = NO_JUDGE ? null : await judgeDraft(ps, text);
            const dcode = dj?.code ?? "返信";
            const dv = judgePath(codeFromString(dcode), acc, mn);
            row.draft = { text, code: dcode, ok: dv.ok, asks: dj?.asks ?? null, ng: dj?.ng ?? null, pass: dv.ok && (!dj || (dj.asks.every(Boolean) && !dj.ng.some(Boolean))) };
          } else row.draft = { text: null, skipped: skipped ?? "下書きなし", code: "（下書きなし）", ok: false, asks: null, ng: null, pass: false };
        }
      }
    } catch (e) { row.error = e instanceof Error ? e.message : String(e); }
    finally {
      if (savedClock === undefined) delete process.env.TEST_CLOCK_JST_HOUR; else process.env.TEST_CLOCK_JST_HOUR = savedClock;
      writeFloor(null);
      if (own.length) { const del = await sb.from("messages").delete().in("id", own); if (del.error) console.error(`⛔ YUMA の自分の行を消せない: ${del.error.message}`); own = []; }
      await deleteOwnLedger();
      // 要約の書き戻し（非同期）を待ってから条件の行を戻す＝次の問題・他の担当に混ぜない
      await new Promise((r) => setTimeout(r, 2500));
      // 問題ごとに条件の行を戻す（控えを空にする）＝他の担当の再生が問題の間に入れる（同時1本・待たせ続けない）
      await restorePc().catch((e) => console.warn("restorePc:", String(e)));
    }
    // 10/09: 条件の行が混ざった回は数えずに回し直す（最大2回・それでも混ざったら印を付けて残す）
    if (row.pcMismatch?.length && !row.error) {
      const k = `${p.id}#${rep}`, n = pcRetries.get(k) ?? 0;
      if (n < 2) { pcRetries.set(k, n + 1); console.warn(`  ↻ ${p.id}#${rep} 条件の行が混ざった（${row.pcMismatch.join(",")}）→ 回し直す（${n + 1}回目）`); rep--; await new Promise((r) => setTimeout(r, GAP_MS)); continue; }
    }
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    const miss = row.asks?.filter((a) => !a.covered).length ?? 0, vio = row.ng?.filter((g) => g.violated).length ?? 0;
    console.log(`${row.score.pass ? "○" : "✕"} ${p.id}#${rep} [${p.type}] ${row.essence ? `本質=${row.essence.code} ` : ""}ブレイン=${row.path.code || "-"}${row.draft ? ` 下書き=${row.draft.code}${row.draft.pass ? "○" : "✕"}` : ""} 正解=${acc.join("|")}${row.path.mustNotHit ? ` ⛔${row.path.mustNotHit}` : ""}${miss ? ` 依頼の抜け${miss}` : ""}${vio ? ` 違反${vio}` : ""}${row.ledger?.errors.length ? ` 台帳の失敗 ${row.ledger.errors.join("／")}` : ""}${row.pcMismatch ? ` 条件の混ざり ${row.pcMismatch.join(",")}` : ""}${row.error ? ` 失敗: ${row.error}` : ""}`);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  const s = summarize(LABEL, BASELINE || null);
  console.log(`\n${s}`);
  writeFileSync(`${RESULTS_DIR}/${LABEL}.summary.txt`, s);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(async () => {
  if (floorFile()) { writeFloor(null); unlockFloor(); }
  lease?.release();
  if (own.length) await sb.from("messages").delete().in("id", own);
  await deleteOwnLedger().catch((e) => console.warn("deleteOwnLedger:", String(e)));
  await restorePc().catch((e) => console.warn("restorePc:", String(e)));
  if (h) { await h.finish(); console.log(`判定（DeepSeek 直・記録の外）: ${judgeCost.calls}回 $${judgeCost.usd.toFixed(4)}${injectStats.calls ? `・試しの材料を足した呼び出し ${injectStats.calls}回` : ""}`); }
  setTimeout(() => process.exit(process.exitCode ?? 0), 800);
});
