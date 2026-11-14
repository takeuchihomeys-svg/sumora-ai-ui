/**
 * 改善されたかを**確認して記録する**（2026-11-14 竹内さん）
 *
 *   竹内さん「改善されたと確認したら更新されるように統括の部分ちゃんと把握して改善していくようにする」
 *     「統括の部分ちゃんと何かあれば強化していくように必要な部分強化していく」
 *
 * 何をするか:
 *   ① 統括の判断（`learn_supervisor_log` の最新2件）を比べる（材料・弱い所・順番・場所）
 *   ② 前回より**良くなった物**と**悪くなった物**を出す
 *   ③ 直した事（設計知見の P0/P1）が**記録から確認できたか**を1つずつ確かめる
 *   ④ 結果を `learn_improvements` に残す（統括が次回「前回から」で見られるように）
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/check-improvements.ts
 *   npx tsx --env-file=.env.local scripts/check-improvements.ts --json
 *   npx tsx --env-file=.env.local scripts/check-improvements.ts --save   # learn_improvements に残す
 *
 * ⚠ 読むだけ（DBのデータは変えない）。`--save` の時だけ記録を1行足す。
 */
import { supabase } from "../app/lib/supabase-server";
import { saveImprovement } from "../app/lib/learn-improvements";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const doSave = args.includes("--save");
const jst = (i: unknown) => new Date(new Date(String(i)).getTime() + 9 * 3600e3).toISOString().slice(5, 19).replace("T", " ");

type LogRow = {
  created_at: string;
  scope: string;
  verdict: string | null;
  coverage: number | null;
  weak_n: number | null;
  next_n: number | null;
  points_n: number | null;
  sequence_n: number | null;
  with_ops: number | null;
  rows: number | null;
  /**
   * ⚠ `learn_supervisor_log` には **`bundle` 列が無い**（`bundle_at` だけ・実測）。
   *   束の中身は `/api/human-learn-profile` から取る（`bundle` を select すると失敗する）。
   */
  delta: Record<string, number> | null;
  actions: Array<{ name?: string; what?: string; how?: string }> | null;
};

/** 直近の統括の判断を取る（scope ごとに新しい2件） */
async function recentByScope(): Promise<Map<string, LogRow[]>> {
  const { data, error } = await supabase
    .from("learn_supervisor_log")
    .select("created_at, scope, verdict, coverage, weak_n, next_n, points_n, sequence_n, with_ops, rows, delta, actions")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) {
    console.warn("[check-improvements] 統括の記録を読めません:", error.message);
    return new Map();
  }
  const out = new Map<string, LogRow[]>();
  for (const r of (data ?? []) as LogRow[]) {
    const k = String(r.scope || "all");
    if (!out.has(k)) out.set(k, []);
    const list = out.get(k)!;
    if (list.length < 2) list.push(r);
  }
  return out;
}

/** 増えた/減ったを言葉にする（良い向きが決まっている物だけ） */
function trend(before: number | null, after: number | null, betterIsHigher: boolean, label: string): string | null {
  const b = Number(before);
  const a = Number(after);
  if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
  const d = a - b;
  if (d === 0) return null;
  const good = betterIsHigher ? d > 0 : d < 0;
  return `${label} ${b}→${a}（${d > 0 ? "+" : ""}${d}・${good ? "改善" : "悪化"}）`;
}

