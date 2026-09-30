// app/lib/search-audit-daily.ts — 検索の点検の「毎日のまとめ」（純関数・DB の依存なし）
//
// 2026-09-30 竹内「最終的に自動で検索して回して、出来てない部分は改善の改善ループもできるようになるんかな？監視ツールを活かして」
//   改善ループの1段目: 点検の記録（search_audits）を1日分まとめ、人が気づく前に「今日おかしかった所」を出す。
//   9/30 は「ITANDI の区の検索が 7回中6回止まった」「同じ自動入力が2本走った」「物件が別のお客様に付いた」を、
//   YUMA のテストの記録を人が読んで初めて見つけた。同じ物を毎日決まった形で数えて出す。
//   ここは数えるだけ（LLM なし）。原因の見立て・直しの案は次の段（週のまとめ・人の確認）。
import type { AuditCheck } from "./search-audit-check";

export type DailyAuditRow = {
  created_at: string;
  finished_at?: string | null;
  site?: string | null;
  area_mode?: string | null;
  trigger?: string | null;
  status?: string | null;
  error?: string | null;
  error_kind?: string | null;
  checks?: AuditCheck[] | null;
  ext_version?: string | null;
};

export type DailyGroup = { key: string; site: string; mode: string; runs: number; failed: number; avg_min: number | null; top_error: string | null };
export type DailyDigest = {
  runs: number;
  failed: number;
  groups: DailyGroup[];
  bad_causes: Array<{ cause_key: string; title: string; count: number }>;
  double_fill: number;
  owner_mismatch: number;
  login_expired: number;
  versions: Array<{ version: string; runs: number }>;
  alerts: string[];
};

const SITE_JA: Record<string, string> = { realpro: "リアプロ", realnetpro: "リアプロ", itandi: "ITANDI", reins: "レインズ" };
const MODE_JA: Record<string, string> = { ward: "区", station: "駅", both: "区と駅" };

/** 失敗した回か（人が止めた回は失敗に数えない） */
export function isFailedRun(r: DailyAuditRow): boolean {
  if (r.error_kind === "stopped") return false;
  return !!(r.error && String(r.error).trim()) || r.status === "abandoned";
}

/** 失敗の理由を短い札に（同じ形を数えるため） */
export function errorLabel(error: string | null | undefined): string {
  const e = String(error ?? "");
  if (!e) return "終わらなかった";
  if (/AXLX_TAB_DEAD/.test(e)) return "検索の画面でない（ログイン切れ等）";
  if (/AXLX_OWNER_MISMATCH/.test(e)) return "物件の付け先が別のお客様";
  if (/AXLX_RESET_FAILED/.test(e)) return "前のお客様の条件を外せない";
  if (/AXLX_NO_FILL_START/.test(e)) return "入力が始まらない";
  if (/AXLX_NO_LOCATION/.test(e)) return "地域を決められない";
  if (/AXLX_SEARCH_BLOCKED/.test(e)) return "検索のボタンが押せない";
  if (/watchdog|見張りの時間切れ/.test(e)) return "入力の途中で時間切れ";
  if (/fill-done/.test(e)) return "完了の合図が来ない";
  if (/無進捗/.test(e)) return "進まないまま終了";
  return e.slice(0, 30);
}

const verNum = (v: string) => v.split(".").map((x) => Number(x) || 0);
const verLt = (a: string, b: string) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); } return false; };

