// app/lib/jev-client.ts
// Jev（TypeSafe AI の System One モデル）を呼ぶ最小のクライアント。
//
// 2026-09-23 竹内「AIXでどのピッカーを選択するかの部分は Jev で強化できるかな」「ここに Jev をつかう。
//   ピッカーどれ選ぶかの判断は状況によって変わるけど、Jev がブレインの一部にいてそこから選択するのが一番質上がる気がする」
//
// Jev は文章を書かず、状態（state）と質問（questions）を渡すと**型の決まった答え**（選択肢・点数・yes/no の確率）を返す。
//   ・choice: 選択肢から1つ（probabilities と confidence 付き）
//   ・score : 段階の点数
//   ・noul  : 「この命題は真か」の確率（0〜1）
//   応答は 70〜500ms、入力 $0.042/100万トークン、出力は無料（2026-09 時点の公開情報）。
//
// 使い方の原則:
//   ・AIX の要否・種類・ピッカーは**ブレインだけ**が決める（feedback_brain_owns_aix）。Jev はブレインの中の判定部品。
//   ・最初は**影の運用**（答えを記録するだけで挙動は変えない）。aix_usage_logs（スタッフが実際に押した AIX・ピッカー）を正解に
//     正答率を測ってから、上回った判定だけ本番の判断に使う（scripts/eval-jev-aix.ts）。
//   ・個人情報は別クラウドと同じ扱い: 呼び出し側が pii-pseudonym で仮名化してから state に入れる。申込以降の会話は渡さない。
//   ・鍵は環境変数（TYPESAFE_API_KEY）。無ければ何もしない（null）＝今までどおり。
//   ・失敗しても本来の処理を止めない（fail-open・null を返す）。使用量は llm_usage_logs に1行残す（recordAltUsage）。
import { recordAltUsage } from "./llm-usage-recorder";

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: number };

export type JevResult = {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  ms: number;
};

export type JevConfig = { apiKey: string; model: string; endpoint: string };

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

/** 環境変数から設定を読む。鍵が無ければ null（＝Jev は使わない） */
export function readJevConfig(env: Record<string, string | undefined> = process.env): JevConfig | null {
  const apiKey = (env.TYPESAFE_API_KEY ?? env.JEV_API_KEY ?? "").trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: (env.JEV_MODEL ?? "").trim() || DEFAULT_MODEL,
    endpoint: (env.JEV_ENDPOINT ?? "").trim() || DEFAULT_ENDPOINT,
  };
}

export function isJevEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return readJevConfig(env) !== null;
}

/**
 * 1回の評価。state（文字列か JSON）と questions を渡し、answers を返す。
 * 鍵が無い・失敗・タイムアウトは null（呼び出し側は「Jev の答え無し」として今までどおり進む）。
 */
export async function jevSystemOne(input: {
  state: string | Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  /** 記録用（llm_usage_logs.action = "jev:<name>"） */
  action?: string;
  conversationId?: string | null;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<JevResult | null> {
  const cfg = readJevConfig(input.env ?? process.env);
  if (!cfg) return null;
  const started = Date.now();
  const doFetch = input.fetchImpl ?? fetch;
  try {
    const res = await doFetch(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, state: input.state, questions: input.questions }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      console.warn("[jev] HTTP", res.status, body);
      recordAltUsage({ model: `jev:${cfg.model}`, action: `jev:${input.action ?? "unknown"}`, conversationId: input.conversationId ?? null,
        usage: {}, status: res.status, errorType: `http_${res.status}`, durationMs: ms, sysHead: null, sysKeyFull: null, maxTokens: null });
      return null;
    }
    const j = await res.json() as { model?: string; answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };
    const usage = { input_tokens: Number(j.usage?.input_tokens ?? 0), output_tokens: Number(j.usage?.output_tokens ?? 0) };
    recordAltUsage({ model: `jev:${j.model ?? cfg.model}`, action: `jev:${input.action ?? "unknown"}`, conversationId: input.conversationId ?? null,
      usage, status: 200, errorType: null, durationMs: ms, sysHead: null, sysKeyFull: null, maxTokens: null });
    return { model: j.model ?? cfg.model, answers: j.answers ?? {}, usage, ms };
  } catch (e) {
    const ms = Date.now() - started;
    console.warn("[jev] failed:", e instanceof Error ? e.message : String(e));
    recordAltUsage({ model: `jev:${cfg.model}`, action: `jev:${input.action ?? "unknown"}`, conversationId: input.conversationId ?? null,
      usage: {}, status: 0, errorType: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "fetch_error", durationMs: ms,
      sysHead: null, sysKeyFull: null, maxTokens: null });
    return null;
  }
}
