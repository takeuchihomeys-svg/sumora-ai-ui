// scripts/exam-aix-text.ts — 試験の「AIX の文」の段（本番の生成の入口で AIX の文を作り、竹内さんが送った文と比べて採点する）
//
// 2026-10-22 試験のブレインの穴: ブレインの試験はボタンまで・押した後の文（1通目・2通目・✨この会話に合った文）を測る段が無かった。
//   問題: scripts/exam-aix-text-build.ts（本番の竹内さんの AIX の番・伏せ済み・<倉庫の根>/.claude/exam-cache/aix-text-exam/questions.json）
//   生成: 本番と同じ入口（app/api/aix/action・app/api/aix-template-generate の POST）を同じプロセスで呼ぶ。after()（aix_generate_log 等の記録）は空の箱＝
//         試験の会話（既定 YUMA4・--conv=YUMA・YUMA2〜5。YUMA は申込以降＝✨の文が Claude に固定されて止まる）に行を残さない。学習ルールは今の DB のまま（testFlags.rules_r9=off）。
//   採点: scripts/lib/exam-aix-text.ts（中身・作り事・形・近さ・スタッフだけが知る事＝決まった物差し）。曖昧な時だけ LLM の判定（DeepSeek flash・伏せた文だけ・--judge=lazy）
//   節約（ブレインの段と同じ道具）: LLM の録音と再生（LLM_CASSETTE=replay・同じ要求は呼ばない）＋入力の差（main の答えの控え＝同じ要求は main の答え・
//         問題ごとに「入力が main と同じ」を出す）。main と同じコード×既定のスイッチの回は main の取り置き（baseline）になる。
//   上限: 1日 EXAM_DAILY_CAP_USD（今日の試験 env の費用＋見込み）・1回 --budget（既定 EXAM_RUN_CAP_USD か $5 の小さい方・超えたら残りは流さない）・
//         同時2本まで（.slots の札）・空きメモリ 800MB 以上。
//
// 使い方（同時2本まで・LINE には送らない）:
//   問題を作る:   npx tsx --env-file=.env.local scripts/exam-aix-text-build.ts [--since=2026-08-01] [--reuse-raw]
//   main の基準: npx tsx --env-file=.env.local scripts/exam-aix-text.ts --label=main（main と同じコード・既定のスイッチ＝取り置きになる）
//   スイッチの比べ: npx tsx --env-file=.env.local scripts/exam-aix-text.ts --label=sw1 --switch=AIX_TAKEUCHI_FORM=off [--switch=…]
//   直した後:     npx tsx --env-file=.env.local scripts/exam-aix-text.ts --label=fix1（今の作業ツリー・main の控えで同じ要求は呼ばない）
//   下見（呼ばない）: … --plan（main の答えの控えと録音だけで流す＝入力が main と違う問題を数える・$0）
//   絞る: --only=<id,…> --buttons=見積書,待ち合わせ --kinds=aix,second ／ 判定: --judge=lazy|full|off ／ 会話: --conv=YUMA4
//   採点し直し（物差しを直した時・LLM なし）: … --rescore=baseline ／ --rescore=<結果の json>
//   試験のブレインから: npx tsx --env-file=.env.local scripts/exam-brain.ts --aix-text -- --label=fix1 …（同じ引数を渡す）
import { AsyncLocalStorage } from "node:async_hooks";
// next の after()/workAsyncStorage が読む前に置く（--require の .cjs の代わり）
(globalThis as unknown as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
// スイッチ（--switch=NAME=値・(unset) は消す）は何より先に env へ（指紋・録音の鍵・生成の全部が読む）
for (const a of process.argv.slice(2)) { const m = /^--switch=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a); if (!m) continue; if (m[2] === "(unset)") delete process.env[m[1]]; else process.env[m[1]] = m[2]; }
const PLAN = process.argv.includes("--plan");
if (!process.env.LLM_TEST_FINAL_CLAUDE) process.env.LLM_TEST_MODE ??= "deepseek-all";
process.env.LLM_CASSETTE ??= PLAN ? "strict" : "replay";

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { examCacheRoot, setCassetteTag, setCassettePins, cassetteCallsOf, inputDiffOf, hasPinsFor, pinsFromRows, cassetteStats, type CallRef } from "./lib/llm-cassette";
import { examEnvFingerprint } from "./lib/exam-env-fp";
import { reach, workingFiles } from "./lib/exam-scope";
import { tryClaim, releaseClaims, runCapUsd } from "./lib/exam-coord";
import { dailyCapUsd } from "./lib/exam-brain";
import { readDailySpend } from "./lib/exam-brain-io";
import { NO_LINE_TEST_CONVERSATIONS } from "../app/lib/test-conversations";
import { maskPII } from "../app/lib/pii-mask";
import { scoreAixText, needsJudge, withJudge, parseJudge, JUDGE_SYSTEM, judgeUser, summarize, compareRows, KIND_JA, PASS_RULE, type AixQuestion, type AixRow, type AixScore } from "./lib/exam-aix-text";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const list = (k: string) => arg(k).split(",").map((s) => s.trim()).filter(Boolean);
const LABEL = arg("label", "aix");
const JUDGE = (["lazy", "full", "off"].includes(arg("judge")) ? arg("judge") : "lazy") as "lazy" | "full" | "off";
const JUDGE_MODEL = process.env.EXAM_AIX_JUDGE_MODEL ?? "deepseek-flash";
const EST_PER_Q = Number(process.env.EXAM_AIX_EST_USD ?? "0.02"); // 1問の見込み（DeepSeek・生成＋最後の点検）
let BUDGET = Math.min(Number(arg("budget", "")) || Infinity, runCapUsd(process.env) ?? Infinity, 5);
const AIX_EXAM_DIR = join(examCacheRoot(), "aix-text-exam");
const QFILE = join(AIX_EXAM_DIR, "questions.json");
const BASE_DIR = join(AIX_EXAM_DIR, "baseline"), RES_DIR = join(AIX_EXAM_DIR, "results"), SLOT_DIR = join(AIX_EXAM_DIR, "slots");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const AIX_ENTRIES = ["app/api/aix/action/route.ts", "app/api/aix-template-generate/route.ts"];
const git = (a: string[]) => { try { return execFileSync("git", a, { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).toString().trim(); } catch { return ""; } };

type Row = AixRow & { picker: string | null; rep: number; llmCalls: CallRef[]; ms: number; error?: string };
type BaseFile = { mainCommit: string; codeKey: string; savedAt: string; rows: Row[] };

/** 生成の入口から届くコードの印と、origin/main と同じか */
function codeState(): { codeKey: string; sameAsMain: boolean; mainCommit: string; files: number } {
  try { execFileSync("git", ["fetch", "-q", "origin", "main"], { stdio: "ignore", timeout: 20_000 }); } catch { /* 手元で続ける */ }
  const files = workingFiles(".");
  const set = [...reach(AIX_ENTRIES, files)].sort();
  const codeKey = createHash("sha256").update(set.map((f) => `${f}\n${files.get(f) ?? ""}`).join("\n\0")).digest("hex").slice(0, 12);
  const mainCommit = git(["rev-parse", "origin/main"]);
  let sameAsMain = false;
  if (mainCommit) {
    try { execFileSync("git", ["diff", "--quiet", "origin/main", "--", ...set], { stdio: "ignore", maxBuffer: 64 * 1024 * 1024 }); sameAsMain = !git(["ls-files", "--others", "--exclude-standard", "--", ...set]); } catch { sameAsMain = false; }
  }
  return { codeKey, sameAsMain, mainCommit, files: set.length };
}
function readBaselines(): BaseFile[] {
  if (!existsSync(BASE_DIR)) return [];
  return readdirSync(BASE_DIR).filter((f) => f.endsWith(".json")).flatMap((f) => { try { return [JSON.parse(readFileSync(join(BASE_DIR, f), "utf8")) as BaseFile]; } catch { return []; } })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

const judgeCost = { calls: 0, usd: 0, replayed: 0 };
async function deepseekJson(sys: string, user: string): Promise<Record<string, unknown> | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) return null;
  const { DEEPSEEK_ENDPOINT } = await import("../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../app/lib/llm-price");
  try {
    const res = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, max_tokens: 500, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
    if (!res.ok) return null;
    if (res.headers.get("x-llm-cassette") === "replay") judgeCost.replayed++;
    else {
      const pr = altPriceOf(JUDGE_MODEL);
      const usd = pr && j.usage ? (((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6) * (pr.peakDouble && isDeepseekPeakAt(new Date()) ? 2 : 1) : 0;
      judgeCost.calls++; judgeCost.usd += usd;
      // 判定（DeepSeek 直）は llm_usage_logs に残らない＝手元の記録に足す（試験の1日の上限に数える）
      try { const { appendLocalSpend } = await import("./lib/brain-self-review-io"); appendLocalSpend({ at: new Date().toISOString(), tool: "exam-aix-text-judge", usd, calls: 1, model: JUDGE_MODEL, cacheHit: j.usage?.prompt_cache_hit_tokens ?? 0, cacheMiss: j.usage?.prompt_cache_miss_tokens ?? 0, out: j.usage?.completion_tokens ?? 0, label: LABEL }); } catch { /* 止めない */ }
    }
    return JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")) as Record<string, unknown>;
  } catch { return null; }
}

/**
 * 採点の物差しを直した時（試験の改善）: 生成はそのまま（LLM なし・$0）で、結果か main の取り置きを採点し直す。
 *   --rescore=<結果の json>|baseline（baseline＝取り置き全部を書き換える）。LLM の判定は前の物を使う（生成の文が同じなら判定の要求も同じ）
 */
function rescore(target: string): void {
  const qs = new Map((JSON.parse(readFileSync(QFILE, "utf8")) as { questions: AixQuestion[] }).questions.map((q) => [q.id, q]));
  const files = target === "baseline" ? (existsSync(BASE_DIR) ? readdirSync(BASE_DIR).filter((f) => f.endsWith(".json")).map((f) => join(BASE_DIR, f)) : []) : [target];
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, "utf8")) as { rows: Row[]; summary?: unknown };
    let changed = 0;
    for (const r of j.rows) {
      const q = qs.get(r.id);
      if (!q || q.hash !== r.hash || !r.text) continue;
      const before = r.score?.score;
      const s0 = scoreAixText(q, r.text);
      r.score = r.score?.judge ? withJudge(s0, r.score.judge) : s0;
      if (before !== r.score.score) changed++;
    }
    if (j.summary) j.summary = summarize(j.rows);
    writeFileSync(f, JSON.stringify(j, null, 1));
    const sm = summarize(j.rows);
    console.log(`採点し直し: ${f}（点が変わった ${changed}問）→ ${sm.n}問・合格 ${sm.pass}・平均 ${sm.mean.toFixed(1)}点`);
    for (const b of sm.byButton) console.log(`  ${b.button}: ${b.n}問 合格 ${b.pass} 平均 ${b.mean.toFixed(1)}点`);
  }
}

