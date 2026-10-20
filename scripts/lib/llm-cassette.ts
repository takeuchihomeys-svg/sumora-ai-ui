// scripts/lib/llm-cassette.ts — 試験・テストで呼んだ LLM の「要求」と「答え」を録って、同じ要求なら録った答えを返す（API を呼ばない）
//
// 2026-10-15 竹内「テストの時 API 使いすぎてる。もっと質高く重点的に API も節約してテストを回す」
//   決まり・出口・材料の選び方だけの直しは、ブレイン・下書きの要求（プロンプト）が変わらない → 答えも同じで良い＝呼ぶ必要が無い。
//   要求が変わった所（直した所の材料・指示）だけ本当に呼ぶ。
//
// 置き場: 既定 <倉庫の根>/.claude/exam-cache/llm-cassette/（全部の作業ツリーで共有・.gitignore・伏せた会話が入るので倉庫に上げない）。LLM_CASSETTE_DIR で変える。
// モード（LLM_CASSETTE）:
//   off    … 何もしない
//   record … 全部本当に呼び、要求と答えを録る（試験の既定）
//   replay … 要求が同じなら録った答えを返す。無い・変わった物だけ本当に呼んで録る
//   strict … 要求が同じなら録った答え。無い・変わった物は呼ばずに失敗（400）にし、どこが変わったかを出す（API 0回の確かめ）
// 鍵: 宛先（host+path）＋名札（x-sumora-llm-action）＋本文（JSON を鍵の順に並べ、日時・UUID など毎回変わる物を伏せた物）の sha256。
//   LLM_CASSETTE_KEY=exact で伏せずに鍵にする。LLM_CASSETTE_MASK=<正規表現>,... で伏せる物を足す。
//   同じ要求を同じ回に何度も呼ぶ時（--repeat=3 の過半数）は n 回目に n 番目の録った答えを返す（足りなければ replay は本当に呼んで足す）。
// 置く場所: 共通の入口（llm-test-harness）が一番外に入れる＝別クラウドの包み・使用量の記録より外。
//   → 再生した呼び出しは llm_usage_logs に行が残らない（新しく呼んだ物だけが数に入る）。録った時の usage から「呼んでいたら幾ら」を出す。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveRouteName, testDeepseekModelOverride } from "../../app/lib/llm-alt-provider";
import { examEnvFingerprint } from "./exam-env-fp";

/** 2026-10-18: LLM_TEST_DS_MODEL_BY_ACTION で替えた名札のモデル（無ければ null）。名札の無い返信生成は system の先頭で見分ける（llm-alt と同じ） */
function actionModelOverride(env: Record<string, string | undefined>, action: string | null, body: string | null): string | null {
  if (!(env.LLM_TEST_DS_MODEL_BY_ACTION ?? "").trim()) return null;
  let head = "";
  if (!action && body) {
    try {
      const sys = (JSON.parse(body) as { system?: unknown }).system;
      head = typeof sys === "string" ? sys : Array.isArray(sys) ? sys.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("") : "";
    } catch { head = ""; }
  }
  return testDeepseekModelOverride(env, resolveRouteName(action, head.slice(0, 200)));
}

export type CassetteMode = "off" | "record" | "replay" | "strict";
export const CASSETTE_HEADER = "x-llm-cassette";
/**
 * 試験の取り置きの根（録音・前の取り置き）。作業ツリー（.claude/worktrees/agent-*）ごとに分けると、他の担当が録った物・回した「前」が使えない
 * → 倉庫の根の .claude/exam-cache/（.gitignore）に全員で置く。EXAM_CACHE_DIR で変える。git が読めない時は scripts/.exam-cache
 */
export function examCacheRoot(env: Record<string, string | undefined> = process.env): string {
  const e = String(env.EXAM_CACHE_DIR ?? "").trim();
  if (e) return resolve(e);
  try { return join(dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()), ".claude", "exam-cache"); }
  catch { return resolve("scripts/.exam-cache"); }
}
export const DEFAULT_CASSETTE_DIR = join(examCacheRoot(), "llm-cassette");
/** LLM の宛先（ここに行く呼び出しだけ録る・再生する） */
export const LLM_HOSTS = [/(^|\.)api\.anthropic\.com$/, /(^|\.)api\.deepseek\.com$/, /(^|\.)api\.typesafe\.ai$/, /(^|\.)api\.openai\.com$/, /^dashscope[\w-]*\.aliyuncs\.com$/, /\.services\.ai\.azure\.com$/];

