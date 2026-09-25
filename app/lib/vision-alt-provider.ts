// app/lib/vision-alt-provider.ts
// 画像つきの AIX 呼び出しを、指定した種類だけ DeepSeek-V4.1-Flash に回す（純関数・DB 依存なし）。
//
// 2026-09-20 竹内「物件オススメ置き換える」
//
// 【なぜ別に作るか】既存の llm-alt-provider は
//   「画像（Vision）と streaming は対象外＝そのまま Anthropic へ」と**明示的に除外**している。
//   画像つきは読み替え（PII の仮名化）が効かないので素通しにしていた経緯がある。
//   ここは「どの action を回すか」を環境変数で決め、**回す物だけ**を DeepSeek に送る。
//
// 【実測して置き換えを決めた】**本番の経路**（/api/aix/action・YUMA）で同じ画像3枚を通した:
//                        Claude Sonnet5     DeepSeek(low)
//   速度（2回目以降）      7.6秒              13〜15秒
//   キャッシュ率           75%                **96〜98%**
//   出力トークン           200                1,517〜1,727（推論を含む）
//   実送信に無い言い回し   0件                 0〜1件
//   **1回の費用**          **$0.0489**        **$0.0026**（19分の1）
//   ＝ 文の質は同等・費用は大幅に安い・速度は2倍かかる。物件オススメは1日4回なので採用。
//
//   見積書の抽出（数値）は **置き換えない**: 一致 6/9(67%)・「ポーラーベアー」→「ホーラーベアー」・
//   号室を読み落とし・速度 3.4秒 → 19.1秒。文は出口の決定論で直せるが、**金額は照合する相手がいない**。
//
// 【2回はまり、2回とも竹内さんの指摘で直した】
//   ① 単体テストで「DeepSeek の方が文が良い」と出したが、**本番の system は 47,000トークン**
//      （手本・ナレッジ入り）で、私のテストは自分で書いた 912トークンだった。条件が違った。
//      → 設計知見「本番検証は画面が渡すのと同じ形で渡す」。
//   ② 「DeepSeek はキャッシュが効かない」と報告したが、**私が usage を記録していなかっただけ**。
//      DeepSeek は区切り指定の要らない自動の前置きキャッシュで、実測 96〜99% 効いていた。
//      設計知見「別クラウドに替えても『静的は固定・動的だけ変わる』構造はそのまま効く」の通り。
//
// 【速度は reasoning_effort で詰めた】既定のままだと出力 4,661〜5,998（ほぼ推論）で 29〜37秒。
//   VISION_ALT_EFFORT=low で 1,517〜1,727・13〜15秒になった（文の質は変わらず）。
//
// 【戻し方】VISION_ALT_ACTIONS を空にすれば全部 Claude に戻る。

export const VISION_ALT_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
/** DeepSeek-V4.1-Flash */
export const VISION_ALT_MODEL_DEFAULT = "deepseek-flash";
/** 既定で回す action（文を作る所だけ）。環境変数 VISION_ALT_ACTIONS で上書き・空にすれば全部 Claude */
export const VISION_ALT_ACTIONS_DEFAULT = "property_recommendation";
/**
 * 推論の重さの既定。
 * 2026-09-20: **既定を "low" にする**。空（モデル既定）だと出力 4,661〜5,998 がほぼ推論に使われ
 *   29〜37秒かかり、AIX の待ち時間（Claude Vision は 38秒で切る）に迫る。
 *   low にすると出力 1,517〜1,727・**13〜15秒**で、文の質は変わらなかった（実送信に無い言い回し 0〜1件）。
 *   ⚠ 環境変数は本番に入れられない事がある（権限）。**既定値で正しく動く**ようにしておく。
 */
export const VISION_ALT_EFFORT_DEFAULT = "low";
/** 推論モデルなので余裕を持つ（小さいと推論で使い切って答えが1文字も出ない） */
export const VISION_ALT_MAX_TOKENS = 8000;

/** 回す action の集合を読む */
export function visionAltActions(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = (env.VISION_ALT_ACTIONS ?? VISION_ALT_ACTIONS_DEFAULT).trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** この呼び出しを DeepSeek に回すか（鍵が無ければ回さない＝必ず Claude に行く） */
export function shouldRouteVisionAlt(action: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!(env.DEEPSEEK_API_KEY ?? "").trim()) return false;
  return visionAltActions(env).has(action);
}

/** Anthropic の content（text / image）を OpenAI 互換の形に直す。画像が1枚も無ければ null（回さない） */
export function toOpenAiContent(content: unknown[]): Array<Record<string, unknown>> | null {
  const out: Array<Record<string, unknown>> = [];
  let hasImage = false;
  for (const b of content) {
    const o = b as { type?: string; text?: string; source?: { type?: string; url?: string; media_type?: string; data?: string } };
    if (o.type === "text" && typeof o.text === "string") { out.push({ type: "text", text: o.text }); continue; }
    if (o.type !== "image" || !o.source) return null;              // 知らない形が混ざったら回さない
    if (o.source.type === "url" && o.source.url) {
      out.push({ type: "image_url", image_url: { url: o.source.url } });
      hasImage = true; continue;
    }
    if (o.source.type === "base64" && o.source.data) {
      out.push({ type: "image_url", image_url: { url: `data:${o.source.media_type ?? "image/jpeg"};base64,${o.source.data}` } });
      hasImage = true; continue;
    }
    return null;
  }
  return hasImage ? out : null;
}