let h: LlmTestHarness | null = null;
let claimed: string[] = [];
async function main() {
  // 空きメモリは始める前に（この後コードの読み込み・生成の入口の読み込みで自分が使う）
  const freeMb = Math.round(freemem() / 1048576);
  if (freeMb < 800 && !args.includes("--force")) throw new Error(`空きメモリ ${freeMb}MB < 800MB（--force で流す）`);
  if (!existsSync(QFILE)) throw new Error(`問題がありません（${QFILE}）。先に scripts/exam-aix-text-build.ts`);
  const qs0 = (JSON.parse(readFileSync(QFILE, "utf8")) as { questions: AixQuestion[] }).questions;
  const only = list("only"), buttons = list("buttons"), kinds = list("kinds");
  const qs = qs0.filter((q) => (!only.length || only.includes(q.id)) && (!buttons.length || buttons.includes(q.button)) && (!kinds.length || kinds.includes(q.kind)));
  if (!qs.length) throw new Error("流す問題がありません（--only／--buttons／--kinds）");

  const fp = examEnvFingerprint(process.env);
  const cs = codeState();
  const isMainRun = cs.sameAsMain && !fp.pairs.length && !process.env.LLM_TEST_FINAL_CLAUDE;
  const bases = readBaselines();
  const base = bases.find((b) => b.mainCommit === cs.mainCommit) ?? bases[0] ?? null;
  console.log(`=== 試験の AIX の文 label=${LABEL} 問題 ${qs.length} ${PLAN ? "下見（呼ばない）" : ""} ===`);
  console.log(`  コード: ${cs.codeKey}（生成の入口から ${cs.files} ファイル）・main ${cs.mainCommit.slice(0, 7)} と${cs.sameAsMain ? "同じ" : "違う"}／スイッチ: ${fp.pairs.map(([k, v]) => `${k}=${v}`).join(" ") || "既定"}${isMainRun ? "／この回は main の取り置きになる" : ""}`);
  console.log(`  前（main の取り置き）: ${base ? `${base.mainCommit.slice(0, 7)}（${base.savedAt.slice(0, 16)}・${base.rows.length}問）${base.mainCommit !== cs.mainCommit ? " ⚠ 今の main より古い版" : ""}` : "なし"}`);
  console.log(`  採点: ${PASS_RULE}／判定: ${JUDGE}（${JUDGE_MODEL}）`);

  // ─ 上限・同時・メモリ ─
  if (!PLAN) {
    const cap = dailyCapUsd(process.env);
    const spent = await readDailySpend(sb as never).catch(() => ({ usd: 0 }));
    const est = qs.length * EST_PER_Q;
    console.log(`  費用: 今日の試験 $${spent.usd.toFixed(2)}＋見込み 最大 $${est.toFixed(2)}（録音・main の答えで済む分は 0）／1日の上限 ${cap === null ? "なし" : `$${cap}`}／この回 $${BUDGET.toFixed(2)} で止める`);
    if (cap !== null && spent.usd + Math.min(est, BUDGET) > cap && !args.includes("--over-cap")) throw new Error(`1日の上限を超える（${spent.usd.toFixed(2)}＋${Math.min(est, BUDGET).toFixed(2)} > ${cap}）。夜に流すか --over-cap`);
    // この回の止める線は1日の上限の残りまで（見込みは外れることがある＝流しながら止める）
    if (cap !== null && !args.includes("--over-cap")) BUDGET = Math.max(0, Math.min(BUDGET, cap - spent.usd));
    for (let i = 1; i <= 2 && !claimed.length; i++) { const r = tryClaim(SLOT_DIR, `slot-${i}`, LABEL); if (r.ok) claimed = [`slot-${i}`]; }
    if (!claimed.length) throw new Error("試験の AIX の文が既に2本流れています（同時2本まで）。終わってから");
  }

  // 既定は YUMA4（YUMA は申込以降の会話＝✨この会話に合った文が Claude に固定され、DeepSeek の試験で止まる）
  const convName = arg("conv", "YUMA4").toUpperCase();
  const CONV = convName === "YUMA" ? YUMA : NO_LINE_TEST_CONVERSATIONS.find((c) => c.name.toUpperCase() === convName)?.id;
  if (!CONV) throw new Error(`--conv=${convName} が分からない（YUMA・${NO_LINE_TEST_CONVERSATIONS.map((c) => c.name).join("・")}）`);

  h = await setupLlmTest(`exam-aix-text-${LABEL}`);
  h.assertTestConversation(CONV);
  // main の答えの控え（入力の差）: 同じ要求は main の答え。下見は main の答えか録音だけ・違う要求は呼ばない
  const pinRows = isMainRun ? [] : (base?.rows ?? []).map((r) => ({ ...r, id: `aix:${r.id}`, rep: 1, error: r.err ?? undefined }));
  if (pinRows.length) setCassettePins(pinsFromRows(pinRows), { only: PLAN });
  const stateOf = async () => {
    const { data: conv } = await sb.from("conversations").select("*").eq("id", CONV).single();
    const { data: pcs } = await sb.from("property_customers").select("*").eq("conversation_id", CONV);
    const c = { ...(conv as Record<string, unknown>) }; delete c.updated_at; delete c.last_message_at;
    return createHash("sha1").update(JSON.stringify({ c, pcs })).digest("hex");
  };
  if (!PLAN) await h.waitUntilYumaQuiet([], { maxWaitMin: Number(arg("wait-min", "20")), conversationId: CONV });
  const stateBefore = await stateOf();
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { POST: aixPost } = await import("../app/api/aix/action/route");
  const { POST: tplPost } = await import("../app/api/aix-template-generate/route");
  const store = { afterContext: { after: () => {} }, route: "/api/aix/action", isStaticGeneration: false } as never;

  const rows: Row[] = [];
  let stopped = 0;
  for (const q of qs) {
    const spentNow = (cassetteStats()?.total.realUsd ?? 0) + judgeCost.usd;
    if (spentNow >= BUDGET) { stopped++; continue; }
    const recent = ((q.body.recent_messages ?? q.body.recentMessages) as Array<{ text: string }> | undefined) ?? [];
    h.assertSceneSafe(recent.map((m) => m.text), q.id);
    // 竹内さんが送った時の時（JST）にそろえる（「夜分遅くに失礼致します」等の時刻の挨拶が正解と同じ条件になる）
    process.env.TEST_CLOCK_JST_HOUR = String((new Date(q.at).getUTCHours() + 9) % 24);
    const tag = `aix:${q.id}`;
    setCassetteTag({ problem: tag, rep: "1" });
    const t0 = Date.now();
    let text = "", err = "";
    try {
      if (q.route === "aix/action") {
        const body = { ...q.body, conversation_id: CONV, customer_name: "YUMA", testFlags: { rules_r9: "off" } };
        const res = await workAsyncStorage.run(store, () => aixPost(new Request("http://localhost/api/aix/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never)) as Response;
        const j = await res.json().catch(() => ({})) as Record<string, unknown>;
        text = String((q.aixType === "estimate_sheet" ? j.coverLetter : j.message_text) ?? "");
        if (!text) err = String(j.error ?? JSON.stringify(j).slice(0, 160));
      } else {
        const body = { ...q.body, conversationId: CONV, customerName: "YUMA" };
        const res = await workAsyncStorage.run(store, () => tplPost(new Request("http://localhost/api/aix-template-generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never)) as Response;
        const j = await res.json().catch(() => ({})) as Record<string, unknown>;
        text = String(j.text ?? "");
        if (!text) err = String(j.error ?? JSON.stringify(j).slice(0, 160));
      }
    } catch (e) { err = `失敗: ${e instanceof Error ? e.message : String(e)}`; }
    const calls = cassetteCallsOf(tag, "1");
    const idf = inputDiffOf(calls, hasPinsFor(tag, "1"));
    // 生成も正解と同じ伏せ方を通す（正解は maskPII 済み＝「申込者様→お客様」等の書き換えをそろえる）
    const gen = text ? maskPII(text) : "";
    let score: AixScore | null = gen ? scoreAixText(q, gen) : null;
    if (score && JUDGE !== "off" && !PLAN && (JUDGE === "full" || needsJudge(score))) {
      setCassetteTag({ problem: `aix-judge:${q.id}`, rep: "1" });
      score = withJudge(score, parseJudge(await deepseekJson(JUDGE_SYSTEM, judgeUser(q.gold, gen))));
    }
    const row: Row = { id: q.id, hash: q.hash, button: q.button, kind: q.kind, picker: q.picker, text: gen, err: err || null, score, inputSame: idf.same, calls: calls.length, rep: 1, llmCalls: calls, ms: Date.now() - t0 };
    rows.push(row);
    const s = score;
    console.log(`[${rows.length}/${qs.length}] ${q.id} ${q.button}・${KIND_JA[q.kind]}${q.picker ? `・${q.picker}` : ""} ${Math.round(row.ms / 1000)}s ${err ? `ERR ${err.slice(0, 120)}` : `${s!.pass ? "○" : "×"} ${s!.score}点（中身 ${s!.content.toFixed(2)}・形 ${s!.structure.toFixed(2)}・近さ ${s!.similarity.toFixed(2)}）${idf.same ? "・入力が main と同じ" : idf.pinned ? `・main と違う所 ${idf.changed.join("/")}` : ""}${s!.missing.length ? ` 抜け[${s!.missing.join(" ")}]` : ""}${s!.fabricated.length ? ` 作り事[${s!.fabricated.join(" ")}]` : ""}${s!.staffOnly.length ? ` スタッフだけ[${s!.staffOnly.join(" ")}]` : ""}${s!.judge ? ` 判定:${s!.judge.same ? "同じ要件" : `違う(${s!.judge.missing.join("/")})`}` : ""}`}`);
  }
  setCassetteTag({});
  setCassettePins(null);
  delete process.env.TEST_CLOCK_JST_HOUR;

  // ─ 結果・取り置き・比べ ─
  const sum = summarize(rows);
  const st = cassetteStats();
  const meta = { label: LABEL, at: new Date().toISOString(), head: git(["rev-parse", "HEAD"]), mainCommit: cs.mainCommit, codeKey: cs.codeKey, sameAsMain: cs.sameAsMain, switches: fp.pairs, conv: convName, plan: PLAN, judge: JUDGE, stopped,
    cost: { realUsd: st?.total.realUsd ?? 0, real: st?.total.real ?? 0, replayed: st?.total.replayed ?? 0, pinned: st?.total.pinned ?? 0, judgeUsd: judgeCost.usd, judgeCalls: judgeCost.calls } };
  mkdirSync(RES_DIR, { recursive: true });
  const resFile = join(RES_DIR, `${LABEL}-${meta.at.replace(/[-:T]/g, "").slice(0, 12)}.json`);
  writeFileSync(resFile, JSON.stringify({ meta, summary: sum, rows }, null, 1));
  if (isMainRun && !PLAN && cs.mainCommit) {
    mkdirSync(BASE_DIR, { recursive: true });
    const f = join(BASE_DIR, `main-${cs.mainCommit.slice(0, 10)}.json`);
    const prev = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as BaseFile).rows : [];
    const merged = [...rows.filter((r) => !r.err), ...prev.filter((p) => !rows.some((r) => r.id === p.id && !r.err))];
    writeFileSync(f, JSON.stringify({ mainCommit: cs.mainCommit, codeKey: cs.codeKey, savedAt: meta.at, rows: merged } satisfies BaseFile, null, 1));
    console.log(`\nmain の取り置き: ${f}（${merged.length}問）`);
  }
  console.log(`\n=== まとめ（${sum.n}問・合格 ${sum.pass}・平均 ${sum.mean.toFixed(1)}点）${stopped ? ` ⚠ 上限 $${BUDGET} で ${stopped}問を流していない` : ""} ===`);
  const before = base && !isMainRun ? summarize(base.rows.filter((r) => rows.some((x) => x.id === r.id && x.hash === r.hash))) : null;
  for (const b of sum.byButton) {
    const p = before?.byButton.find((x) => x.button === b.button);
    console.log(`  ${b.button}: ${b.n}問 合格 ${b.pass} 平均 ${b.mean.toFixed(1)}点${p ? `（main ${p.pass}/${p.n}・${p.mean.toFixed(1)}点）` : ""}`);
  }
  if (base && !isMainRun) {
    const d = compareRows(base.rows, rows);
    const same = d.filter((x) => x.inputSame).length;
    console.log(`  main と比べ: ${d.length}問（入力が同じ ${same}問＝答えも main のまま）・良くなった ${d.filter((x) => x.flip === "fail→pass").length}・悪くなった ${d.filter((x) => x.flip === "pass→fail").length}`);
    for (const x of d.filter((y) => y.flip || Math.abs(y.after - y.before) >= 10)) console.log(`    ${x.id}: ${x.before}→${x.after}点${x.flip ? `（${x.flip}）` : ""}`);
  }
  console.log(`  費用: 生成 新しく呼んだ ${meta.cost.real}回 $${meta.cost.realUsd.toFixed(4)}／再生 ${meta.cost.replayed}回（main の答え ${meta.cost.pinned}）／判定 ${judgeCost.calls}回 $${judgeCost.usd.toFixed(4)}（再生 ${judgeCost.replayed}）`);
  console.log(`  結果: ${resFile}`);
  const stateAfter = await stateOf();
  console.log(stateAfter === stateBefore ? `${convName} の会話・条件の行: 変わっていない` : `⚠ ${convName} の会話・条件の行が変わった（他の実行か生成の書き込み）`);
}
(arg("rescore") ? Promise.resolve(rescore(arg("rescore"))) : main()).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { if (claimed.length) releaseClaims(SLOT_DIR, claimed); if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
