// app/lib/rent-units.ts
// LLM が返した家賃・初期費用の単位の誤りを直す（純関数）。line-webhook-text・generate-draft-bg-async の写しと同じ線:
//   300 以下＝万円で返った（11 → 110,000）／家賃で 500,000 超＝10倍の誤り（1,100,000 → 110,000・初期費用は除く）
// 2026-11-15 作業員K: sync-from-screening の新規の物件顧客の行だけこの直しが無く、10倍の家賃（1,000,000・1,200,000・600,000）の行が4つ残っていた
//   （全部が同じお客様の行の重複・会話に結ばれていない new_inquiry）。拡張の顧客一覧に出ると上限100万で検索できてしまう。
export function normalizeRentUnits<T extends Record<string, unknown>>(parsed: T): T {
  const out: Record<string, unknown> = { ...parsed };
  for (const f of ["rent_min", "rent_max", "initial_cost_limit"]) {
    const v = out[f];
    if (typeof v === "number" && v > 0) {
      if (v <= 300) out[f] = v * 10000;
      else if (v > 500000 && f !== "initial_cost_limit") out[f] = v / 10;
    }
  }
  return out as T;
}
