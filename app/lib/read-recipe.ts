/**
 * 写真の「読み取り方」の成績を覚える（2026-11-15 竹内さん）
 *
 *   竹内さん「またここの読み取り方なども学んだらその部分強化するように」「２でやる」
 *   ＝ **失敗だけでなく、成功した読み取り方も記録**して、統括が「次はこの読み方で」と決められる形にする。
 *
 * ★ なぜ要るか
 *   今日、同じ写真で4通りの読み方を試して結果が全部違った（実測）:
 *     max_tokens 2500  → 0字（推論 6,762字）
 *     max_tokens 8000  → 0字（推論 21,320字）
 *     max_tokens 12000 → 欄 58個
 *     Claude Haiku     → 欄 27個
 *   ⚠ この「どの読み方が効いたか」は**その場の会話にしか無かった**。
 *     記録しないと、次に同じ失敗をして、また一から試すことになる。
 *
 * ★ 何を残すか
 *   **読み方の型（recipe）ごとに、読めた枚数・欄の数・時間・費用**。
 *   ⚠ 入れるのは**読み方の設定と数だけ**。写真の置き場所・お客様の情報・読んだ中身は入れない。
 *
 * ★ どこに残すか
 *   `learn_improvements`（既にある表）。⚠ **新しい表を作らない**（DBの構造を変えない）。
 *   `area` を `読取:<recipe>` にして、`title` に成績を入れる（同じ読み方は1行にまとまる）。
 */
/**
 * ★ 2026-11-15: ⚠ `supabase` を**静的に import しない**。
 *   静的にすると、純関数（`recipeKey` / `summarizeOutcomes`）だけ使いたいテストでも
 *   **DB の接続情報が無いと落ちる**（実測: `supabaseUrl is required`）。
 *   → DB を使う関数の中で**その時だけ**読み込む。
 */

/** 読み方の型（その時の設定の組み合わせ） */
export type ReadRecipe = {
  /** どのモデルか（`deepseek-flash` / `claude-haiku-4-5` など） */
  model: string;
  /** max_tokens（推論で使い切るので大きさが効く） */
  maxTokens: number;
  /** reasoning_effort（low / medium / high） */
  effort?: string;
  /** どこを読んだか（whole=画面全体 / left=左だけ / その他） */
  area?: "whole" | "left" | "other";
  /** 切り出す前の長辺（px・切り出さない時は 0） */
  imageSide?: number;
};

/** 1回の読み取りの結果 */
export type ReadOutcome = {
  ok: boolean;
  /** 読めた欄の数 */
  fields: number;
  /** かかった時間（ms） */
  ms: number;
  /** 読めなかった理由（ok=false の時） */
  why?: string | null;
};

/** 読み方の名前（1行にまとめるための鍵） */
export function recipeKey(r: ReadRecipe): string {
  const m = String(r.model || "?").replace(/[^a-z0-9.-]/gi, "").slice(0, 24);
  const e = String(r.effort || "-").slice(0, 6);
  const a = String(r.area || "whole");
  return `read:${m}:${r.maxTokens}:${e}:${a}`;
}

/** 人が読める1行 */
export function describeRecipe(r: ReadRecipe): string {
  return `${r.model}・max ${r.maxTokens}・${r.effort || "-"}・${r.area === "left" ? "左だけ" : "画面全体"}`;
}

/**
 * 成績を1行にまとめる（純関数）。
 *   ⚠ 同じ読み方（同じ recipe）なら**1行に足し込む**（枚数・欄・時間）。
 */
export function summarizeOutcomes(outs: ReadonlyArray<ReadOutcome>): {
  tried: number; ok: number; fields: number; ms: number; fieldsPerOk: number; okRate: number; topWhy: string | null;
} {
  const list = Array.isArray(outs) ? outs.filter((o) => o && typeof o === "object") : [];
  const okList = list.filter((o) => o.ok);
  const why: Record<string, number> = {};
  for (const o of list) {
    if (o.ok) continue;
    const k = String(o.why || "unknown").split(":")[0].slice(0, 30);
    why[k] = (why[k] || 0) + 1;
  }
  const top = Object.entries(why).sort((a, b) => b[1] - a[1])[0] ?? null;
  const fields = okList.reduce((s, o) => s + (Number(o.fields) || 0), 0);
  const ms = list.reduce((s, o) => s + (Number(o.ms) || 0), 0);
  return {
    tried: list.length,
    ok: okList.length,
    fields,
    ms,
    fieldsPerOk: okList.length ? Math.round((fields / okList.length) * 10) / 10 : 0,
    okRate: list.length ? Math.round((okList.length / list.length) * 100) : 0,
    topWhy: top ? `${top[0]}(${top[1]})` : null,
  };
}

/**
 * 読み方の成績を残す（`learn_improvements` に1行）。
 *   ⚠ 同じ読み方でも**日付ごとに1行**にする（良くなったかを見るため）。
 *   ⚠ 表が無い・書けない時は静かに諦める（学習そのものを止めない）。
 */
export async function saveReadRecipeScore(
  recipe: ReadRecipe,
  outs: ReadonlyArray<ReadOutcome>,
): Promise<{ ok: boolean; skipped?: string; error?: string; summary: ReturnType<typeof summarizeOutcomes> }> {
  const s = summarizeOutcomes(outs);
  try {
    if (!s.tried) return { ok: false, skipped: "no_data", summary: s };
    const { saveImprovement } = await import("./learn-improvements");
    const day = new Date().toISOString().slice(0, 10);
    const r = await saveImprovement({
      area: `読取`,
      title: `[${day}] ${describeRecipe(recipe)} → ${s.ok}/${s.tried}枚 読めた（欄 ${s.fields}個・1枚 ${s.fieldsPerOk}個）`,
      why: `読み方の成績（合格率 ${s.okRate}%）${s.topWhy ? `・読めない理由の最多は ${s.topWhy}` : ""}`,
      how: `model=${recipe.model} max_tokens=${recipe.maxTokens} effort=${recipe.effort ?? "-"} area=${recipe.area ?? "whole"}${recipe.imageSide ? ` 画像${recipe.imageSide}px` : ""}`,
      effect: `${s.tried}枚で ${s.ms}ms（1枚 ${Math.round(s.ms / Math.max(1, s.tried))}ms）`,
      verify: "npx tsx --env-file=.env.local scripts/read-recipes.ts",
      version: null,
    });
    return { ok: r.ok, skipped: r.skipped, error: r.error, summary: s };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 160), summary: s };
  }
}

/**
 * 読み方の成績を新しい順に読む（統括が「次はこの読み方で」と決めるための材料）。
 */
export async function recentReadRecipes(days = 14): Promise<Array<{ at: string; title: string; how: string; effect: string }>> {
  try {
    const { supabase } = await import("./supabase-server");
    const since = new Date(Date.now() - Math.max(1, days) * 86400_000).toISOString();
    const { data, error } = await supabase
      .from("learn_improvements")
      .select("at, title, how, effect")
      .eq("area", "読取")
      .gte("at", since)
      .order("at", { ascending: false })
      .limit(50);
    if (error) return [];
    return (data ?? []) as Array<{ at: string; title: string; how: string; effect: string }>;
  } catch {
    return [];
  }
}
