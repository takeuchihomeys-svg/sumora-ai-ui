// app/lib/learn-audit-summary.ts
//
// 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」
//
// なぜ要るか:
//   統括（learn-supervisor）は `human_motion_learn`（人の動きの記録）だけを見ていた。
//   そのため **実際の検索が 93% 途中で止まっている**（`search_audits` の実測: abandoned 56/60）
//   のに、統括は「学べています（自動検索に渡してよい）」と言っていた。
//   → `search_audits`（実際の検索の結果・どこで止まったか・なぜ失敗したか）を
//     統括の判断材料に**つなぐ**。これが無いと統括は現場の現実を知らない。
//
// ⚠ 集計だけをする（DBに書かない・サイトを触らない）。純関数。

/** `search_audits` の1行（必要な列だけ） */
export type AuditRow = {
  created_at?: string | null;
  status?: string | null;
  site?: string | null;
  mode?: string | null;
  area_mode?: string | null;
  cause_key?: string | null;
  error?: string | null;
  error_kind?: string | null;
  severity?: string | null;
  /**
   * ⚠ 2026-11-15: **実際に読んでいる列**（人の操作が何手入ったかを見る）。
   *   型に無かったため、`summarizeAudits` の「人の検索は操作10手以上で完走」判定が
   *   **効かないまま**だった（統括が「完走率8%」と誤解した原因の1つ）。
   */
  filled?: unknown;
  steps?: unknown;
  result?: unknown;
  ext_version?: string | null;
};

/** 実際の検索がどこで止まったか */
export type AuditSummary = {
  /** 元にした回数 */
  runs: number;
  /** 完走した回数 */
  finished: number;
  /** 途中で止まった回数（abandoned） */
  abandoned: number;
  /** いま走っている回（started） */
  started: number;
  /**
   * ⭐ 2026-11-15: **判断できない回**（操作の記録が1手も無い）。
   *   ⚠ 古い版（2.5.91 等）は `filled.ops` を送っていなかったので、
   *     「止まった」のか「動いたが記録が無い」のか**区別できない**。
   *     これを `abandoned` に混ぜると完走率が実際より低く出る（統括が誤解する）。
   *   → **別に数える**（`finish_rate` の分母からも外す）。
   */
  unknown: number;
  /** 完走率（0〜100） */
  finish_rate: number;
  /** 止まった場所（段の名前 → 回数） */
  stalled_at: Array<{ stage: string; n: number }>;
  /** 失敗の種類（cause_key の前半 → 回数） */
  causes: Array<{ cause: string; n: number }>;
  /** 実際に出たエラーの言葉（上位） */
  errors: Array<{ error: string; n: number }>;
  /** 特に重い物（severity=bad）の数 */
  bad: number;
  /** いま一番多い「止まり方」を人が読める1文に */
  top_problem: string | null;
  /** その時に**どこを疑うか**（`top_problem` に対する次の一手） */
  advice?: string | null;
};

/** 段の名前を人が読める日本語に（`search_audits.steps` の k） */
const STAGE_JA: Record<string, string> = {
  fill_start: "条件を入れ始めた",
  location: "場所の判定",
  area_open_by_class: "所在地絞り込みを開く",
  area_open_by_area: "所在地絞り込みを開く",
  area_open_retry: "所在地絞り込みを開き直す",
  area_open_fail: "所在地絞り込みが開かない",
  area_preclear: "前の地域を外す",
  area_prev_clear: "前の地域を外す",
  ward: "区を選ぶ",
  ward_by_code: "区を選ぶ（コード）",
  ward_fix: "区を選び直す",
  ward_verified: "区がそろった",
  ward_verify_fail: "区がそろわない",
  modal: "所在地の小窓",
  modal_confirm: "確定してリストへ",
  modal_close: "小窓を閉じる",
  next_step: "次の段へ",
  town: "町字を選ぶ",
  station: "沿線・駅絞り込み",
  station_line: "沿線を選ぶ",
  station_next_press: "駅の設定へ進む",
  station_confirm: "駅を確定",
  sel_pick: "プルダウンを選ぶ",
  sel_not_found: "プルダウンに見つからない",
  txt_pick: "文字を入力",
  search: "検索を押す",
  search_look: "検索の前に見直す",
  search_look_done: "見直し済み",
  search_look_skip: "見直しを飛ばす",
  search_wait: "条件の反映待ち",
  search_guard_press: "25秒押されていない→検索",
  gate_retry: "条件を入れ直す",
  gate_warn: "条件が画面と違う",
  stall_recover_search: "止まったので検索を押す",
  done: "終わった",
  finish: "終わった",
  done_error: "エラーで終わった",
  fallback_area: "地域をあきらめて区だけ",
  area_force_search: "区1つで検索へ",
  learn_aim: "学んだ位置で押す",
  learn_kind: "学んだ種類で押す",
  learn_weak: "弱い欄",
  learn_order: "学んだ順に並べる",
};