export function readCassetteMode(env: Record<string, string | undefined> = process.env): CassetteMode {
  const v = String(env.LLM_CASSETTE ?? "").trim().toLowerCase();
  return v === "record" || v === "replay" || v === "strict" ? v : "off";
}

// ─── 鍵 ──────────────────────────────────────────────────────────────
/** 毎回変わる物（日時・UUID・時刻）を伏せる。答えの中身に効く物（金額・物件名・会話）は伏せない */
const BASE_MASKS: Array<[RegExp, string]> = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  [/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g, "<date>"],
  [/\d{1,2}月\d{1,2}日/g, "<md>"],
  [/(?<![\d/])\d{1,2}\/\d{1,2}(?![\d/])/g, "<md>"],
  [/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g, "<hm>"],
  [/(?<!\d)\d{1,2}時\d{1,2}分/g, "<hm>"],
  [/\b1[6-9]\d{11}\b/g, "<ms>"],
  [/alt_[0-9a-z]{6,}/g, "<altid>"],
];
function extraMasks(env: Record<string, string | undefined>): Array<[RegExp, string]> {
  return String(env.LLM_CASSETTE_MASK ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => [new RegExp(s, "g"), "<mask>"] as [RegExp, string]);
}
export function maskVolatile(s: string, env: Record<string, string | undefined> = process.env): string {
  if (String(env.LLM_CASSETTE_KEY ?? "").trim() === "exact") return s;
  let out = s;
  for (const [re, rep] of [...BASE_MASKS, ...extraMasks(env)]) out = out.replace(re, rep);
  return out;
}
/** JSON を鍵の順に並べて文字にする（同じ中身なら同じ文字） */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
/** 鍵に入れる本文（JSON なら並べ直して伏せる・読めなければそのまま伏せる） */
export function normalizeBody(body: string, env: Record<string, string | undefined> = process.env): string {
  let s = body;
  try { s = stableStringify(JSON.parse(body)); } catch { /* JSON でない */ }
  return maskVolatile(s, env);
}
export function cassetteKey(o: { host: string; path: string; action: string | null; normBody: string }): string {
  return createHash("sha256").update(`${o.host}${o.path}\n${o.action ?? ""}\n${o.normBody}`).digest("hex");
}

/**
 * 鍵に足す印。2026-10-17: DEEPSEEK_MODEL を既定（deepseek-v4-pro）から替えた回は鍵にモデルを足す（既定の鍵は今まで通り）。
 * 2026-10-18: 最後の Claude の確かめ（LLM_TEST_FINAL_CLAUDE）も pro の回と同じ鍵だった → 「Sonnet の回」が pro の回の答えを再生し、
 *   比べが同じに見えた（mc1018-sonnet は brain_fresh を1回も呼んでいない）。Claude の回は印を足して別の鍵にする。DeepSeek へ直に送る要求には足さない。
 */
export function cassetteSalt(env: Record<string, string | undefined>, host: string, actionModel: string | null = null): string {
  if (/deepseek/.test(host)) return "";
  if (String(env.LLM_TEST_FINAL_CLAUDE ?? "").trim()) return "\n#provider=claude";
  // 2026-10-18 flash-writer: 名札ごとに替えたモデル（LLM_TEST_DS_MODEL_BY_ACTION＝書く役だけ flash）があればそれ・無ければ DEEPSEEK_MODEL
  const dsm = String(actionModel ?? env.DEEPSEEK_MODEL ?? "").trim();
  return dsm && dsm !== "deepseek-v4-pro" ? `\n#model=${dsm}` : "";
}
/**
 * 2026-10-21 試験のブレインの穴: 鍵にスイッチ（DAY_SUBJECT_READER 等）と回（--repeat の何回目か）が入っていなかった。
 *   ① スイッチの指紋（exam-env-fp.ts・既定＝.env.local と違うスイッチだけ）を足す＝on の回と off の回が互いの答えを再生しない。
 *      既定（指紋が空）の回は今までの鍵のまま。判定（DeepSeek へ直に送る・名札なし）には足さない（判定の要求はブレインの答えを含む＝答えが同じなら同じ判定でよい）。
 *   ② 2回目以降の回（札の rep が 2 以上）は回を足す＝別の実行で足した確かめの回が 1回目の答えを再生しない（独立な確かめ）。
 *      --replay=strict（呼ばない確かめ）の時は足さない（旧の鍵＝録った n 番目の答え）。止める: LLM_CASSETTE_REP=off
 */