void (async () => {
  const byScope = await recentByScope();
  if (!byScope.size) {
    console.log("統括の判断がまだありません（/api/human-learn-profile を1回呼んでください）");
    return;
  }
  const report: Array<Record<string, unknown>> = [];
  if (!asJson) console.log("改善されたかを確認する（統括の前回との比較）\n" + "─".repeat(70));

  for (const [scope, list] of byScope) {
    const [now, prev] = list;
    if (!now) continue;
    const lines: string[] = [];
    const trends: string[] = [];
    if (prev) {
      const t1 = trend(prev.coverage, now.coverage, true, "材料");
      const t2 = trend(prev.weak_n, now.weak_n, false, "弱い所");
      const t3 = trend(prev.next_n, now.next_n, true, "押す順番");
      const t4 = trend(prev.sequence_n, now.sequence_n, true, "一連の動き");
      const t5 = trend(prev.with_ops, now.with_ops, true, "操作つきの記録");
      for (const t of [t1, t2, t3, t4, t5]) if (t) trends.push(t);
      const good = trends.filter((t) => t.includes("改善")).length;
      const bad = trends.filter((t) => t.includes("悪化")).length;
      lines.push(`前回(${jst(prev.created_at)}) → 今回(${jst(now.created_at)})`);
      lines.push(`  改善 ${good}件 / 悪化 ${bad}件${trends.length ? "" : "（変化なし）"}`);
      for (const t of trends) lines.push("    ・" + t);
    } else {
      lines.push(`今回(${jst(now.created_at)}) だけ（比べる前回がありません）`);
    }
    lines.push(`  いま: ${now.verdict || "-"}／材料 ${now.coverage ?? "-"}／弱い所 ${now.weak_n ?? "-"}件`);

    /**
     * ★ 直した事が**記録から確認できたか**（竹内さんの「改善されたと確認したら更新」）。
     *   ⚠ 統括の点数ではなく**現場の記録**で確かめる（点数は材料の数で動くので、改善の証拠にならない）。
     *   ⚠ 束の中身は `/api/human-learn-profile` から取る（`learn_supervisor_log` に `bundle` 列は無い）。
     */
    const checks: Array<{ what: string; ok: boolean | null; why: string }> = [];
    try {
      const base = process.env.NEXT_PUBLIC_SITE_URL || "https://sumora-ai-ui.vercel.app";
      /**
       * ⚠ `touch=0` は**軽い版**（版だけ返す・束を返さない）。中身を見るには**束を取る**必要がある。
       *   重い（実測 1.9秒）が、確認は1回だけなので取る。
       */
      const res = await fetch(`${base}/api/human-learn-profile?scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
      const j = (await res.json()) as { bundle?: Record<string, unknown> };
      const b = (j.bundle ?? {}) as Record<string, unknown>;
      const dropped = Array.isArray(b.dropped_cols) ? (b.dropped_cols as unknown[]).map(String) : [];
      checks.push({
        what: "「押したら何が開いたか」(opens) が捨てられていない",
        ok: dropped.length === 0 ? true : !dropped.includes("opens"),
        why: dropped.length ? "捨てた列: " + dropped.join(",") : "捨てた列なし",
      });
      const weak = Array.isArray(b.weak) ? (b.weak as Array<{ kind?: string }>) : [];
      const walk = weak.filter((w) => String(w?.kind) === "walk_reset").length;
      checks.push({
        what: "徒歩が消える原因（walk_reset）を統括が把握している",
        ok: walk > 0 ? false : true,
        why: walk > 0 ? "移動手段の選び直しが記録に残っている（直す対象）" : "徒歩の選び直しは見つからない",
      });
      const sf = Array.isArray(b.scene_flows) ? (b.scene_flows as Array<{ scene?: string; steps?: unknown[] }>) : [];
      const withSteps = sf.filter((f) => Array.isArray(f.steps) && f.steps.length >= 2).length;
      checks.push({
        what: "押し方（場面ごとの手順）が作れている",
        ok: withSteps > 0 ? true : false,
        why: sf.length ? `${sf.length}場面のうち${withSteps}場面に手順がある` : "場面の手順が0件（材料が足りない）",
      });
      const pts = (b.points ?? {}) as Record<string, { w_src?: string }>;
      const photo = Object.values(pts).filter((v) => String(v?.w_src) === "photo").length;
      checks.push({
        what: "写真から読んだ欄の種類が入っている",
        ok: photo > 0 ? true : false,
        why: `photo ${photo}個 / 全体 ${Object.keys(pts).length}個`,
      });
    } catch (e) {
      checks.push({ what: "確認できませんでした", ok: null, why: String((e as Error)?.message || e).slice(0, 80) });
    }

    if (!asJson) {
      for (const l of lines) console.log(`  [${scope}] ${l}`);
      console.log("  直した事の確認:");
      for (const c of checks) {
        const mark = c.ok === true ? "✅" : c.ok === false ? "⚠" : "?";
        console.log(`    ${mark} ${c.what}  … ${c.why}`);
      }
      console.log("");
    }
    report.push({ scope, at: now.created_at, trends, checks });
  }

  if (asJson) {
    console.log(JSON.stringify({ report }, null, 1));
    return;
  }

  /**
   * 記録に残す（`--save` の時だけ）。
   *   ⚠ 統括は次回 `improvements`（今日なにを強化したか）として読む。
   */
  if (doSave) {
    const areas = report.map((r) => ({
      area: String(r.scope),
      n: (r.checks as Array<{ ok: boolean | null }>).filter((c) => c.ok === true).length,
    }));
    const r = await saveImprovement({
      area: "学習の確認",
      title: "統括の改善を確認（" + report.map((x) => x.scope).join("/") + "）",
      why: "竹内さん「改善されたと確認したら更新されるように統括の部分ちゃんと把握して改善していく」",
      how: "learn_supervisor_log の前回と今回を比べ、直した事が記録から確認できたかを1つずつ確かめた",
      effect: report.map((x) => String(x.scope) + ": " + (x.trends as string[]).join(" / ")).join(" ｜ ").slice(0, 400),
      at: new Date().toISOString(),
    } as never);
    console.log("記録しました: " + (r.ok ? "OK" : "NG（" + r.skipped + "）"));
    console.log("  確認できた項目: " + areas.map((a) => a.area + " " + a.n + "件").join(" / "));
  } else {
    console.log("（記録に残す時は --save を付けてください）");
  }
})();
