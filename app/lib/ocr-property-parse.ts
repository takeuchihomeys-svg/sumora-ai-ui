// app/lib/ocr-property-parse.ts — AIX の専任物件ピッカーの物件スクショ読み取り（/api/aix/ocr-property）の純関数
// 2026-10-08 竹内「AIX の物件資料の読み取り DeepSeek にすることはできるか」→ 同じ8枚で比べたら DeepSeek（推論なし）は号室を 2/8 読み違えた（506→505・805→806）・Claude は号室 8/8。
//   費用は Claude でも月 約1ドル（週27回）＝質を優先して**既定は Claude のまま**。DeepSeek は OCR_PROPERTY_PROVIDER=deepseek で試せる

export type OcrProperty = { prop_name: string; room_no: string };

/** 返事の文から {prop_name, room_no} を取り出す。読めない形・物件名が空なら null（読み直し・空で返す側に倒す） */
export function parseOcrPropertyJson(text: string): OcrProperty | null {
  const s = String(text ?? "").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: { prop_name?: unknown; room_no?: unknown };
  try { j = JSON.parse(m[0]); } catch { return null; }
  const prop = typeof j.prop_name === "string" ? j.prop_name.trim() : "";
  const room = typeof j.room_no === "string" ? j.room_no.trim() : "";
  if (!prop) return null;
  return { prop_name: prop, room_no: room };
}

/** 既定は Claude（号室の読み違いを避ける）。OCR_PROPERTY_PROVIDER=deepseek で DeepSeek（鍵がある時だけ） */
export function ocrPropertyProvider(env: Record<string, string | undefined> = process.env): "deepseek" | "claude" {
  const v = (env.OCR_PROPERTY_PROVIDER ?? "").trim().toLowerCase();
  if (v === "deepseek" && (env.DEEPSEEK_API_KEY ?? "").trim()) return "deepseek";
  return "claude";
}