/** 1日分の点検の行をまとめる。alerts は「人に知らせる事」だけ（決まった線で出す・線は下の定数） */
export const ALERT_MIN_RUNS = 3;      // この回数以上ある組だけ、失敗の割合で知らせる
export const ALERT_FAIL_RATE = 0.4;   // 4割以上失敗（9/30 の ITANDI の区は 35回中15回＝43%）
export function buildDailyDigest(rows: ReadonlyArray<DailyAuditRow>): DailyDigest {
  const groups = new Map<string, { site: string; mode: string; runs: number; failed: number; mins: number[]; errs: Map<string, number> }>();
  const causes = new Map<string, { title: string; count: number }>();
  const versions = new Map<string, number>();
  let failed = 0, doubleFill = 0, ownerMismatch = 0, loginExpired = 0;
  for (const r of rows) {
    const site = String(r.site ?? "?"), mode = String(r.area_mode ?? "-");
    const key = `${site}:${mode}`;
    const g = groups.get(key) ?? groups.set(key, { site, mode, runs: 0, failed: 0, mins: [], errs: new Map() }).get(key)!;
    const isGhost = (r.checks ?? []).some((c) => c.code === "DOUBLE_FILL");
    if (isGhost) { doubleFill++; continue; } // 幽霊の行（同じ自動入力の2本目）は回数に入れない
    g.runs++;
    if (isFailedRun(r)) {
      failed++; g.failed++;
      const l = errorLabel(r.error);
      g.errs.set(l, (g.errs.get(l) ?? 0) + 1);
      if (/AXLX_TAB_DEAD/.test(String(r.error ?? ""))) loginExpired++;
    }
    if (r.finished_at) {
      const ms = Date.parse(r.finished_at) - Date.parse(r.created_at);
      if (Number.isFinite(ms) && ms > 0 && ms < 3 * 3600_000) g.mins.push(ms / 60_000);
    }
    for (const c of r.checks ?? []) {
      if (c.severity !== "bad") continue;
      if (c.code === "OWNER_MISMATCH") ownerMismatch++;
      const x = causes.get(c.cause_key) ?? causes.set(c.cause_key, { title: c.title, count: 0 }).get(c.cause_key)!;
      x.count++;
    }
    if (r.ext_version) versions.set(r.ext_version, (versions.get(r.ext_version) ?? 0) + 1);
  }
  const groupList: DailyGroup[] = [...groups.entries()].filter(([, g]) => g.runs > 0).map(([key, g]) => ({
    key, site: g.site, mode: g.mode, runs: g.runs, failed: g.failed,
    avg_min: g.mins.length ? Math.round((g.mins.reduce((a, b) => a + b, 0) / g.mins.length) * 10) / 10 : null,
    top_error: [...g.errs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  })).sort((a, b) => b.failed / Math.max(1, b.runs) - a.failed / Math.max(1, a.runs) || b.runs - a.runs);
  const badCauses = [...causes.entries()].map(([cause_key, v]) => ({ cause_key, title: v.title, count: v.count })).sort((a, b) => b.count - a.count).slice(0, 8);
  const versionList = [...versions.entries()].map(([version, runs]) => ({ version, runs })).sort((a, b) => (verLt(a.version, b.version) ? 1 : -1));
  const runs = groupList.reduce((a, g) => a + g.runs, 0);

  const alerts: string[] = [];
  for (const g of groupList) {
    if (g.runs >= ALERT_MIN_RUNS && g.failed / g.runs >= ALERT_FAIL_RATE) {
      alerts.push(`${SITE_JA[g.site] ?? g.site}の${MODE_JA[g.mode] ?? g.mode}の検索が ${g.runs}回中${g.failed}回失敗${g.top_error ? `（多い理由: ${g.top_error}）` : ""}`);
    }
  }
  if (ownerMismatch > 0) alerts.push(`物件の付け先が別のお客様になりかけた回が ${ownerMismatch}回（送っていない）`);
  if (doubleFill > 0) alerts.push(`同じ自動入力が2本走った回が ${doubleFill}回（拡張が v2.5.48 より前の PC）`);
  if (loginExpired >= 2) alerts.push(`検索の画面でない（ログイン切れ等）で飛ばした回が ${loginExpired}回`);
  if (versionList.length > 1) {
    const newest = versionList[0].version;
    const old = versionList.filter((v) => verLt(v.version, newest));
    if (old.length) alerts.push(`古い版の拡張で動いた回がある（最新 ${newest}・${old.map((v) => `${v.version} が${v.runs}回`).join("、")}）＝その PC の再読み込みが要る`);
  }
  return { runs, failed, groups: groupList, bad_causes: badCauses, double_fill: doubleFill, owner_mismatch: ownerMismatch, login_expired: loginExpired, versions: versionList, alerts };
}

/** 人が読む形（AIXツールの画面・スクリプトの出力） */
export function digestLines(d: DailyDigest): string[] {
  const L: string[] = [];
  L.push(`検索 ${d.runs}回（失敗 ${d.failed}回）`);
  if (d.alerts.length) { L.push("■ 知らせる事"); for (const a of d.alerts) L.push(`・${a}`); } else L.push("■ 知らせる事はありません");
  L.push("■ サイト×探し方");
  for (const g of d.groups) L.push(`・${SITE_JA[g.site] ?? g.site}／${MODE_JA[g.mode] ?? g.mode}: ${g.runs}回・失敗 ${g.failed}回${g.avg_min != null ? `・平均 ${g.avg_min}分` : ""}${g.top_error ? `・多い理由: ${g.top_error}` : ""}`);
  if (d.bad_causes.length) { L.push("■ 重い札"); for (const c of d.bad_causes) L.push(`・${c.title}（${c.cause_key}）: ${c.count}回`); }
  if (d.versions.length) L.push(`■ 拡張の版: ${d.versions.map((v) => `${v.version}（${v.runs}回）`).join("・")}`);
  return L;
}
