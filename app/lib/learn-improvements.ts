// app/lib/learn-improvements.ts
//
// 2026-11-14 竹内さん「また今日強化されたら『強化した』と統括に保存しておくようにする」
//   「今日一日でかなり質が上がったかな」
//
// なぜ要るか:
//   今日は70コミット分の強化をしたが、**どこにも「何を強化したか」が残っていない**。
//   `learn_supervisor_log` には「判断」は残るが、**何を直した結果どう変わったか**は残らない。
//   → 強化した内容を**1件ずつ**記録する（`learn_improvements`）。
//     ・何を（title）
//     ・なぜ（why・実測の数字）
//     ・どう直したか（how）
//     ・効くはずの所（effect）
//     ・確かめ方（verify）
//   ⚠ 入れるのは**仕組みの話だけ**（お客様の名前・入力した中身・住所は入れない）。
import { supabase } from "./supabase-server";

/** 1件の強化（記録する形） */
export type Improvement = {
  /** どの分野か（拡張 / 統括 / 検索 / 学習 / 自動） */
  area: string;
  /** 何を強化したか（1行・人が読める） */
  title: string;
  /** なぜ（実測の数字を必ず入れる・推測で書かない） */
  why: string;
  /** どう直したか */
  how: string;
  /** 効くはずの所（どの数字が動けば効いたと言えるか） */
  effect: string;
  /** 確かめ方（コマンドや見る所） */
  verify?: string | null;
  /** 版（拡張の版・無ければ null） */
  version?: string | null;
};

/** 保存する形に整える（純関数・DBに触らない） */
export function toImprovementRow(x: Improvement, nowIso?: string): Record<string, unknown> {
  const s = (v: unknown, n: number) => String(v == null ? "" : v).trim().slice(0, n);
  return {
    area: s(x.area, 20) || "other",
    title: s(x.title, 200),
    why: s(x.why, 600),
    how: s(x.how, 900),
    effect: s(x.effect, 400),
    verify: x.verify ? s(x.verify, 300) : null,
    version: x.version ? s(x.version, 20) : null,
    at: nowIso ?? new Date().toISOString(),
  };
}

/**
 * 強化を1件記録する。
 *   ⚠ 同じ `title` が既にあれば足さない（何度も呼ばれても増えない）。
 *   ⚠ 表が無いDBでは静かに諦める（学習そのものを止めない）。
 */
export async function saveImprovement(x: Improvement): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  try {
    const row = toImprovementRow(x);
    if (!row.title) return { ok: false, skipped: "no_title" };
    const dup = await supabase.from("learn_improvements").select("id").eq("title", row.title).limit(1);
    if (!dup.error && Array.isArray(dup.data) && dup.data.length) return { ok: true, skipped: "same_title" };
    const ins = await supabase.from("learn_improvements").insert(row);
    if (ins.error) {
      const missing = /does not exist|42P01|Could not find the table|schema cache/i.test(String(ins.error.message || ""));
      return { ok: false, skipped: missing ? "no_table" : undefined, error: String(ins.error.message).slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && (e as Error).message) || e).slice(0, 200) };
  }
}

/** 何件・どの分野を強化したか（統括が「今日はこれだけ強化した」と言える形） */
export async function improvementSummary(days = 1): Promise<{
  total: number;
  byArea: Array<{ area: string; n: number }>;
  recent: Array<{ at: string; area: string; title: string; effect: string }>;
  error?: string;
}> {
  try {
    const since = new Date(Date.now() - Math.max(1, days) * 86400_000).toISOString();
    const { data, error } = await supabase
      .from("learn_improvements")
      .select("at, area, title, effect")
      .gte("at", since)
      .order("at", { ascending: false })
      .limit(200);
    if (error) return { total: 0, byArea: [], recent: [], error: String(error.message).slice(0, 200) };
    const rows = (data ?? []) as Array<{ at: string; area: string; title: string; effect: string }>;
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.area, (m.get(r.area) ?? 0) + 1);
    return {
      total: rows.length,
      byArea: [...m.entries()].map(([area, n]) => ({ area, n })).sort((a, b) => b.n - a.n),
      recent: rows.slice(0, 12),
    };
  } catch (e) {
    return { total: 0, byArea: [], recent: [], error: String((e && (e as Error).message) || e).slice(0, 200) };
  }
}
