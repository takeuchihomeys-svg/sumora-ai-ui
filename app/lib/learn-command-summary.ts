// app/lib/learn-command-summary.ts
//
// 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする。その点も強化」
//
// なぜ要るか:
//   統括は `search_audits`（検索の結果）と `human_motion_learn`（人の動き）を見ていたが、
//   **`automation_commands`（現場への指示）を見ていなかった**。
//   そのため「検索は動いている」と言いながら、**指示が溜まったまま／失敗したまま**という
//   現場の詰まりを見落としていた（実測 1609行）。
//
// ⚠ 集計だけ（書き込まない・サイトを触らない）。純関数。

/** `automation_commands` の1行（必要な列だけ） */
export type CommandRow = {
  created_at?: string | null;
  /** 実際の列名（`automation_commands`）: `picked_up_at` / `completed_at` */
  picked_up_at?: string | null;
  completed_at?: string | null;
  status?: string | null;
  site?: string | null;
  /** 実際の列名: `command_type`（旧 `kind` ではない） */
  command_type?: string | null;
  sites?: unknown;
  error_message?: string | null;
};

export type CommandSummary = {
  total: number;
  done: number;
  failed: number;
  pending: number;
  running: number;
  /** 失敗の理由（多い順・最大5件） */
  errors: Array<{ error: string; n: number }>;
  /** 一番の問題を人が読める1文に */
  top_problem: string | null;
  /**
   * 2026-11-14 竹内さん「ここも調べる」→ 実測で分かった事:
   *   ⚠ **312件がエラー**で、そのうち **187件が「AIXモードのPCが3時間なかったため未実行で終了」**。
   *     つまり「指示の処理が壊れた」のではなく **拡張が自動/AIXモードになっていない時間が長すぎる**。
   *   → これを区別しないと「指示の処理を直す」と**誤った方向**に進む。
   */
  mode_absent?: {
    /** 「AIXモードのPCが3時間なかった」で終わった数 */
    aix_absent: number;
    /** 「ブレインモードのPCが…」で終わった数 */
    brain_absent: number;
  } | null;
};

/**
 * 指示の状態をまとめる（純関数）。
 * @param rows 直近の指示
 * @param opt.sinceMs 何ミリ秒前まで（既定 24時間）
 * @param opt.now いまの時刻（テスト用）
 * @param opt.staleMs これより長く pending/running のままなら「詰まっている」（既定 30分）
 */
export function summarizeCommands(
  rows: ReadonlyArray<CommandRow>,
  opt: { sinceMs?: number; now?: number; staleMs?: number } = {},
): CommandSummary {
  const list = Array.isArray(rows) ? rows : [];
  const now = typeof opt.now === "number" ? opt.now : Date.now();
  const since = now - (typeof opt.sinceMs === "number" ? opt.sinceMs : 24 * 3600_000);
  const stale = typeof opt.staleMs === "number" ? opt.staleMs : 30 * 60_000;

  let done = 0, failed = 0, pending = 0, running = 0, staleN = 0;
  const errN: Record<string, number> = {};

  const inWindow = list.filter((r) => {
    if (!r) return false;
    const t = r.created_at ? Date.parse(String(r.created_at)) : NaN;
    return !Number.isFinite(t) || t >= since;
  });

  for (const r of inWindow) {
    const s = String(r.status ?? "").toLowerCase();
    if (s === "done" || s === "completed" || s === "finished" || s === "success") done++;
    else if (s === "error" || s === "failed") failed++;
    else if (s === "running") {
      running++;
      // 実行中のまま古い＝詰まっている（列名は `picked_up_at`）
      const t = r.picked_up_at || r.created_at;
      const tt = t ? Date.parse(String(t)) : NaN;
      if (Number.isFinite(tt) && now - tt > stale) staleN++;
    } else if (s === "pending" || s === "queued" || s === "") {
      pending++;
      const t = r.created_at ? Date.parse(String(r.created_at)) : NaN;
      if (Number.isFinite(t) && now - t > stale) staleN++;
    }
    const er = String(r.error_message ?? "").trim();
    if (er) {
      const k = er.slice(0, 60);
      errN[k] = (errN[k] ?? 0) + 1;
    }
  }

  const errors = Object.entries(errN)
    .map(([error, n]) => ({ error, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);

  const total = inWindow.length;
  /**
   * 2026-11-14: 「拡張がモードになっていなかった」で終わった物を**別に数える**。
   *   ⚠ これを「失敗」と同じに扱うと、**直す所が違う**（指示の処理ではなく運用＝PCのモード）。
   */
  let aixAbsent = 0, brainAbsent = 0;
  for (const [k, v] of Object.entries(errN)) {
    if (/AIXモードのPCが.*なかった|AIXモードのPCが3時間なかった/.test(k)) aixAbsent += v;
    else if (/ブレインモードのPCが.*なかった/.test(k)) brainAbsent += v;
  }
  const modeAbsent = { aix_absent: aixAbsent, brain_absent: brainAbsent };

  let top_problem: string | null = null;
  const absentTotal = aixAbsent + brainAbsent;
  /**
   * 2026-11-14 竹内さん「ここも調べる」:
   *   ⚠ 優先順位を間違えない。**いま詰まっている（pending が古い）**方が、
   *     過去の失敗（モードが無かった）より**現場に効く**。
   *   → ① 拾われないまま → ② モードが無かった失敗 → ③ 失敗 → ④ 待ちが多い、の順。
   */
  if (staleN > 0) {
    top_problem = `拾われないまま ${staleN}件の指示が残っています（30分以上 pending/running のまま）。拡張が指示を取りに来ていません`;
  } else if (absentTotal > 0 && absentTotal >= Math.max(1, failed * 0.5)) {
    top_problem = `指示の失敗のうち ${absentTotal}件は「自動/AIXモードのPCが3時間なかった」ためです（指示の処理ではなく、拡張が自動/AIXモードになっていない時間が長い）`;
  } else if (failed > 0) {
    top_problem = `${total}件の指示のうち ${failed}件が失敗しています${errors[0] ? `（一番多い理由: ${errors[0].error}）` : ""}`;
  } else if (pending > 2) {
    top_problem = `まだ拾われていない指示が ${pending}件たまっています`;
  }

  return { total, done, failed, pending, running, errors, top_problem, mode_absent: modeAbsent };
}
