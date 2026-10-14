// app/lib/reading-recheck-server.ts（サーバー専用・DeepSeek・@napi-rs/canvas。画面側から import しない）
// 怪しい印（reading-confidence.ts）が付いた欄だけ、画像を拡大して読み直す（確信度のゲートの「深く調べる」側）。
//
// 2026-10-14 竹内さん（設計知見 56ecf24a・P1）「自信が無い時・根拠が見つからない時だけ深く調べる。全部に毎回かけない」
//   ・1回目の読み取り（property-image-read.readPropertyImage）は今まで通り。印のある画像だけ、ここで1回呼ぶ（1枚で欄をまとめて読む）。
//   ・拡大のしかた: 欄の位置は資料の形ごとに違う（リアプロ・itandi・管理会社の独自の形）ので、位置を決めず、
//     全体＋同じ画像を縦横2つずつ（4つ・少し重ねて）に切って拡大した物を一緒に渡す（画像のトークンは大きさにほとんど左右されない＝pdf-sheet-crop の注記）。
//   ・書き写しだけ（判断・言い換えをさせない）。指示に例の値は書かない（推論なしの読み取りは指示の例を写す＝設計知見 d6d4d331）。
//   ・推論なし・温度0。指示の文は固定で先頭（キャッシュが効く形）。
//   ⚠ 物件の資料の画像だけ（送った画像の読み取りの後＝申込中の会話は呼び出し側 sent-image-record が先に止めている）。本人確認書類は呼ばない
// 戻す: READING_RECHECK=off（読み直しを呼ばない＝印は付くが深く調べない）
import { JA_KANJI_INSTRUCTION, jaKanji } from "./ja-kanji";
import { PROPERTY_IMAGE_ENDPOINT, PROPERTY_IMAGE_MODEL_DEFAULT } from "./property-image-read";

export function readingRecheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.READING_RECHECK ?? "").trim().toLowerCase() !== "off";
}

export const RECHECK_PROMPT = `物件の資料の画像です。1枚目は資料の全体、2枚目からは同じ資料を縦横2つずつに分けて拡大した物です。拡大した画像で文字を確かめ、次の欄に書いてある文字を、書いてあるとおりに1字ずつ書き写してください（推測・言い換え・計算はしない）。JSONのみ返答（説明文・コードブロック不要）：
{"property_name":"","room_number":"","deposit":"","key_money":""}
- property_name: 建物の名前（マンション名）。号室・階・「号室」の字は含めない。読めなければ ""
- room_number: 号室の欄の文字（号室の番号だけ）。書いていない・読めなければ ""
- deposit: 敷金の欄の文字を、数字と単位・記号ごとそのまま（ヶ月・万円・円・なし 等の書いてある字のまま）。保証金の欄しか無ければ保証金の欄。欄が無ければ ""
- key_money: 礼金の欄の文字を、数字と単位・記号ごとそのまま。欄が無ければ ""
- 画像に書かれていない字を作らない
${JA_KANJI_INSTRUCTION}`;
export const RECHECK_MAX_TOKENS = 600;

export type RecheckRead = { propertyName: string; roomNumber: string; deposit: string; keyMoney: string; raw: string; usage: { input: number; output: number; cacheHit: number } | null; tiles: number; ms: number };

/** 応答の JSON を読む（読めなければ null） */
export function parseRecheck(content: string): Omit<RecheckRead, "usage" | "tiles" | "ms"> | null {
  const raw = String(content ?? "").trim();
  const body = (raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1] ?? raw).trim();
  const js = body.startsWith("{") ? body : body.match(/\{[\s\S]*\}/)?.[0] ?? "";
  if (!js) return null;
  try {
    const o = JSON.parse(js) as Record<string, unknown>;
    const s = (v: unknown) => { const t = jaKanji(String(v ?? "")).trim(); return t === "null" ? "" : t.slice(0, 60); };
    return { propertyName: s(o.property_name), roomNumber: s(o.room_number), deposit: s(o.deposit), keyMoney: s(o.key_money), raw };
  } catch { return null; }
}

