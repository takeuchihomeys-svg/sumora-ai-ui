// app/lib/llm-request-sanitize.ts
// LLM API（Anthropic・OpenAI）へ送るリクエストから「絵文字の片割れ（対になっていないサロゲート）」を取り除く出口の処理
//
// 2026-09-14 竹内（API の漏れ調査）: 文章を .slice(0, N) で切ると絵文字（サロゲートペア）の途中で切れることがある。
//   JSON.stringify は片割れを "\ud83d" のようにエスケープして書き出し、Anthropic はそれを
//   「The request body is not valid JSON: no low surrogate in string」として 400 で拒否する。
//   400 は課金されないので費用の点検では見えないが、申込まで進んだ会話の学習（analyze-applying・1日4回失敗し6件が未学習）・
//   顧客サマリー・週次学習（corpus2skill）・テンプレートのおすすめが黙って止まっていた。
//   切る箇所は数百あり個別には直しきれないので、全経路が通る出口（fetch）で1回だけ直す（設計知見「LLM 呼び出しの出口の型」）。
//   instrumentation.ts の register() で installLlmFetchSanitizer() を1回呼ぶ。

import { mightHaveExamplePii, redactExampleSpansInPrompt } from "./example-pii-guard";

const LLM_API_HOSTS = new Set(["api.anthropic.com", "api.openai.com"]);
/** 手本の個人情報の歯止めを当てる宛先（Anthropic・OpenAI に加え、別クラウドの chat/completions＝DeepSeek・Azure・Qwen） */
const PII_GUARD_HOSTS = new Set(["api.anthropic.com", "api.openai.com", "api.deepseek.com"]);
function isLlmChatRequest(url: URL): boolean {
  return PII_GUARD_HOSTS.has(url.hostname) || /\/chat\/completions$/.test(url.pathname) || /\/v1\/messages$/.test(url.pathname);
}

// JSON.stringify は正しい対（絵文字など）はそのまま書き、片割れだけを \udXXX で書く。
// → 本文に \ud800〜\udfff のエスケープが無ければ直す物は無い（JSON.parse を省く速い判定）
const SURROGATE_ESCAPE_RE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 対になっていないサロゲートを取り除く（正しい絵文字は残す） */
export function stripLoneSurrogates(s: string): { text: string; removed: number } {
  let removed = 0;
  const text = s.replace(LONE_SURROGATE_RE, () => { removed++; return ""; });
  return { text, removed };
}

function walk(value: unknown, counter: { removed: number }): unknown {
  if (typeof value === "string") {
    const r = stripLoneSurrogates(value);
    counter.removed += r.removed;
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, counter));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, counter);
    return out;
  }
  return value;
}

/**
 * JSON の本文から片割れを取り除く。直す物が無い・JSON でない時は元の文字列をそのまま返す
 * （書き直すと並び・書式が変わってプロンプトキャッシュの先頭一致を壊し得るので、直した時だけ作り直す）
 */
export function sanitizeLlmJsonBody(body: string): { body: string; removed: number } {
  if (!SURROGATE_ESCAPE_RE.test(body)) return { body, removed: 0 };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { body, removed: 0 }; }
  const counter = { removed: 0 };
  const cleaned = walk(parsed, counter);
  if (counter.removed === 0) return { body, removed: 0 }; // 「\\ud83d」という文字そのもの（エスケープされた \）等
  return { body: JSON.stringify(cleaned), removed: counter.removed };
}

// ─── 2026-10-08 手本の個人情報の歯止め（出口）────────────────────────────────────────
// 事故: 手本（ai_reply_examples）の customer_message に別のお客様の記入済み申込フォーム（氏名・フリガナ・生年月日…）が入っていて、
//   返信生成（本番は DeepSeek）・AIX の文作り（Claude）に「お客様: 「…」」の形でそのまま渡っていた（読み替えは DeepSeek に回る時の名前・携帯等だけ）。
//   手本を並べる経路は 6 か所以上（generate-reply・aix-template-generate・aix/action・enhance-reply・generate-reply-patterns…）あるので、
//   全経路が通るこの出口で「手本の発言」の中だけを伏せる（判定は example-pii-guard.ts・入れる時と同じ関数）。
//   今の会話の履歴（鉤括弧の無い形）・ルール・ブレインの判断には触らない。戻す: EXAMPLE_PII_GUARD=off
export function redactExamplePiiInJsonBody(body: string, env: Record<string, string | undefined> = process.env): { body: string; redacted: number } {
  if ((env.EXAMPLE_PII_GUARD ?? "").trim().toLowerCase() === "off") return { body, redacted: 0 };
  if (!mightHaveExamplePii(body)) return { body, redacted: 0 };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { body, redacted: 0 }; }
  let redacted = 0;
  const walkPii = (v: unknown): unknown => {
    if (typeof v === "string") { const r = redactExampleSpansInPrompt(v); redacted += r.redacted; return r.text; }
    if (Array.isArray(v)) return v.map(walkPii);
    if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walkPii(x); return o; }
    return v;
  };
  const cleaned = walkPii(parsed);
  if (redacted === 0) return { body, redacted: 0 };
  return { body: JSON.stringify(cleaned), redacted };
}

function requestUrl(input: unknown): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string") {
      return new URL((input as { url: string }).url);
    }
  } catch { /* 相対 URL など → LLM API ではない */ }
  return null;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** fetch を包み、LLM API への文字列の本文だけを直す（他の宛先・文字列以外の本文は触らない） */
export function wrapFetchWithLlmSanitizer(original: FetchLike): FetchLike {
  const wrapped: FetchLike = (input, init) => {
    try {
      const url = requestUrl(input);
      if (url && init && typeof init.body === "string" && (LLM_API_HOSTS.has(url.hostname) || isLlmChatRequest(url))) {
        let body = init.body;
        let changed = false;
        if (LLM_API_HOSTS.has(url.hostname)) {
          const r = sanitizeLlmJsonBody(body);
          if (r.removed > 0) {
            console.log(JSON.stringify({ tag: "llm:surrogate-fixed", host: url.hostname, path: url.pathname, removed: r.removed }));
            body = r.body; changed = true;
          }
        }
        // 手本の個人情報（伏せる処理の失敗で送信を止めない＝外の try）
        const p = redactExamplePiiInJsonBody(body);
        if (p.redacted > 0) {
          console.log(JSON.stringify({ tag: "llm:example-pii-redacted", host: url.hostname, redacted: p.redacted }));
          body = p.body; changed = true;
        }
        if (changed) return original(input, { ...init, body });
      }
    } catch {
      // 直す処理の失敗で送信を止めない（そのまま送る）
    }
    return original(input, init);
  };
  return wrapped;
}

const INSTALLED = Symbol.for("sumora.llmFetchSanitizer");

/** globalThis.fetch を1回だけ包む（二重に包まない） */
export function installLlmFetchSanitizer(): boolean {
  const g = globalThis as unknown as { fetch: FetchLike & Record<PropertyKey, unknown> };
  if (typeof g.fetch !== "function" || g.fetch[INSTALLED]) return false;
  const original = g.fetch;
  const wrapped = wrapFetchWithLlmSanitizer(original.bind(globalThis)) as FetchLike & Record<PropertyKey, unknown>;
  // Next.js が fetch に付ける印（__nextPatched 等）を引き継ぎ、Next 側の二重パッチを防ぐ
  Object.assign(wrapped, original);
  wrapped[INSTALLED] = true;
  g.fetch = wrapped;
  return true;
}
