// app/lib/human-learn-profile-guard.ts — /api/human-learn-profile（拡張が読む学習の束）の守り（純関数＋同じ所の重なりをまとめる道具）
//
// 2026-11-15 作業員H（統括役の頼み・11/15 01:40〜01:43Z の DB の止まりの調べ・竹内さん「バックデータはこっちやで、拡張ツールの部分も」）:
//   01:40:43〜01:40:55Z に拡張（大阪の端末・Vercel の kix1）からこの経路へ約130回の呼び出しが重なり、DB には
//   human_learn_profile の GET 452件（平均 2.8秒・最大 7.8秒）と PATCH 302件（全部 同じ1行 id=1556 の read_count）が12秒に集まった。
//   その後 01:42〜01:43Z に主キーの1行の読みまで 15秒かかる止まりになった（PostgREST の処理の打ち切り 約90件・statement timeout）。
//   原因の3つ（受ける側で直せる物）:
//     ① 版だけ見る軽い確認（?touch=0）でも束の全体（bundle・1行 約40KB・表は600行 23MB）を読んでいた
//     ② 読むたびに同じ1行へ read_count を書いていた＝同じ行の鍵の取り合い（書き込みが1列に並ぶ）
//     ③ 束が30分より古いと、重なった呼び出しの数だけ束を作り直していた（1回 約15秒・数千行を読む）
//   守り（HUMAN_LEARN_PROFILE_GUARD・既定 on・=off で戻す）:
//     ・軽い確認は版（bundle->>generated_at）だけ読む
//     ・読んだ印は前の印から10分たった時だけ、応答の後で書く
//     ・応答に CDN の短いキャッシュ（s-maxage）を付ける＝同じ時に来た同じ要求は CDN が1つにまとめる（関数も DB も動かない）
//     ・同じ関数の中で重なった同じ読み・作り直しは1本にまとめる（coalesce）。作ってから5分は作り直さない
type Env = Record<string, string | undefined>;
export function learnProfileGuardOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.HUMAN_LEARN_PROFILE_GUARD ?? "").trim().toLowerCase() !== "off"; // 11/15 統括役の決め: DB の止まりを防ぐ守りなので既定 on（=off で戻す）
}
/** 読んだ印を書く間（この間に読んでも印は書かない） */
export const READ_MARK_MIN_GAP_MS = 10 * 60_000;
/** 束を作ってから作り直さない間 */
export const LEARN_BUILD_MIN_GAP_MS = 5 * 60_000;

export function shouldTouchRead(readAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  const t = Date.parse(String(readAt ?? ""));
  return !Number.isFinite(t) || nowMs - t >= READ_MARK_MIN_GAP_MS;
}

/** CDN のキャッシュの見出し（軽い確認は30秒・束は60秒・古くても5分は返しながら裏で取り直す） */
export function cacheHeaders(kind: "light" | "bundle"): Record<string, string> {
  const s = kind === "light" ? 30 : 60;
  return { "Cache-Control": `public, s-maxage=${s}, stale-while-revalidate=300` };
}

/** 同じ鍵の重なった呼び出しを1本にまとめる（on でない時はそのまま呼ぶ）。終わったら外す */
const inflight = new Map<string, Promise<unknown>>();
export function coalesce<T>(key: string, on: boolean, fn: () => PromiseLike<T>): Promise<T> {
  if (!on) return Promise.resolve(fn());
  const cur = inflight.get(key) as Promise<T> | undefined;
  if (cur) return cur;
  const p = Promise.resolve(fn()).finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}
/** テスト用: 今まとめている数 */
export function inflightCount(): number { return inflight.size; }
