// app/lib/page-cache.ts — 画面をまたいで残る読み込みの控え（モジュールの中の Map・画面の切り替えでは消えない・再読み込みで消える）
//
// 2026-10-06 ⑫ 竹内「LINEツールからaixツールに資料押して切り替える際もかなり重たかったけどそこも限定（今日の分）したら読み込み早くなって
//   切り替える際にストレスかからないようになっているのかな？」
//   下のタブ（next/link）で LINE ⇄ AIXツール を行き来するたびに、画面が作り直されて全部を読み直していた
//   （AIXツール: 物件顧客 全員の全列 1.66MB・3秒／ピックアップの一覧 102KB・3.7秒を親と子で2回。LINE: 会話の全件・物件顧客）。
//   → 読んだ物を控えておき、戻った時は控えをすぐ出して裏で新しくする（stale-while-revalidate）。同じ物を同時に2回読まない（in-flight の共有）
//   画面からも読む（DB・fetch に依存しない。読み方は呼び出し側が渡す）

type Entry = { value: unknown; at: number };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** 控えを返す（無い・古すぎる時は null）。maxAgeMs を超えた控えは出さない（古い物を見せ続けない） */
export function cacheGet<T>(key: string, maxAgeMs: number, now = Date.now()): { value: T; at: number; ageMs: number } | null {
  const e = store.get(key);
  if (!e) return null;
  const ageMs = now - e.at;
  if (ageMs > maxAgeMs) return null;
  return { value: e.value as T, at: e.at, ageMs };
}

export function cacheSet<T>(key: string, value: T, now = Date.now()): void {
  store.set(key, { value, at: now });
}

/** 控えの中身だけ差し替える（読んだ時刻は変えない＝画面で直した物を控えにも映す。読み直しの時期はずれない） */
export function cacheUpdate<T>(key: string, value: T): void {
  const e = store.get(key);
  if (e) store.set(key, { value, at: e.at });
}

/** 控えを捨てる（保存・削除の後に） */
export function cacheDrop(prefix: string): void {
  for (const k of [...store.keys()]) if (k === prefix || k.startsWith(prefix)) store.delete(k);
}

/**
 * 読み込み（同じ鍵が読み込み中なら同じ約束を返す＝二重に読まない）。読めたら控えに入れる。
 *   freshMs 以内の控えがあれば読まずに控えを返す（force で読み直す）
 */
export async function cachedLoad<T>(key: string, loader: () => Promise<T>, opts: { freshMs?: number; force?: boolean; now?: () => number } = {}): Promise<T> {
  const now = opts.now ?? Date.now;
  if (!opts.force && opts.freshMs != null) {
    const hit = cacheGet<T>(key, opts.freshMs, now());
    if (hit) return hit.value;
  }
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const v = await loader();
      cacheSet(key, v, now());
      return v;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** テスト用: 控えを全部捨てる */
export function cacheClearAll(): void { store.clear(); inflight.clear(); }