export function cassetteRunSalt(o: { envFp?: string | null; host: string; action: string | null; rep?: string | null; mode: CassetteMode; env?: Record<string, string | undefined> }): string {
  const env = o.env ?? process.env;
  const judge = /deepseek/.test(o.host) && !o.action;
  const envPart = o.envFp && !judge ? `
#env=${o.envFp}` : "";
  const r = Number(o.rep ?? "");
  const repPart = o.mode !== "strict" && Number.isFinite(r) && r >= 2 && String(env.LLM_CASSETTE_REP ?? "").trim().toLowerCase() !== "off" ? `
#rep=${r}` : "";
  return envPart + repPart;
}
/** この回のスイッチの指紋（LLM_CASSETTE_ENV_FP があればそれ・"-"＝なし。無ければ今の作業ツリーで出す） */
export function cassetteEnvFp(env: Record<string, string | undefined>): string {
  const v = String(env.LLM_CASSETTE_ENV_FP ?? "").trim();
  if (v) return v === "-" ? "" : v;
  try { return examEnvFingerprint(env).hash; } catch { return ""; }
}
/**
 * 録った答えがこの回の宛先に合うか（2026-10-18）。前の鍵（印なし）には Claude の回の答えと pro の回の答えが混ざっている
 *   → DeepSeek の試験（LLM_TEST_MODE・Claude の確かめでない）では Claude の答え（usage.model が claude）を返さない。
 *   Claude の確かめでは Claude の答えだけ返す。モデルが分からない物（旧の録音）は返す。
 */
export function cassetteResponseFits(env: Record<string, string | undefined>, model: string | null): boolean {
  if (!model) return true;
  if (String(env.LLM_TEST_FINAL_CLAUDE ?? "").trim()) return /claude/i.test(model);
  if (String(env.LLM_TEST_MODE ?? "").trim()) return !/claude/i.test(model);
  return true;
}

// ─── 費用（録った答えの usage から） ─────────────────────────────────────
export type CassetteUsage = { model: string | null; input_uncached: number; cache_read: number; cache_write: number; cache_write_5m: number; cache_write_1h: number; output_tokens: number };
const n0 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Anthropic の JSON・SSE、OpenAI 互換（DeepSeek）の JSON・SSE から usage を読む */
export function usageOfResponse(text: string, contentType: string): CassetteUsage {
  const u: CassetteUsage = { model: null, input_uncached: 0, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: 0 };
  const apply = (x: Record<string, unknown> | undefined | null) => {
    if (!x) return;
    // Anthropic
    if (x.input_tokens != null) u.input_uncached = Math.max(u.input_uncached, n0(x.input_tokens));
    if (x.cache_read_input_tokens != null) u.cache_read = Math.max(u.cache_read, n0(x.cache_read_input_tokens));
    if (x.cache_creation_input_tokens != null) u.cache_write = Math.max(u.cache_write, n0(x.cache_creation_input_tokens));
    const cc = x.cache_creation as Record<string, unknown> | undefined;
    if (cc) { u.cache_write_5m = Math.max(u.cache_write_5m, n0(cc.ephemeral_5m_input_tokens)); u.cache_write_1h = Math.max(u.cache_write_1h, n0(cc.ephemeral_1h_input_tokens)); }
    if (x.output_tokens != null) u.output_tokens = Math.max(u.output_tokens, n0(x.output_tokens));
    // OpenAI 互換（DeepSeek: 一致／不一致）
    if (x.prompt_cache_miss_tokens != null || x.prompt_tokens != null) {
      const hit = n0(x.prompt_cache_hit_tokens ?? (x.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
      u.cache_read = Math.max(u.cache_read, hit);
      u.input_uncached = Math.max(u.input_uncached, x.prompt_cache_miss_tokens != null ? n0(x.prompt_cache_miss_tokens) : Math.max(0, n0(x.prompt_tokens) - hit));
    }
    if (x.completion_tokens != null) u.output_tokens = Math.max(u.output_tokens, n0(x.completion_tokens));
  };
  const take = (j: Record<string, unknown>) => {
    if (typeof j.model === "string") u.model = j.model;
    const m = j.message as Record<string, unknown> | undefined;
    if (m && typeof m.model === "string") u.model = m.model;
    apply(j.usage as Record<string, unknown> | undefined); apply(m?.usage as Record<string, unknown> | undefined);
  };
  if (/event-stream/.test(contentType) || /^(event|data):/m.test(text.slice(0, 200))) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { take(JSON.parse(line.slice(5).trim()) as Record<string, unknown>); } catch { /* [DONE] 等 */ }
    }
  } else { try { take(JSON.parse(text) as Record<string, unknown>); } catch { /* */ } }
  return u;
}
/** 1回の費用（$）。Claude 以外は別クラウドの単価（混雑時の2倍は録った時刻で） */
export async function usdOfUsage(u: CassetteUsage, at: string): Promise<number> {
  const { claudeUsageUsd, altUsageUsd } = await import("../../app/lib/llm-price");
  return /claude/.test(u.model ?? "") ? claudeUsageUsd(u) : altUsageUsd({ ...u, created_at: at });
}