/** 全体＋縦横2つずつ（55%ずつ・少し重ねる）を JPEG の data URL に。切れなければ全体の URL だけ */
async function zoomContent(imageUrl: string, timeoutMs: number): Promise<{ parts: Array<Record<string, unknown>>; tiles: number }> {
  const base = [{ type: "image_url", image_url: { url: imageUrl } }];
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(Math.min(8_000, timeoutMs)) });
    if (!res.ok) return { parts: base, tiles: 0 };
    const buf = Buffer.from(await res.arrayBuffer());
    const { loadImageCanvas, cropCanvas } = await import("./pdf-sheet-crop");
    const canvas = await loadImageCanvas(buf);
    if (!canvas) return { parts: base, tiles: 0 };
    const S = 0.55;
    const parts: Array<Record<string, unknown>> = [...base];
    let tiles = 0;
    for (const y of [0, 1 - S]) for (const x of [0, 1 - S]) {
      const c = await cropCanvas(canvas, { x, y, w: S, h: S }, { maxScale: 2.5, maxSide: 1400, quality: 90 });
      if (!c) continue;
      parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${c.jpeg.toString("base64")}` } });
      tiles++;
    }
    return { parts, tiles };
  } catch { return { parts: base, tiles: 0 }; }
}

/**
 * 印のある画像を1回だけ拡大して読み直す（失敗しても投げない・読めなければ null）。
 * @param record llm_usage_logs に残すか（scripts の確かめは false＝本番 DB に書かない）
 */
export async function recheckImageFields(imageUrl: string, opts: { timeoutMs?: number; record?: boolean; apiKey?: string } = {}): Promise<RecheckRead | null> {
  const apiKey = (opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (!apiKey || !/^https?:\/\//.test(imageUrl)) return null;
  const model = (process.env.PROPERTY_IMAGE_MODEL ?? PROPERTY_IMAGE_MODEL_DEFAULT).trim();
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const t0 = Date.now();
  const { parts, tiles } = await zoomContent(imageUrl, timeoutMs);
  let status = 0, errorType: string | null = null;
  let usage: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | undefined;
  try {
    const res = await fetch(PROPERTY_IMAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, max_tokens: RECHECK_MAX_TOKENS, thinking: { type: "disabled" }, temperature: 0,
        messages: [{ role: "user", content: [{ type: "text", text: RECHECK_PROMPT }, ...parts] }],
      }),
      signal: AbortSignal.timeout(Math.max(5_000, timeoutMs - (Date.now() - t0))),
    });
    status = res.status;
    if (!res.ok) { errorType = "http_error"; return null; }
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: typeof usage };
    usage = j.usage;
    const p = parseRecheck(String(j.choices?.[0]?.message?.content ?? ""));
    if (!p) { errorType = "parse"; return null; }
    return { ...p, usage: { input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0, cacheHit: usage?.prompt_cache_hit_tokens ?? 0 }, tiles, ms: Date.now() - t0 };
  } catch (e) {
    errorType = e instanceof Error ? e.name : "error";
    return null;
  } finally {
    if (opts.record !== false) {
      const u = usage;
      void import("./llm-usage-recorder").then(({ recordAltUsage }) => {
        const hit = u?.prompt_cache_hit_tokens ?? 0;
        recordAltUsage({
          model, action: "property_image_recheck", conversationId: null,
          usage: { input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - hit), output_tokens: u?.completion_tokens ?? 0, cache_read_input_tokens: hit },
          status, errorType, durationMs: Date.now() - t0, sysHead: RECHECK_PROMPT.slice(0, 200), sysKeyFull: null, maxTokens: RECHECK_MAX_TOKENS,
        });
      }).catch(() => {});
    }
  }
}