/** 段の名前を人が読める形に */
export function stageLabel(k: unknown): string {
  const s = String(k ?? "").trim();
  if (!s) return "(不明)";
  return STAGE_JA[s] || s.replace(/^page:/, "");
}

/** cause_key の前半を人が読める形に（`stalled:realpro:none` → 途中で止まった） */
function causeLabel(k: unknown): string {
  const s = String(k ?? "").trim();
  if (!s) return "(理由なし)";
  const head = s.split(":")[0];
  const ja: Record<string, string> = {
    stalled: "途中で止まった",
    error: "エラーで終わった",
    condition_drift: "条件が画面とずれた",
    area_mismatch: "地域がそろわなかった",
    next_page: "次のページへ進めなかった",
    timeout: "時間切れ",
  };
  return ja[head] || head;
}

/**
 * `search_audits` の行をまとめる（純関数）。
 * @param rows 直近の検索の1回ずつ
 * @param opt.sinceMs 何ミリ秒前までを対象にするか（既定 24時間）
 * @param opt.now いまの時刻（テスト用）
 */
export function summarizeAudits(
  rows: ReadonlyArray<AuditRow>,
  opt: { sinceMs?: number; now?: number } = {},
): AuditSummary {
  const list = Array.isArray(rows) ? rows : [];
  const now = typeof opt.now === "number" ? opt.now : Date.now();
  const since = now - (typeof opt.sinceMs === "number" ? opt.sinceMs : 24 * 3600_000);
  const inWindow = list.filter((r) => {
    if (!r) return false;
    const t = r.created_at ? Date.parse(String(r.created_at)) : NaN;
    return !Number.isFinite(t) || t >= since;
  });

  let finished = 0, abandoned = 0, started = 0, bad = 0, unknown = 0;
  const stageN: Record<string, number> = {};
  const causeN: Record<string, number> = {};
  const errN: Record<string, number> = {};
  /**
   * ★ 2026-11-15 **実測で見つけた集計の誤り**（統括が「完走率8%」と誤解した原因）:
   *
   *   ⚠ `brain_normal / single` が **完走20回・止まり385回**になっていた。
   *     ところが止まった回にも**人の操作が 1016手**入っていた（＝人が最後まで操作していた）。
   *   なぜか: 人の検索（通常・スタッフモード）は**結果の取り込みが無い**ので
   *     `finished` を送る経路が無く、20分後に見回りが `abandoned` にしていた。
   *     → **止まっていない回が「止まった」に数えられていた**。
   *
   *   → 人の検索は**「最後まで操作したか」で完走を判断する**（操作が10手以上あれば完走扱い）。
   *     ⚠ 画面の変更はしない（集計だけ）。拡張側も v2.7.85 で閉じるように直したので、
   *       これからは `finished` が来る（古い記録のためにもこの判定は残す）。
   */
  const opsCount = (r: AuditRow): number => {
    const f = (r as { filled?: unknown }).filled;
    if (!f || typeof f !== "object") return 0;
    const ops = (f as { ops?: unknown }).ops;
    return Array.isArray(ops) ? ops.length : 0;
  };
  const isHumanMode = (r: AuditRow): boolean => /brain_normal|brain_staff|human_trace/i.test(String(r.mode ?? ""));

  for (const r of inWindow) {
    const s = String(r.status ?? "").toLowerCase();
    const opsN = opsCount(r);
    const humanDone = isHumanMode(r) && opsN >= 10;
    /**
     * 判断できない回（操作の記録が無い）。`abandoned` に混ぜない。
     *   ⚠ `finished` は記録が無くても完走（エラー無しで終わった）と分かるので残す。
     */
    const unknowable = s !== "finished" && opsN === 0 && !String(r.error ?? "").trim();
    if (s === "finished" || humanDone) finished++;
    else if (unknowable) unknown++;
    else if (s === "abandoned") abandoned++;
    else if (s === "started") started++;

    if (String(r.severity ?? "").toLowerCase() === "bad") bad++;

    const c = causeLabel(r.cause_key);
    causeN[c] = (causeN[c] ?? 0) + 1;

    const er = String(r.error ?? "").trim();
    if (er) {
      const k = er.slice(0, 60);
      errN[k] = (errN[k] ?? 0) + 1;
    }

    /**
     * 止まった場所: `steps` の**最後の段**（`page:` を除く）。
     *   ⚠ `steps` が空（`started` のまま）の回は、**`finished` が来なかった**回
     *     （PCを閉じた・タブを閉じた・20分たった）。`steps` は `finished` の時だけ送られるので、
     *     **何も動かなかったのではなく「動いた記録が届かなかった」**。
     *   → 「(段が残っていない)」ではなく **「終わりの合図が来なかった」** と言う（正しく伝える）。
     */
    const steps = Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>) : [];
    if (s !== "finished" && !humanDone && !unknowable) {
      let last = "";
      for (let i = steps.length - 1; i >= 0; i--) {
        const k = String(steps[i]?.k ?? "").replace(/^page:/, "").trim();
        if (!k) continue;
        // 「学んだ」「点検」系は止まった場所ではない（動きの記録）ので飛ばす
        if (/^(learn_|area_open_retry|area_preclear|area_prev_clear|sel_pick|txt_pick)/.test(k)) continue;
        last = k;
        break;
      }
      const label = last ? stageLabel(last) : "終わりの合図が来なかった（steps が届いていない）";
      stageN[label] = (stageN[label] ?? 0) + 1;
    }
  }

  const toArr = (o: Record<string, number>, key: string, cap = 6) =>
    Object.entries(o).map(([k, n]) => ({ [key]: k, n } as never)).sort((a, b) => (b as { n: number }).n - (a as { n: number }).n).slice(0, cap);

  const runs = inWindow.length;
  /**
   * ⚠ 2026-11-15: **判断できない回は分母から外す**（`unknown`）。
   *   古い版（操作の記録を送っていない）の回を「止まり」に混ぜると、
   *   完走率が実際より低く出て統括が誤解する（実測: 8% → 58% に直った）。
   */
  const judged = Math.max(0, runs - unknown);
  const finish_rate = judged > 0 ? Math.round((finished / judged) * 100) : 0;
  const stalled_at = toArr(stageN, "stage") as Array<{ stage: string; n: number }>;
  const causes = toArr(causeN, "cause") as Array<{ cause: string; n: number }>;
  const errors = toArr(errN, "error") as Array<{ error: string; n: number }>;

  /**
   * 一番の問題を1文で。
   *   ⚠ 「完走率」だけでなく**どこで止まるか**を言う（直す所が分かるように）。
   *   ⚠ 「終わりの合図が来なかった」が一番多い時は、**直す所が違う**（検索の手順ではなく記録の経路）。
   *     その時は「なぜ合図が来ないか」を言う（PCを閉じた・タブを閉じた・20分たった）。
   */
  let top_problem: string | null = null;
  let advice: string | null = null;
  if (judged > 0 && finish_rate < 90) {
    const topStage = stalled_at[0];
    if (topStage && topStage.stage.startsWith("終わりの合図が来なかった")) {
      top_problem = `${judged}回のうち ${finished}回しか完走していません（${finish_rate}%）。うち ${topStage.n}回は「終わりの合図が来なかった」回です`;
      advice = "検索の手順ではなく**記録の経路**を疑う（PC・タブを閉じた／20分たって見回りに拾われた／finished が届いていない）";
    } else {
      top_problem = topStage
        ? `${judged}回のうち ${finished}回しか完走していません（${finish_rate}%）。一番多いのは「${topStage.stage}」で止まる（${topStage.n}回）`
        : `${judged}回のうち ${finished}回しか完走していません（${finish_rate}%）`;
    }
  }

  return {
    runs, finished, abandoned, started, unknown, finish_rate,
    stalled_at, causes, errors, bad, top_problem, advice,
  };
}