// ─── 置き場 ────────────────────────────────────────────────────────────
export type CassetteResponse = { at: string; status: number; contentType: string; body: string; usage: CassetteUsage; usd: number };
export type CassetteEntry = { key: string; host: string; path: string; action: string | null; reqModel: string | null; tag: Record<string, string>; firstAt: string; normBody: string; responses: CassetteResponse[] };
export function entryFile(dir: string, key: string): string { return join(dir, key.slice(0, 2), `${key}.json`); }
export function readEntry(dir: string, key: string): CassetteEntry | null {
  const f = entryFile(dir, key);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")) as CassetteEntry; } catch { return null; }
}
function writeEntry(dir: string, e: CassetteEntry) {
  const f = entryFile(dir, e.key);
  mkdirSync(join(dir, e.key.slice(0, 2)), { recursive: true });
  writeFileSync(f, JSON.stringify(e));
}
/** 録った物の中で、同じ名札（・同じ問題）の一番近い物（変わった所を見せる用） */
export function nearestEntry(dir: string, action: string | null, tag: Record<string, string>, normBody: string): CassetteEntry | null {
  if (!existsSync(dir)) return null;
  let best: CassetteEntry | null = null, bestScore = -1;
  for (const sub of readdirSync(dir)) {
    const d = join(dir, sub);
    let files: string[] = [];
    try { files = readdirSync(d).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      let e: CassetteEntry;
      try { e = JSON.parse(readFileSync(join(d, f), "utf8")) as CassetteEntry; } catch { continue; }
      if (e.action !== action) continue;
      const sameProblem = tag.problem && e.tag?.problem === tag.problem ? 1_000_000_000 : 0;
      const prefix = commonPrefix(e.normBody, normBody);
      const score = sameProblem + prefix - Math.abs(e.normBody.length - normBody.length) / 1000;
      if (score > bestScore) { bestScore = score; best = e; }
    }
  }
  return best;
}
function commonPrefix(a: string, b: string): number { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; }
/** 変わった所（最初に違う所の前後）を短く */
export function diffHint(oldBody: string, newBody: string, span = 90): string {
  const i = commonPrefix(oldBody, newBody);
  if (i === oldBody.length && i === newBody.length) return "（同じ）";
  // 後ろからの一致も見て、違う区間だけを出す
  let j = 0; while (j < oldBody.length - i && j < newBody.length - i && oldBody.charCodeAt(oldBody.length - 1 - j) === newBody.charCodeAt(newBody.length - 1 - j)) j++;
  const cut = (s: string) => s.replace(/\\n/g, "⏎").replace(/\s+/g, " ");
  const o = cut(oldBody.slice(Math.max(0, i - 30), Math.min(oldBody.length - j, i + span)));
  const nw = cut(newBody.slice(Math.max(0, i - 30), Math.min(newBody.length - j, i + span)));
  return `${i}字目から（前 ${oldBody.length}字→今 ${newBody.length}字）\n      前: …${o}…\n      今: …${nw}…`;
}

