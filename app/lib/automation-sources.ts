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
 * 2026-09-30 自動便が60人×1人1命令（1人 約7〜9分＝午前だけで7〜9時間）になったので、古い順のままだと
 *   その間に積まれた手の検索（AIXツールの一括検索・AIX の指示・広げての続き）が何時間も自動便の後ろで待つ。
 *   今渡してよい物の中で、自動便（auto_schedule）でない物を先に渡す（同じ種類の中は古い順のまま）。
 *   自動便どうし（午前の残り → 午後）は古い順＝午前の続きが先。サイトへのアクセスは増えない（順番だけ）
 */
export function pickClaimable<T extends { payload?: unknown }>(commands: ReadonlyArray<T>, nowMs: number): T | null {
  const ok = commands.filter((c) => isClaimableNow(c.payload, nowMs));
  const srcOf = (c: T) => (c.payload && typeof c.payload === "object" ? (c.payload as Record<string, unknown>).source : null);
  return ok.find((c) => srcOf(c) !== "auto_schedule") ?? ok[0] ?? null;
}
/**
 * 2026-09-30 v2.5.48 手の命令（AIXツールの一括検索＝web_brain）が「リアプロがログインの画面の PC」に渡って失敗した
 *   （YUMA の2回とも待機中の PC 38f4be8b が先に拾い、リアプロは AXLX_TAB_DEAD）。
 *   拡張は拾いに来る時に、リアプロのタブが検索の画面（main.php）でなければ ?rp=0 を付ける。
 *   その PC には、リアプロを含む web_brain の命令を積んでから RP_NOT_READY_DEFER_MS の間は渡さない（＝状態の良い PC に先に拾わせる）。
 *   過ぎたら渡す（ブレインの PC が1台だけの時に止めない・ITANDI の分は進み、リアプロは今まで通り理由付きで見送る）。
 *   自動便（auto_schedule）・AIX は今まで通り（対象は手の命令だけ）。サイトへのアクセスは増えない
 */
export const RP_NOT_READY_DEFER_MS = 3 * 60 * 1000;
export function deferForRealproNotReady(
  row: { created_at?: string | null; payload?: unknown; sites?: ReadonlyArray<string> | null; command_type?: string | null },
  pc: { rpReady: boolean }, nowMs: number,
): boolean {
  if (pc.rpReady) return false;
  if (row.command_type === "stop_all") return false;
  const src = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>).source : null;
  if (src !== "web_brain") return false;
  const sites = Array.isArray(row.sites) ? row.sites : [];
  if (!sites.some((x) => x === "realnetpro" || x === "realpro")) return false;
  const s = waitStartMs(row);
  if (s === null) return false;
  return nowMs - s < RP_NOT_READY_DEFER_MS;
}
/**
 * 2026-09-30 拾う PC を指定した命令（payload.target_install）は、その PC にだけ渡す。
 *   ブレインの PC が複数ある時、待機中の別の PC（サイトがログイン画面のまま）が先に拾ってテストにならなかった（YUMA 19:07・19:14）。
 *   指定が無い命令は今まで通り（どの PC でも拾える）。stop_all は指定があっても全部の PC に渡す
 */
export function notForThisInstall(
  row: { payload?: unknown; command_type?: string | null }, installId: string | null,
): boolean {
  if (row.command_type === "stop_all") return false;
  const t = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>).target_install : null;
  if (typeof t !== "string" || !t) return false;
  return t !== installId;
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
/**
 * 2026-09-30 竹内「午前の便に時間制限があるなら改善する」: 自動便は60人×1人1命令で、1台の PC が1人ずつ（1人 約7〜9分）拾っていく。
 *   not_before から3時間で閉じると、拾い手が動いているのに後ろの人（開始から3時間より後に番が来る人）が「PC がなかった」で閉じていた。
 *   → 拾い手が動いている間（同じ拾い手の出どころの命令を最後に拾った・終えた時刻 pickerActiveAtMs）は、そこから3時間を数える
 *     （＝前の人が終わってから数える）。延ばすのは not_before から MAX_WAIT_WHILE_ACTIVE_MS まで（夜通しの古い指示で検索しない）。
 *   拾い手がいない（3時間どの命令も拾われていない）時は今まで通り閉じる。サイトへのアクセスは増えない（待つ長さだけ）
 */
export const MAX_WAIT_WHILE_ACTIVE_MS = 12 * 60 * 60 * 1000;
export function isPickerWaitExpired(row: { created_at?: string | null; payload?: unknown }, nowMs: number, pickerActiveAtMs?: number | null): boolean {
  const s = waitStartMs(row);
  if (s === null) return false;
  let start = s;
  const a = Number(pickerActiveAtMs);
  if (pickerActiveAtMs != null && Number.isFinite(a) && a > start) start = Math.min(a, s + MAX_WAIT_WHILE_ACTIVE_MS - WAIT_FOR_PICKER_MS);
  return nowMs - start > WAIT_FOR_PICKER_MS;
}

/** 拾い手が最後に動いた時刻（命令の picked_up_at・completed_at の一番新しい物）。無ければ null */
export function pickerActiveAt(rows: ReadonlyArray<{ picked_up_at?: string | null; completed_at?: string | null }>): number | null {
  let best: number | null = null;
  for (const r of rows ?? []) {
    for (const v of [r?.picked_up_at, r?.completed_at]) {
      const t = v ? Date.parse(v) : NaN;
      if (Number.isFinite(t) && (best === null || t > best)) best = t;
    }
  }
  return best;
}
