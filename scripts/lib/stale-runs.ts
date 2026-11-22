// scripts/lib/stale-runs.ts — 穴の型①「作ったのに回っていない」の決め（純関数・作業員N・2026-11-21・台帳 #505）
//
// 統括役 11/21（竹内さん「他に土台として弱い部分があれば強化する そして細部も強化する」）: 今日見つかった穴の5つの型の①。
//   実例: self-improve の growth:*・core:* は作ったのに、全部の回しを流す所が無く quality_daily に1行も無かった（d48c10c0d で直した）。
//   見る物: cron（vercel.json の予定 × cron_run_logs の最後の時刻）と、毎日の数（期待する metric × quality_daily の最後の日）。
//   線: 予定が1日1回以上の cron は 26時間、週1回の cron は 8日を超えて書かれていなければ穴。1度も書かれていなければ「一度も回っていない」。
//       毎日の数は、最後の日が今日（JST）から2日より前なら穴（主の日が前の前の日のため2日の余裕）。

export type StaleKind = "cron_never" | "cron_stale" | "metric_never" | "metric_stale";
export type Stale = { kind: StaleKind; name: string; last: string | null; expectHours: number; owner: string; why: string };

/** cron の予定（5つの欄）から、何時間ごとに回るはずか（1日に1回以上なら 24・週1なら 168・月1なら 744）。読めなければ null */
export function cronPeriodHours(schedule: string): number | null {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [, , dom, , dow] = f;
  if (dom !== "*" && !/^\*\//.test(dom)) return 744;
  if (dow !== "*") return dow.split(",").length >= 5 ? 24 : 168;
  return 24;
}

/** cron の path（/api/cron/<名前>?mode=..）から cron_run_logs の名前 */
export function cronNameOf(path: string): string | null {
  const m = /\/api\/cron\/([^?/]+)/.exec(path);
  return m ? m[1] : null;
}

/** 点検の期待から外す cron（わざと止めている物・理由つき）。2026-11-21 統括役の確かめ */
export const STALE_CRON_SKIP: Record<string, string> = {
  "aix-analyze-diffs": "DEPRECATED 2026-08-20（analyze-diffs の Step6 に移した）。11/21 に vercel.json から外した（統括役の決め・route は POST だけで GET の cron では 405 だった）",
  "keep-warm": "既定オフ（KEEP_WARM=on の時だけ動き、off の時は記録の前に返す）。9/19 から off＝止まっているのは決めどおり",
};

/**
 * 記録（withCronLog）を足した時刻（本番に入った時刻）。これより後に予定の1周＋余裕が過ぎるまでは「一度も無い」にしない（まだ予定の時刻が来ていない）。
 * 2026-11-22 作業員N2（統括役の頼み・台帳 #552）: 31本に記録を足した a3cf01173 が本番に入ったのは 11/21 23:16 JST（Vercel の本番 50987a567・最初の記録は takeuchi-anatomy 23:30）。
 *   11/22 7:30 JST の時点で、予定の時刻が来た14本は全部記録があり、記録の無い18本はどれもまだ予定の時刻が来ていなかった（週1・月曜・JST 10時以降など）
 */
export const CRON_LOG_WRAP_SINCE_ISO = "2026-11-21T14:16:00Z";

export function staleCronsOf(crons: ReadonlyArray<{ path: string; schedule: string }>, lastByName: ReadonlyMap<string, string | null>, nowMs: number, ownerOf: (name: string) => string = () => "統括役", wrapSinceIso: string = CRON_LOG_WRAP_SINCE_ISO): Stale[] {
  const wrapSinceMs = Date.parse(wrapSinceIso);
  const byName = new Map<string, number>();
  for (const c of crons) {
    const n = cronNameOf(c.path), h = cronPeriodHours(c.schedule);
    if (!n || h == null) continue;
    byName.set(n, Math.min(byName.get(n) ?? Infinity, h));
  }
  const out: Stale[] = [];
  for (const [name, h] of byName) {
    if (STALE_CRON_SKIP[name]) continue;
    const grace = h <= 24 ? 26 : h <= 168 ? 8 * 24 : 33 * 24;
    if (!lastByName.has(name)) continue; // 読めなかった名前は判定しない（呼ぶ側が読めた名前だけ渡す）
    const last = lastByName.get(name) ?? null;
    // 記録を足してから予定の1周＋余裕が過ぎていない＝まだ予定の時刻が来ていないかもしれない（一度も無いと決めない）
    if (!last && Number.isFinite(wrapSinceMs) && (nowMs - wrapSinceMs) / 3_600_000 <= grace) continue;
    if (!last) { out.push({ kind: "cron_never", name, last: null, expectHours: h, owner: ownerOf(name), why: `予定はあるのに cron_run_logs に1度も無い（cron-logger を通していない か 回っていない）` }); continue; }
    const age = (nowMs - Date.parse(last)) / 3_600_000;
    if (age > grace) out.push({ kind: "cron_stale", name, last, expectHours: h, owner: ownerOf(name), why: `${Math.round(age)}時間 書かれていない（${h}時間ごとの予定・線 ${grace}時間）` });
  }
  return out.sort((a, b) => (a.last ?? "").localeCompare(b.last ?? ""));
}

export function staleMetricsOf(expected: ReadonlyArray<{ metric: string; owner: string }>, lastDayOf: ReadonlyMap<string, string | null>, todayJst: string): Stale[] {
  const out: Stale[] = [];
  const lim = new Date(Date.parse(`${todayJst}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
  for (const e of expected) {
    const last = lastDayOf.get(e.metric) ?? null;
    if (!last) out.push({ kind: "metric_never", name: e.metric, last: null, expectHours: 24, owner: e.owner, why: "毎日の数のはずなのに quality_daily に1度も無い" });
    else if (last < lim) out.push({ kind: "metric_stale", name: e.metric, last, expectHours: 24, owner: e.owner, why: `最後の日 ${last}（${lim} より前）` });
  }
  return out;
}