// ─── 数え ──────────────────────────────────────────────────────────────
export type CassetteTally = { real: number; realUsd: number; replayed: number; replayUsd: number; missed: number; unrecordable: number };
const emptyTally = (): CassetteTally => ({ real: 0, realUsd: 0, replayed: 0, replayUsd: 0, missed: 0, unrecordable: 0 });
export type CassetteStats = {
  mode: CassetteMode; dir: string;
  total: CassetteTally;
  byAction: Map<string, CassetteTally>;
  byTag: Map<string, CassetteTally>;
  misses: Array<{ action: string | null; tag: Record<string, string>; hint: string }>;
  /** 2026-10-15: RPC match_*（読むだけの似た物探し）の録音・再生の数（LLM の数えとは別） */
  rpc?: { replayed: number; recorded: number; failed: number };
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 包みを替える時に、前の包みの印（別クラウドの __sumoraAltProvider・記録の Symbol 等）を写す。写さないと開発用の「包みが外れた」判定で二重に包まれる */
export function wrapGlobalFetch(make: (prev: FetchLike) => FetchLike): void {
  const prev = globalThis.fetch as unknown as FetchLike & Record<string | symbol, unknown>;
  const next = make(prev) as unknown as Record<string | symbol, unknown>;
  for (const k of [...Object.getOwnPropertyNames(prev), ...Object.getOwnPropertySymbols(prev)]) {
    if (k === "length" || k === "name" || k === "prototype") continue;
    try { if (!(k in next)) next[k] = prev[k]; } catch { /* */ }
  }
  globalThis.fetch = next as unknown as typeof fetch;
}

let currentTag: Record<string, string> = {};
/** 今の問題・回を札にする（数えを問題ごとに分け、変わった所を探す時に同じ問題の録音を先に見る） */
export function setCassetteTag(tag: Record<string, string>): void { currentTag = { ...tag }; }

const STATS_KEY = Symbol.for("sumora.llmCassetteStats");
export function cassetteStats(): CassetteStats | null { return ((globalThis as unknown as Record<symbol, unknown>)[STATS_KEY] as CassetteStats | undefined) ?? null; }

function urlOf(input: RequestInfo | URL): URL | null {
  try { return new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url); } catch { return null; }
}
function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers ?? (typeof input === "object" && input instanceof Request ? input.headers : undefined));
}
export function isLlmUrl(u: URL | null): boolean { return !!u && LLM_HOSTS.some((re) => re.test(u.hostname)); }
/**
 * 2026-10-15（試験の節約の確かめ）: 読むだけの似た物探し（Supabase の RPC match_*＝RAG・手本・勝ちパターン・テンプレ）も録って返す。
 *   同じ番を2回回しても、RAG が DB の時間切れ（statement timeout）で空になる回と当たる回で材料が変わり、ブレインの要求が変わって
 *   再生が外れていた（10/15 cache1015b: q025 の brain_full が【関連ナレッジ】の有無だけで外れ、続く brain_fresh・判定も新しく呼んだ）。
 *   埋め込み（OpenAI）は録音から返るので、同じ要求なら RPC の本文（ベクトル）も同じ＝録った結果を返せば材料も同じになる。
 *   録るのは成功した答えだけ。strict でも RPC は止めない（DB を読むだけで費用は無い）。止める: LLM_CASSETTE_RPC=off
 */
export function isMatchRpcUrl(u: URL | null, env: Record<string, string | undefined> = process.env): boolean {
  if (!u || String(env.LLM_CASSETTE_RPC ?? "").trim().toLowerCase() === "off") return false;
  return /\.supabase\.co$/.test(u.hostname) && /\/rest\/v1\/rpc\/match_[a-z_]+$/.test(u.pathname);
}
export type CassetteRpcTally = { replayed: number; recorded: number; failed: number };

/**
 * 包みを作る（純粋に inner を包む・テストで使う）。stats に数える。
 * 返り値の Response には x-llm-cassette: replay|record|miss を付ける（判定の費用を二重に数えないため）
 */