/** system のブロック（文字列 or Anthropic の配列）を1つの文字列にする */
export function flattenSystem(systemBlocks: unknown): string {
  if (typeof systemBlocks === "string") return systemBlocks;
  if (!Array.isArray(systemBlocks)) return "";
  return systemBlocks
    .map((b) => (typeof b === "string" ? b : String((b as { text?: string }).text ?? "")))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * usage。**キャッシュの一致／不一致も必ず受け取る**。
 * 2026-09-20: 最初 input / output しか見ておらず「DeepSeek はキャッシュが効かない」と誤読した。
 *   DeepSeek は区切りの指定が要らない**自動の前置きキャッシュ**で、
 *   `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` が返ってくる（一致は入力の 1/50 の価格）。
 *   設計知見「別クラウドに替えても『静的は固定・動的だけ変わる』構造はそのまま効く」。
 */
export type VisionAltResult = {
  text: string;
  usage: { input: number; output: number; cacheHit: number; cacheMiss: number };
  model: string;
};

/**
 * 2026-09-24: 文字だけ・画像混じりのどちらでも DeepSeek に投げる素の口（OpenAI 互換の content をそのまま渡す）。
 *   callVisionAlt は「画像が1枚も無ければ回さない」ので、文字だけの 🌟 の順位付けは毎回 null → Claude に落ちていた
 *   （YUMA のテストで発見）。文字だけの判断はこちらを使う。失敗は null（呼び出し側が倒す）
 */
export async function callDeepSeek(
  system: string | null,
  content: string | Array<Record<string, unknown>>,
  opts?: { apiKey?: string; model?: string; maxTokens?: number; timeoutMs?: number; effort?: string; thinking?: boolean; temperature?: number },
): Promise<VisionAltResult | null> {
  const apiKey = (opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  const model = (opts?.model ?? process.env.VISION_ALT_MODEL ?? VISION_ALT_MODEL_DEFAULT).trim();
  const effort = (opts?.effort ?? VISION_ALT_EFFORT_DEFAULT).trim();
  if (!apiKey) return null;
  // 2026-09-24 竹内「画像で分析」の型の前置き: 推論を切る（thinking: false）と 1件 約0.02円・1.1〜1.6秒（推論 low は 0.35〜0.6円・18〜32秒）。
  //   推論なしの時は reasoning_effort を送らない（送る形が変わると前置きキャッシュの先頭一致が外れるので、どちらかに固定する）
  const noThinking = opts?.thinking === false;
  try {
    const res = await fetch(VISION_ALT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: opts?.maxTokens ?? VISION_ALT_MAX_TOKENS,
        // 2026-09-25 資料の読み取り（正解表）: 温度を指定しないと同じ資料で回ごとに読みが入れ替わった → 読み取りは 0 を渡す（渡さない呼び出しは今まで通り）
        ...(typeof opts?.temperature === "number" ? { temperature: opts.temperature } : {}),
        ...(noThinking ? { thinking: { type: "disabled" } } : effort ? { reasoning_effort: effort } : {}),
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content },
        ],
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 60_000),
    });
    if (!res.ok) { console.warn("[deepseek] HTTP", res.status, (await res.text().catch(() => "")).slice(0, 200)); return null; }
    const j = await res.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
    };
    const text = String(j.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return null;
    return {
      text,
      usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0, cacheHit: j.usage?.prompt_cache_hit_tokens ?? 0, cacheMiss: j.usage?.prompt_cache_miss_tokens ?? 0 },
      model,
    };
  } catch (e) {
    console.warn("[deepseek] 失敗:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 物件の判断・読み取りで DeepSeek が2回とも答えなかった時の印（札・要確認の文言。Claude で埋めない） */
export const DEEPSEEK_READ_FAILED_LABEL = "読み取れなかった";

export type DeepSeekReadAttempt = { res: VisionAltResult | null; ok: boolean; ms: number; retry: boolean };
export type DeepSeekReadOutcome<T> = {
  /** 読めた値（2回とも読めなければ null） */
  value: T | null;
  /** 最後に答えた返事（使用量の記録用） */
  res: VisionAltResult | null;
  /** 1回目・読み直しのそれぞれ（llm_usage_logs に1行ずつ残す） */
  attempts: DeepSeekReadAttempt[];
  /** 2回とも読めなかった＝「読み取れなかった」の印を付ける */
  failed: boolean;
};

/**
 * 物件の判断・読み取り専用の DeepSeek の口（2026-09-25 竹内「分析 DeepSeek で必ず行う。クロードに切り替えない。物件判断のところ。
 *   読み取り必ず DeepSeek で、抜けの内容にプロンプトキャッシュを効かせる」）。
 *   ① 1回目が失敗（HTTP・時間切れ・空・読めない形）なら、**同じ前置き・同じ設定のまま1回だけ**読み直す（前置きが一字一句同じなので2回目はキャッシュが当たる）
 *   ② それでも読めなければ failed=true を返す。**Claude（Haiku・Sonnet・Anthropic SDK）には決して倒さない**
 *      呼び出し側は「読み取れなかった」の印（札・要確認）を付け、次の回・ボタンで DeepSeek で読み直す
 *   ③ 読み直しは時間の残りがある時だけ（retryIf で呼び出し側が決める。拡張の判定のように 8秒で切る所は残りが無ければ読み直さない）
 *   鍵が無い時は DeepSeek も呼ばない（callDeepSeek が null）＝そのまま failed（fetch は1回も出ない）
 * 対象: 🌟の順位付け・画像で分析（資料の読み取り・希望の照合）・条件の要約・間取り図の有無。お客様への返信・AIX の本文・ブレインは対象外（今のまま）
 */
export async function callDeepSeekRead<T>(
  system: string | null,
  content: string | Array<Record<string, unknown>>,
  opts: { maxTokens: number; timeoutMs: number; apiKey?: string; model?: string },
  parse: (text: string) => T | null,
  retry?: { retryIf?: (elapsedMs: number) => boolean; retryTimeoutMs?: (elapsedMs: number) => number },
): Promise<DeepSeekReadOutcome<T>> {
  // 推論なし・温度0 に固定（推論ありは 🌟 25/102・間取り図の有無 8/36・資料の詳細 21/165 が空の返事だった＝2026-09-25 の llm_usage_logs 14日分）。
  //   読み直しも同じ設定（送る形を変えると前置きキャッシュの先頭一致が外れる）
  const call = (timeoutMs: number) => callDeepSeek(system, content, {
    apiKey: opts.apiKey, model: opts.model, maxTokens: opts.maxTokens, timeoutMs, thinking: false, temperature: 0,
  });
  const attempts: DeepSeekReadAttempt[] = [];
  const t0 = Date.now();
  const r1 = await call(opts.timeoutMs);
  const v1 = r1 ? safeParse(parse, r1.text) : null;
  attempts.push({ res: r1, ok: v1 != null, ms: Date.now() - t0, retry: false });
  if (v1 != null) return { value: v1, res: r1, attempts, failed: false };
  // 鍵が無い時は読み直しても同じ（fetch も出ない）
  if (!(opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim()) return { value: null, res: r1, attempts, failed: true };
  const elapsed = Date.now() - t0;
  if (retry?.retryIf && !retry.retryIf(elapsed)) return { value: null, res: r1, attempts, failed: true };
  const t1 = Date.now();
  const r2 = await call(Math.max(1_000, retry?.retryTimeoutMs ? retry.retryTimeoutMs(elapsed) : opts.timeoutMs));
  const v2 = r2 ? safeParse(parse, r2.text) : null;
  attempts.push({ res: r2, ok: v2 != null, ms: Date.now() - t1, retry: true });
  return { value: v2, res: r2 ?? r1, attempts, failed: v2 == null };
}

function safeParse<T>(parse: (text: string) => T | null, text: string): T | null {
  try { return parse(text); } catch { return null; }
}

/**
 * DeepSeek に投げる。失敗したら null（呼び出し側が Claude に倒す＝fail-open）。
 * ⚠ AIX の本文（物件オススメ文）専用。物件の判断・読み取りは callDeepSeekRead を使う（Claude に倒さない）
 * 画像の中身は読み替えられないので、既存の Vision と同じく PII の読み替えは掛からない。
 */
export async function callVisionAlt(
  systemBlocks: unknown,
  content: unknown[],
  opts?: { apiKey?: string; model?: string; maxTokens?: number; timeoutMs?: number; effort?: string },
): Promise<VisionAltResult | null> {
  const apiKey = (opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  const model = (opts?.model ?? process.env.VISION_ALT_MODEL ?? VISION_ALT_MODEL_DEFAULT).trim();
  const effort = (opts?.effort ?? process.env.VISION_ALT_EFFORT ?? VISION_ALT_EFFORT_DEFAULT).trim();
  if (!apiKey) return null;
  const oaContent = toOpenAiContent(content);
  if (!oaContent) return null;
  const system = flattenSystem(systemBlocks);
  try {
    const res = await fetch(VISION_ALT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: opts?.maxTokens ?? VISION_ALT_MAX_TOKENS,
        // 出力の大半が推論（実測 4,661〜5,998 のうち答えは200前後）で、これが遅さの原因。
        // VISION_ALT_EFFORT=low で推論を軽くできる（未設定なら既定のまま）
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: oaContent },
        ],
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 90_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
    };
    const text = String(j.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return null;                                        // 空なら Claude に倒す
    return {
      text,
      usage: {
        input: j.usage?.prompt_tokens ?? 0,
        output: j.usage?.completion_tokens ?? 0,
        cacheHit: j.usage?.prompt_cache_hit_tokens ?? 0,
        cacheMiss: j.usage?.prompt_cache_miss_tokens ?? 0,
      },
      model,
    };
  } catch {
    return null;
  }
}
