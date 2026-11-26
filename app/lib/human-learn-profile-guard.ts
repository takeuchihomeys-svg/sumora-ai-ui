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

/**
 * 営業時間（JST 9〜22時）に、古くなった束を**その場で作り直さない**か（純関数）。
 *   ⚠ 2026-11-20 竹内さん「今すぐすべて行う」（負荷対策）。営業時間は1万行の集計を拡張の呼び出しで回さない。
 *   ⚠ 2026-11-15 の決め「束の更新は1日1回だけ。すぐ反映したいなら手で実行が必要」と合う（手動の ?refresh=1 は今まで通り）。
 *   ⚠ 束が1件も無い時は作る（拡張が「何も無い」で止まらないように）。?fresh=1 は強制なので作る。
 *   戻す: HUMAN_LEARN_DAYTIME_REBUILD=on（昼も古い束を作り直す＝旧の動き）
 */
/**
 * 2026-11-21 作業員G（竹内さん「拡張ツールの部分ちゃんと API 連携できているのか」）:
 *   11/20 22:01〜22:51 JST に拡張の GET（kix1）が 60秒の時間切れで計12回（ログで見えた分・統括役の数え 16:05〜23:05 で37回）。
 *   全部「印を取って作り直す側」（build-lease の decision=build）で、作り直しが 60秒を超えて途中で切れていた（他の要求は serve_old で返っていた）。
 *   → 古い束がある時は、印を取った要求も**古い束をすぐ返し、作り直しは応答の後（after）**で行う（拡張は待たない・失敗しても束は返る）。
 *   束が無い時・?fresh=1 は今まで通りその場で作る。既定 on（戻す: LEARN_BUILD_AFTER=off）
 */
export function learnBuildAfterOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LEARN_BUILD_AFTER ?? "").trim().toLowerCase() !== "off";
}

/**
 * 2026-11-21 作業員G（台帳 #588・測り: all の作り直しは1本だけなら 35.6秒・本番の 22時台は realpro・itandi・all が同時に走って 130〜200秒）:
 *   作り直しの印（build_leases）を束の種類ごとではなく全部で1本にして、同時に走らせず順番に作る。
 *   応答の後の作り直しは、印が他で使われていれば LANE_WAIT_STEP_MS ごとに取り直し、LANE_WAIT_MAX_MS を超えたら諦める（古い束のまま・次の呼び出しで作る）。
 *   既定 on（11/22・止める LEARN_BUILD_ONE_LANE=off）
 */
export function learnBuildOneLaneOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  // 2026-11-22 土台の点検の差 0 を確かめて既定 on（止める: LEARN_BUILD_ONE_LANE=off）
  return (env.LEARN_BUILD_ONE_LANE ?? "").trim().toLowerCase() !== "off";
}
export const LANE_WAIT_STEP_MS = 15_000;
/** 応答の後の待ちの上限（maxDuration 300秒の中で、待ち＋1本の作り直し 約35〜60秒が収まる） */
export const LANE_WAIT_MAX_MS = 150_000;
export function buildLeaseKey(scope: string, env?: Record<string, string | undefined>): string {
  return learnBuildOneLaneOn(env) ? "human-learn-profile:lane" : `human-learn-profile:${scope}`;
}
/** 印が取れなかった時に、次に待つ ms（待たない時は null）。waited は今までに待った ms */
/**
 * 2026-11-25 夜 作業員L（統括役の了承・本番の時間切れ 10回／1時間・22:00〜22:07）: 22時に拡張の呼び出しが2秒で約30本来て、
 *   応答の後の作り直しが1本だけ作り・残りは全部が印を最大150秒待った（作り直し 177〜297秒と合わせて 300秒を超えた）。
 *   既定で、応答の後に印が他に取られていたら待たずにやめる（古い束のまま・次の呼び出しか 22:20 の cron で作る）。前の待つ動きは LEARN_AFTER_WAIT_LANE=on
 */
export function learnAfterWaitLaneOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LEARN_AFTER_WAIT_LANE ?? "").trim().toLowerCase() === "on";
}
export function laneNextWait(o: { lease: string; inAfter: boolean; waitedMs: number; env?: Record<string, string | undefined> }): number | null {
  if (!learnBuildOneLaneOn(o.env) || !o.inAfter || o.lease !== "held") return null;
  if (!learnAfterWaitLaneOn(o.env ?? (typeof process !== "undefined" ? process.env : {}))) return null;
  return o.waitedMs + LANE_WAIT_STEP_MS <= LANE_WAIT_MAX_MS ? LANE_WAIT_STEP_MS : null;
}