export function makeCassetteFetch(inner: FetchLike, o: { mode: CassetteMode; dir: string; stats: CassetteStats; env?: Record<string, string | undefined>; log?: (s: string) => void; envFp?: string }): FetchLike {
  const env = o.env ?? process.env;
  const log = o.log ?? ((s: string) => console.warn(s));
  const seen = new Map<string, number>(); // この回で同じ鍵を何回呼んだか
  const tallyOf = (m: Map<string, CassetteTally>, k: string) => { let t = m.get(k); if (!t) { t = emptyTally(); m.set(k, t); } return t; };
  const bump = (action: string | null, f: (t: CassetteTally) => void) => {
    f(o.stats.total); f(tallyOf(o.stats.byAction, action ?? "(名札なし)"));
    const tg = currentTag.problem ?? "(問題の外)"; f(tallyOf(o.stats.byTag, tg));
  };
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = urlOf(input);
    if (o.mode !== "off" && isMatchRpcUrl(u, env)) return rpcCassette(inner, input, init, u!, o, seen);
    if (o.mode === "off" || !isLlmUrl(u)) return inner(input, init);
    const headers = headersOf(input, init);
    const action = headers.get("x-sumora-llm-action");
    let body: string | null = typeof init?.body === "string" ? init.body : null;
    if (body === null && !init?.body && typeof input === "object" && input instanceof Request) { try { body = await input.clone().text(); } catch { body = null; } }
    const method = (init?.method ?? (typeof input === "object" && input instanceof Request ? input.method : "GET")).toUpperCase();
    if (body === null && method !== "GET") { bump(action, (t) => t.unrecordable++); return inner(input, init); }
    const normBody = normalizeBody(body ?? "", env);
    // 2026-10-17: 要求は別クラウドへ振り替える前（Anthropic の形）で録る＝DEEPSEEK_MODEL を既定（deepseek-v4-pro）から替えた回も同じ鍵になり、
    //   pro の答えを flash の回に返していた（モデルの比べが全部「同じ」に見えた）。既定と違う時だけ鍵にモデルを足す（既定の鍵は今まで通り）
    //   DeepSeek へ直に送る要求（判定など）は本文にモデル名がある＝足さない。2026-10-18: Claude の確かめの回も別の鍵（cassetteSalt）
    //   2026-10-18: 名札ごとにモデルを替えた回（LLM_TEST_DS_MODEL_BY_ACTION＝書く役だけ flash）は、その名札の要求だけ鍵にモデルを足す
    //   （ブレインは既定のモデルの鍵のまま＝pro の答えの再生で判断を固定できる）
    const actionModel = !/deepseek/.test(u!.host) ? actionModelOverride(env, action, body) : null;
    const keyFor = (mode: CassetteMode) => cassetteKey({ host: u!.host, path: u!.pathname, action, normBody: normBody + cassetteSalt(env, u!.host, actionModel) + cassetteRunSalt({ envFp: o.envFp, host: u!.host, action, rep: currentTag.rep, mode, env }) });
    // 2026-10-21 確かめる人: strict は旧の鍵（回なし）だが、回を足して録った2回目以降（record/replay で録った物）があればそちらを再生する
    //   （無いと --repeat=2 で録った回を strict で流すと2回目が「録った答えは1個」で止まる）
    let key = keyFor(o.mode);
    if (o.mode === "strict") { const k2 = keyFor("replay"); if (k2 !== key && readEntry(o.dir, k2)) key = k2; }
    const nth = seen.get(key) ?? 0; seen.set(key, nth + 1);
    const entry = readEntry(o.dir, key);
    // 2026-10-18: 録った答えのうち、この回の宛先（Claude／DeepSeek）に合う物だけを n 番目として返す（cassetteResponseFits）
    const hit = o.mode !== "record" ? (entry?.responses.filter((r) => cassetteResponseFits(env, r.usage?.model ?? null))[nth] ?? null) : null;
    if (hit) {
      bump(action, (t) => { t.replayed++; t.replayUsd += hit.usd; });
      return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.contentType, [CASSETTE_HEADER]: "replay" } });
    }
    if (o.mode === "strict") {
      const near = nearestEntry(o.dir, action, currentTag, normBody);
      const why = entry ? `録った答えは ${entry.responses.length} 個（この回 ${nth + 1} 回目）` : near ? diffHint(near.normBody, normBody) : "同じ名札の録音なし";
      o.stats.misses.push({ action, tag: { ...currentTag }, hint: why });
      bump(action, (t) => t.missed++);
      log(`[llm-cassette] ⛔ 録音なし（呼ばない）: ${action ?? "(名札なし)"} ${currentTag.problem ?? ""} — ${why}`);
      const msg = `llm-cassette strict: 要求が録音と違う（${action ?? "名札なし"}）`;
      return new Response(JSON.stringify({ type: "error", error: { type: "cassette_miss", message: msg } }), { status: 400, headers: { "content-type": "application/json", [CASSETTE_HEADER]: "miss" } });
    }
    const res = await inner(input, init);
    const at = new Date().toISOString();
    const ct = res.headers.get("content-type") ?? "";
    // 録るのは成功した答えだけ（失敗を再生すると直った後も失敗が返る）
    if (res.status >= 200 && res.status < 300) {
      const clone = res.clone();
      const done = clone.text().then(async (text) => {
        const usage = usageOfResponse(text, ct);
        const usd = await usdOfUsage(usage, at).catch(() => 0);
        bump(action, (t) => { t.real++; t.realUsd += usd; });
        const cur = readEntry(o.dir, key);
        let reqModel: string | null = null; try { reqModel = String((JSON.parse(body ?? "{}") as { model?: unknown }).model ?? "") || null; } catch { /* */ }
        const e: CassetteEntry = cur ?? { key, host: u!.host, path: u!.pathname, action, reqModel, tag: { ...currentTag }, firstAt: at, normBody, responses: [] };
        e.responses.push({ at, status: res.status, contentType: ct, body: text, usage, usd });
        writeEntry(o.dir, e);
      }).catch((err) => log(`[llm-cassette] 録れなかった: ${err instanceof Error ? err.message : err}`));
      pending.add(done); void done.finally(() => pending.delete(done));
    } else bump(action, (t) => t.real++);
    return res;
  };
}
/** RPC match_* の録音・再生（LLM の数えには入れない・stats.rpc に数える）。record は全部呼んで録る・replay/strict は録音があれば返す */
async function rpcCassette(
  inner: FetchLike, input: RequestInfo | URL, init: RequestInit | undefined, u: URL,
  o: { mode: CassetteMode; dir: string; stats: CassetteStats; env?: Record<string, string | undefined>; log?: (s: string) => void },
  seen: Map<string, number>,
): Promise<Response> {
  const env = o.env ?? process.env;
  const rpc = (o.stats.rpc ??= { replayed: 0, recorded: 0, failed: 0 });
  const body = typeof init?.body === "string" ? init.body : null;
  if (body === null) return inner(input, init);
  const action = `rpc:${u.pathname.split("/").pop()}`;
  const normBody = normalizeBody(body, env);
  // 鍵に問い合わせの文字（select・limit 等）も入れる
  const key = cassetteKey({ host: u.host, path: `${u.pathname}${u.search}`, action, normBody });
  const nth = seen.get(key) ?? 0; seen.set(key, nth + 1);
  const entry = o.mode !== "record" ? readEntry(o.dir, key) : null;
  // DB の読み取りは同じ要求なら同じ答えでよい（--repeat の n 回目も最後の録音を返す）
  const hit = entry?.responses.length ? entry.responses[Math.min(nth, entry.responses.length - 1)] : null;
  if (hit) { rpc.replayed++; return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.contentType, [CASSETTE_HEADER]: "replay" } }); }
  const res = await inner(input, init);
  if (res.status >= 200 && res.status < 300) {
    const at = new Date().toISOString();
    const ct = res.headers.get("content-type") ?? "application/json";
    const done = res.clone().text().then((text) => {
      rpc.recorded++;
      const cur = readEntry(o.dir, key);
      const e: CassetteEntry = cur ?? { key, host: u.host, path: `${u.pathname}${u.search}`, action, reqModel: null, tag: { ...currentTag }, firstAt: at, normBody, responses: [] };
      if (!cur || o.mode === "record") e.responses.push({ at, status: res.status, contentType: ct, body: text, usage: { model: null, input_uncached: 0, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: 0 }, usd: 0 });
      writeEntry(o.dir, e);
    }).catch(() => { /* 録れなくても続ける */ });
    pending.add(done); void done.finally(() => pending.delete(done));
  } else rpc.failed++;
  return res;
}
const pending = new Set<Promise<unknown>>();
/** 録音の書き込みを待つ（終わりに数える前に） */
export async function flushCassette(): Promise<void> { while (pending.size) await Promise.allSettled([...pending]); }

