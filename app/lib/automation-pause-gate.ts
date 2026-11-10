// app/lib/automation-pause-gate.ts（純関数＋止めの印を読む小さな関数・画面からも import してよい＝サーバー専用の物を import しない）
//
// 2026-11-10 竹内さんの答え（統括役経由）「古い版をサーバーで断る＋16件は残す」:
//   ① /api/automation/pending は、拾いに来た拡張の版（x-ext-version）が最小の版より古い・無い時は指示を渡さない（pending のまま残す）。
//      最小の版は env AUTOMATION_MIN_EXT_VERSION（既定 2.5.77＝光って選択するモード GUIDE_ONLY が入った版）。"off" で版を見ない。
//      理由: 2.5.77 より前の拡張（11/10 時点で 2.5.48 brain_aix・2.5.51 brain_normal の PC が残っている）は GUIDE_ONLY を持たず、
//      止めの印を外すと昔の自動の動き（欄に直接書き込み・自動送信）で拾う。止めの印の間も、古い PC が pending を呼ぶと
//      たまった指示を全部取り消していた（11/04 まで aix の 138件が消えた）。
//   ② 止めの印（automation_settings.paused=true）の間は、AIX・広げての仕組み・見張りの再検索が新しい指示を積まない（記録だけ）。
//      今ある指示は消さない（pending の取り消しは AUTOMATION_PAUSE_CANCEL_PENDING=on の時だけ＝昔の動き）。
//   拡張の中（モード・GUIDE_ONLY）は Cursor の担当（chrome-extension/AUTO_MODE_HANDOFF.md）。

export const MIN_EXT_VERSION_DEFAULT = "2.5.77";

/** "2.5.91" → [2,5,91]。形が違えば null */
export function parseExtVersion(v: string | null | undefined): number[] | null {
  const s = String(v ?? "").trim();
  if (!/^\d{1,4}(\.\d{1,4}){0,3}$/.test(s)) return null;
  return s.split(".").map((x) => Number(x));
}

/** a<b → 負・同じ → 0・a>b → 正（足りない桁は 0） */
export function compareExtVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 最小の版（env）。"off" → null（版を見ない）。形が違う値は既定に戻す */
export function minExtVersion(env: Record<string, string | undefined> = process.env): string | null {
  const raw = String(env.AUTOMATION_MIN_EXT_VERSION ?? "").trim();
  if (raw.toLowerCase() === "off") return null;
  return parseExtVersion(raw) ? raw : MIN_EXT_VERSION_DEFAULT;
}

export type ExtVersionGate =
  | { ok: true; min: string | null; got: string | null }
  | { ok: false; reason: "ext_version_missing" | "ext_version_too_old"; min: string; got: string | null; message: string };

/** 拾いに来た拡張の版で、指示を渡してよいか（版が無い・読めない・古い → 渡さない） */
export function extVersionGate(got: string | null | undefined, env: Record<string, string | undefined> = process.env): ExtVersionGate {
  const min = minExtVersion(env);
  const g = got == null ? null : String(got).trim() || null;
  if (!min) return { ok: true, min: null, got: g };
  const gv = parseExtVersion(g);
  if (!gv) return { ok: false, reason: "ext_version_missing", min, got: g, message: `拡張の版が分からないため指示を渡しません（${min} 以上に更新してください）` };
  if (compareExtVersion(gv, parseExtVersion(min)!) < 0) {
    return { ok: false, reason: "ext_version_too_old", min, got: g, message: `拡張の版 ${g} は古いため指示を渡しません（${min} 以上に更新してください）` };
  }
  return { ok: true, min, got: g };
}

/** 止めの印の間に pending を取り消すか（既定 off＝残す。on は 10/02〜11/10 の昔の動き） */
export function cancelPendingWhilePaused(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.AUTOMATION_PAUSE_CANCEL_PENDING ?? "").trim().toLowerCase() === "on";
}

/** 止めの印の間に新しい指示を積まないか（既定 on。AUTOMATION_PAUSE_BLOCK_ENQUEUE=off で昔の動き＝積む） */
export function blockEnqueueWhilePaused(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.AUTOMATION_PAUSE_BLOCK_ENQUEUE ?? "").trim().toLowerCase() !== "off";
}

/** automation_settings の行から止めの印を読む（行が無い・読めない → false＝止めない。pending・cron・trigger と同じ線） */
export function pausedFromRow(row: unknown): boolean {
  return !!(row && typeof row === "object" && (row as { paused?: unknown }).paused === true);
}

/** supabase のクライアント（型を広く受ける＝supabase-js の型の世代に縛られない） */
type SettingsReader = { from: (t: string) => unknown };
type SettingsQuery = {
  select: (c: string) => { eq: (k: string, v: number) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> } };
};

/** 止めの印を読む（読めない時は false） */
export async function readAutomationPaused(sb: SettingsReader): Promise<boolean> {
  try {
    const q = sb.from("automation_settings") as SettingsQuery;
    const { data, error } = await q.select("paused").eq("id", 1).maybeSingle();
    if (error) return false;
    return pausedFromRow(data);
  } catch {
    return false;
  }
}

/**
 * 積む前の関所: 止めの印の間は積まない（記録の1行を出す）。true＝積んでよい。
 *   積もうとした物は console に tag "automation-paused-skip" で残す（Vercel のログで数えられる）
 */
export async function mayEnqueueAutomation(
  sb: SettingsReader,
  info: { by: string; customerId?: string | null; sites?: ReadonlyArray<string | null | undefined>; source?: string | null; note?: string | null },
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (!blockEnqueueWhilePaused(env)) return true;
  if (!(await readAutomationPaused(sb))) return true;
  console.log(JSON.stringify({
    tag: "automation-paused-skip", by: info.by, customer: info.customerId ? String(info.customerId).slice(0, 8) : null,
    sites: info.sites ?? null, source: info.source ?? null, note: info.note ?? null,
  }));
  return false;
}