/** 応答の後に作り直すか（古い束があり・強制でない時だけ） */
export function buildInAfter(o: { hasBundle: boolean; forceFresh: boolean; env?: Record<string, string | undefined> }): boolean {
  return learnBuildAfterOn(o.env) && o.hasBundle && !o.forceFresh;
}

/** 営業時間の止めの終わり（JST の分・既定 22:30）。2026-11-25 夜 作業員L: 22:00 ちょうどに止めが外れて拡張のまとめての呼び出しで作り直しが重なった（時間切れ 10回）。
 *  22:20 の cron が1回だけ作るよう、止めを 22:30 まで延ばす。HUMAN_LEARN_HOLD_UNTIL=22:00 で前の動き */
export function holdUntilMin(env: Record<string, string | undefined>): number {
  const m = String(env.HUMAN_LEARN_HOLD_UNTIL ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 22 * 60 + 30;
}
export function holdDaytimeRebuild(o: { hour: number; minute?: number; hasBundle: boolean; forceFresh: boolean; env?: Record<string, string | undefined> }): boolean {
  const env = o.env ?? (typeof process !== "undefined" ? process.env : {});
  if ((env.HUMAN_LEARN_DAYTIME_REBUILD ?? "").trim().toLowerCase() === "on") return false;
  if (o.forceFresh || !o.hasBundle) return false;
  const now = o.hour * 60 + (o.minute ?? 0);
  return o.hour >= 9 && now < holdUntilMin(env);
}

export function shouldTouchRead(readAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  const t = Date.parse(String(readAt ?? ""));
  return !Number.isFinite(t) || nowMs - t >= READ_MARK_MIN_GAP_MS;
}

/**
 * ★ 2026-11-27: 22:20 cron 等が作った長期（7日超・30日）の束が、31分後の 3日 buildNow で即上書きされるのを防ぐ。
 *   作成から 12 時間以内の長期束は stale にしない（?fresh=1 / ?refresh=1 なら再生成する）。
 *   戻す: LEARN_KEEP_LONG_CRON_BUNDLE=off
 */
export const LONG_BUNDLE_MIN_SPAN_MS = 7 * 86_400_000;
export const LONG_BUNDLE_KEEP_AGE_MS = 12 * 3600_000;
export function shouldPreserveLongCronBundle(o: {
  createdAt?: string | null;
  sourceFrom?: string | null;
  sourceTo?: string | null;
  forceFresh?: boolean;
  nowMs?: number;
  env?: Record<string, string | undefined>;
}): boolean {
  const env = o.env ?? (typeof process !== "undefined" ? process.env : {});
  if ((env.LEARN_KEEP_LONG_CRON_BUNDLE ?? "").trim().toLowerCase() === "off") return false;
  if (o.forceFresh) return false;
  const createdMs = Date.parse(String(o.createdAt ?? ""));
  const fromMs = Date.parse(String(o.sourceFrom ?? ""));
  const toMs = Date.parse(String(o.sourceTo ?? ""));
  if (!Number.isFinite(createdMs) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return false;
  const now = o.nowMs ?? Date.now();
  const ageMs = now - createdMs;
  const spanMs = toMs - fromMs;
  return spanMs >= LONG_BUNDLE_MIN_SPAN_MS && ageMs >= 0 && ageMs < LONG_BUNDLE_KEEP_AGE_MS;
}

/** CDN のキャッシュの見出し（軽い確認は30秒・束は60秒・古くても5分は返しながら裏で取り直す・v不整合や再構築時はno-store） */
export function cacheHeaders(kind: "light" | "bundle" | "none"): Record<string, string> {
  if (kind === "none") return { "Cache-Control": "no-store, no-cache, must-revalidate" };
  const s = kind === "light" ? 30 : 60;
  return { "Cache-Control": `public, s-maxage=${s}, stale-while-revalidate=300` };
}

/** 束の版クエリ文字列を作る（拡張が ?touch=0 で検知した新版を本体 URL の &v=... に載せて CDN 旧キャッシュを確実にバイパスする） */
export function bundleVersionParam(o?: {
  generated_at?: unknown;
  playbook_rules_v?: unknown;
  playbook_build_v?: unknown;
} | null): string {
  const src = o && typeof o === "object" ? o : {};
  const gen = String(src.generated_at ?? "").trim().replace(/[^0-9A-Za-z._:-]/g, "");
  const rv = String(src.playbook_rules_v ?? "").trim().slice(0, 12).replace(/[^0-9A-Za-z_-]/g, "");
  const bv = Number(src.playbook_build_v) || 0;
  return [gen || "0", rv || "0", String(bv)].join("_");
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