/** 一番外に入れる（共通の入口が呼ぶ）。off なら何もしない */
export function installLlmCassette(env: Record<string, string | undefined> = process.env): CassetteStats | null {
  const mode = readCassetteMode(env);
  if (mode === "off") return null;
  const dir = String(env.LLM_CASSETTE_DIR ?? "").trim() || DEFAULT_CASSETTE_DIR;
  mkdirSync(dir, { recursive: true });
  const stats: CassetteStats = { mode, dir, total: emptyTally(), byAction: new Map(), byTag: new Map(), misses: [] };
  (globalThis as unknown as Record<symbol, unknown>)[STATS_KEY] = stats;
  const envFp = cassetteEnvFp(env);
  wrapGlobalFetch((prev) => makeCassetteFetch(prev, { mode, dir, stats, env, envFp }));
  console.log(`[llm-cassette] ${envFp ? `スイッチの指紋 ${envFp}（既定の回の録音は使わない）・` : ""}${mode === "record" ? "録る（全部呼ぶ）" : mode === "replay" ? "再生（同じ要求は呼ばない・変わった所だけ呼ぶ）" : "再生だけ（変わった所も呼ばずに止める）"}・置き場 ${dir}`);
  return stats;
}

/** 終わりの数え（1回の試験の終わりに出す） */
export function formatCassetteStats(s: CassetteStats, extra: { reusedProblems?: number; reusedUsd?: number } = {}): string {
  const t = s.total;
  const L: string[] = [];
  L.push(`=== この回の API（試験の道具の数え・${s.mode}）===`);
  L.push(`  新しく呼んだ   ${t.real}回 $${t.realUsd.toFixed(4)}`);
  L.push(`  再生で済んだ   ${t.replayed}回（呼んでいたら $${t.replayUsd.toFixed(4)}）`);
  if (t.missed) L.push(`  録音なし・要求が変わった（strict で呼ばずに止めた） ${t.missed}回`);
  if (t.unrecordable) L.push(`  録れない形（本文が文字でない）${t.unrecordable}回（そのまま呼んだ）`);
  if (s.rpc && (s.rpc.replayed || s.rpc.recorded || s.rpc.failed)) L.push(`  似た物探し（RPC match_*・DB を読むだけ）: 再生 ${s.rpc.replayed}・録った ${s.rpc.recorded}・失敗 ${s.rpc.failed}（失敗は録らない＝次の回にもう一度読む）`);
  if (extra.reusedProblems != null) L.push(`  前の結果を使い回した ${extra.reusedProblems}問${extra.reusedUsd ? `（前を回していたら約 $${extra.reusedUsd.toFixed(4)}）` : ""}`);
  const acts = [...s.byAction].sort((a, b) => (b[1].real + b[1].replayed + b[1].missed) - (a[1].real + a[1].replayed + a[1].missed));
  if (acts.length) L.push(`  名札ごと（呼んだ/再生/止めた）: ${acts.map(([k, v]) => `${k} ${v.real}/${v.replayed}${v.missed ? `/${v.missed}` : ""}`).join("・")}`);
  if (s.misses.length) {
    L.push(`  変わった所（最初の5件・直した所の材料・指示が出ていれば正しい）:`);
    for (const m of s.misses.slice(0, 5)) L.push(`    - ${m.action ?? "(名札なし)"} ${m.tag.problem ?? ""}: ${m.hint}`);
  }
  return L.join("\n");
}
/** 問題ごとの数え（JSON にして残す・前の結果を使い回した時の「呼んでいたら」に使う） */
export function tallyByTagJson(s: CassetteStats): Record<string, CassetteTally> { return Object.fromEntries(s.byTag); }
