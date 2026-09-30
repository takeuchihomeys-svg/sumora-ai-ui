// app/lib/automation-sources.ts
// automation_commands（拡張が拾う検索のコマンド）の「どの PC がどの出どころを拾うか」を1か所に（純関数・DB 依存なし）。
//
// payload.source ごとの拾い手:
//   なし（null）     … どの PC でも（スタッフモードの PC は拡張側で拾いに来ない）
//   aix              … AIX連動の PC だけ（pending?aix=1）。2026-09-12
//   auto_schedule    … AIX連動の PC だけ（11:00/17:00 の自動便・ブレイン中は拡張が見送り）。2026-09-19
//   web_brain        … ブレインの PC だけ（pending?brain=1・🧠×スタッフは拡張が brain=1 を付けない）。2026-09-25
//                      竹内「チェックした物の一括検索。拡張ツールでブレインモードに選択していたら連動して検索。ブレインモードのみで連動」
// 拾い手が3時間いなければ error で閉じる（古い指示で後から検索しない）。
export const AIX_ONLY_SOURCES = ["aix", "auto_schedule"] as const;
export const BRAIN_ONLY_SOURCES = ["web_brain"] as const;
/** 拾い手を待つ上限（これを過ぎた pending は error で閉じる） */
export const WAIT_FOR_PICKER_MS = 3 * 60 * 60 * 1000;
export const AIX_EXPIRE_MESSAGE = "AIXモードのPCが3時間なかったため未実行で終了";
export const BRAIN_EXPIRE_MESSAGE = "ブレインモードのPCが3時間なかったため未実行で終了";

/**
 * 2026-09-30 v2.5.44 自動便（auto_schedule）のピンポイントから続いた広げて（chain・source は web_brain のまま）の印 payload.chain_picker。
 *   自動便は AIX モードの PC が拾うので、続きの広げても AIX モードの PC（ブレインでなくても）が拾えるようにする
 *   （今までは web_brain＝🧠 の PC だけ → 🧠 OFF・AIX の PC しか無い日は誰も拾わず3時間で閉じていた）
 */
export const CHAIN_PICKER_AIX_OR_BRAIN = "aix_or_brain";

/** この PC に渡さない出どころ */
export function excludedSourcesFor(pc: { aix: boolean; brain: boolean }): string[] {
  const out: string[] = [];
  if (!pc.aix) out.push(...AIX_ONLY_SOURCES);
  if (!pc.brain) out.push(...BRAIN_ONLY_SOURCES);
  return out;
}

/**
 * pending の問い合わせに付ける PostgREST の or 条件（渡さない出どころを除く）。除く物が無ければ null（絞らない）。
 *   例: aix も brain も無い PC → "payload->>source.is.null,and(payload->>source.neq.aix,payload->>source.neq.auto_schedule,payload->>source.neq.web_brain)"
 */
export function pendingSourceOrFilter(pc: { aix: boolean; brain: boolean }): string | null {
  const ex = excludedSourcesFor(pc);
  if (ex.length === 0) return null;
  const base = `payload->>source.is.null,and(${ex.map((s) => `payload->>source.neq.${s}`).join(",")})`;
  // AIX の PC（ブレインでない）は、自動便から続いた広げて（web_brain＋chain_picker）も拾う
  return pc.aix && !pc.brain ? `${base},payload->>chain_picker.eq.${CHAIN_PICKER_AIX_OR_BRAIN}` : base;
}

/** 手で押したウェブの一括検索（force なし）が「今動いているコマンド」として再利用してよい行か（拾い手の決まっている物は別物） */
export function isReusableForManualTrigger(source: string | null | undefined): boolean {
  if (!source) return true;
  return !(AIX_ONLY_SOURCES as readonly string[]).includes(source) && !(BRAIN_ONLY_SOURCES as readonly string[]).includes(source);
}

/**
 * 2026-09-27 竹内「開始時間を 11:00 と 17:00 ではなく…ランダムに毎日変える」:
 * payload.not_before（ISO）より前のコマンドは PC に渡さない。not_before が無い・読めない物は今までどおりすぐ渡す。
 */
export function notBeforeMs(payload: unknown): number | null {
  const v = payload && typeof payload === "object" ? (payload as Record<string, unknown>).not_before : null;
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
export function isClaimableNow(payload: unknown, nowMs: number): boolean {
  const nb = notBeforeMs(payload);
  return nb === null || nb <= nowMs;
}
/**
 * 拾い手を待つ3時間の数え始め＝not_before（あれば）・無ければ積んだ時刻。
 * 例: 10:00 に積んで not_before 11:02 の自動便は 14:02 まで待つ（積んだ時刻から数えると窓の遅い側の分だけ短くなる）
 */
export function waitStartMs(row: { created_at?: string | null; payload?: unknown }): number | null {
  const nb = notBeforeMs(row.payload);
  if (nb !== null) return nb;
  const c = row.created_at ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(c) ? c : null;
}
export function isPickerWaitExpired(row: { created_at?: string | null; payload?: unknown }, nowMs: number): boolean {
  const s = waitStartMs(row);
  return s !== null && nowMs - s > WAIT_FOR_PICKER_MS;
}
