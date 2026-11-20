// app/lib/build-lease.ts — 重い作り直しを「全体の中で1本だけ」にする DB の印（build_leases の1行・期限つき）
//
// 2026-11-20 作業員H（統括役の頼み・11/20 10:24〜10:38 の DB の再起動の直後に /api/human-learn-profile で時間切れ 181回・利用者1人・拡張）:
//   束が古い時の作り直し（buildNow・1回 約15秒・数千行を読む）は、同じ関数の中だけ coalesce でまとめていた。
//   Vercel は呼び出しを別々の関数の箱（kix1・iad1 など）に配るので、箱の数だけ作り直しが重なり、戻ったばかりの DB を埋めた
//   （ログ 01:37〜01:39Z に kix1 と iad1 の両方で「引き継ぎsolid」＝作り直しが続けて出ている）。
//   ※ advisory lock は PostgREST の接続が呼び出しごとに替わるので保てない → 期限つきの行（主キーで1つだけ入る）にする。
//   取り方: 行を入れる → 入れば取れた。主キーがぶつかったら、期限の切れた行だけ消してもう1回入れる（同時に2つが消しても主キーで1つだけ入る）。
//   取れない（他が作っている）時と、作り直しに失敗した時は、呼ぶ側が古い束を返す。
//   表が無い（migrate の前）時だけ今まで通り（その箱の中で1本）。表はあるが書けない（DB が重い・時間切れ）時は作らない（古い束を返す）。
//   止める: BUILD_LEASE=off（今まで通り＝その箱の中だけで1本）
export type LeaseErr = { code?: string | null; message: string } | null;
export type LeaseDb = {
  insert(row: { key: string; holder: string; until: string }): Promise<{ error: LeaseErr }>;
  deleteExpired(key: string, nowIso: string): Promise<{ error: LeaseErr }>;
  release(key: string, holder: string): Promise<{ error: LeaseErr }>;
};
export type LeaseResult = "acquired" | "held" | "no_table" | "unavailable";

export function buildLeaseOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BUILD_LEASE ?? "").trim().toLowerCase() !== "off";
}
/** 表がまだ無い（migrate の前）か */
export function isMissingTable(e: LeaseErr): boolean {
  return !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|Could not find the table|schema cache/i.test(e.message));
}
const isConflict = (e: LeaseErr) => !!e && (e.code === "23505" || /duplicate key|unique constraint/i.test(e.message));

/** 印を取る（期限 ttlMs）。DB は呼ぶ側が渡す（テストでは偽物） */
export async function tryAcquireLease(db: LeaseDb, key: string, holder: string, ttlMs: number, nowMs: number = Date.now()): Promise<LeaseResult> {
  const row = { key, holder, until: new Date(nowMs + ttlMs).toISOString() };
  try {
    const a = await db.insert(row);
    if (!a.error) return "acquired";
    if (isMissingTable(a.error)) return "no_table";
    if (!isConflict(a.error)) return "unavailable";
    const d = await db.deleteExpired(key, new Date(nowMs).toISOString());
    if (d.error) return isMissingTable(d.error) ? "no_table" : "unavailable";
    const b = await db.insert(row);
    if (!b.error) return "acquired";
    return isConflict(b.error) ? "held" : isMissingTable(b.error) ? "no_table" : "unavailable";
  } catch {
    return "unavailable";
  }
}
/** 作り終えた（失敗も）ら外す。外せなくても期限で切れる */
export async function releaseLease(db: LeaseDb, key: string, holder: string): Promise<void> {
  try { await db.release(key, holder); } catch { /* 期限で切れる */ }
}

/**
 * 作り直してよいか（純関数）。lease＝印の取り方の結果、hasBundle＝古くても返せる束があるか。
 *   build: 作る ／ serve_old: 作らずに古い束を返す ／ empty_wait: 束が無く他が作っている（空を返し、拡張は次の呼び出しで受け取る）
 */
export function buildDecision(lease: LeaseResult, hasBundle: boolean): "build" | "serve_old" | "empty_wait" {
  if (lease === "acquired" || lease === "no_table") return "build";
  if (hasBundle) return "serve_old";
  // 束が1件も無い時: 他が作っている（held）なら待つ。印が書けない（DB が重い）時も重ねない＝待つ
  return "empty_wait";
}

/** supabase の表 build_leases を使う LeaseDb（サーバーの supabase を渡す） */
type SbLike = { from(t: string): { insert(r: unknown): PromiseLike<{ error: { code?: string; message: string } | null }>; delete(): { eq(c: string, v: string): { lt(c: string, v: string): PromiseLike<{ error: { code?: string; message: string } | null }>; eq(c: string, v: string): PromiseLike<{ error: { code?: string; message: string } | null }> } } } };
export function supabaseLeaseDb(sb: SbLike): LeaseDb {
  return {
    insert: async (row) => { const r = await sb.from("build_leases").insert(row); return { error: r.error ? { code: r.error.code ?? null, message: r.error.message } : null }; },
    deleteExpired: async (key, nowIso) => { const r = await sb.from("build_leases").delete().eq("key", key).lt("until", nowIso); return { error: r.error ? { code: r.error.code ?? null, message: r.error.message } : null }; },
    release: async (key, holder) => { const r = await sb.from("build_leases").delete().eq("key", key).eq("holder", holder); return { error: r.error ? { code: r.error.code ?? null, message: r.error.message } : null }; },
  };
}
