// app/lib/list-snapshot.ts — 会話の一覧の「端末の控え」（直近の一覧の行を端末に残し、開いた時に先に出す・純関数＋保存先は呼ぶ側が渡す）
//
// 2026-10-28 一覧が「読み込み中」で固まる件（10/22 04:20〜05:00・10/27 10:30〜10:50 UTC）:
//   打ち切りの1位は一覧の問い合わせだったが、表は小さく（conversations 426行）、DB 全体が止まっていた（要求の数が5分で153件まで落ち・
//   チェックポイントの書き出しに 41〜101秒）。DB が止まっている間も画面は前に見ていた一覧を出せるように、最初の40件（要る列だけ）を
//   端末に控え、開いた時に先に出す。最初の読み込みには短い打ち切りを付け、打ち切られても控えを出したまま静かな読み直しに任せる。
//   控えは直近の行だけ（メッセージ本文は入れない・一覧の行に出ている物＝最後の発言の頭だけ）・24時間で捨てる。
// スイッチ: NEXT_PUBLIC_LIST_SNAPSHOT=on（既定 off＝今と同じ）

export const LIST_SNAPSHOT_KEY = "sumora_conv_list_snapshot_v1";
export const LIST_SNAPSHOT_MAX_AGE_MS = 24 * 3600_000;
export const LIST_SNAPSHOT_ROWS = 40;
export const LIST_FIRST_PAGE_TIMEOUT_MS = 6000;

export function listSnapshotOn(v: string | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "on";
}

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem?(k: string): void };

/** 一覧の行（要る列だけ）を控える。保存できなければ黙って諦める（控えは便利のためだけ） */
export function saveListSnapshot<T extends { id: unknown }>(store: Store | null | undefined, rows: ReadonlyArray<T>, nowMs: number = Date.now()): boolean {
  if (!store || !rows.length) return false;
  try {
    store.setItem(LIST_SNAPSHOT_KEY, JSON.stringify({ savedAt: nowMs, rows: rows.slice(0, LIST_SNAPSHOT_ROWS) }));
    return true;
  } catch { return false; }
}

/** 控えを読む。無い・壊れている・古い（24時間超）時は null（古い物は消す） */
export function loadListSnapshot<T>(store: Store | null | undefined, nowMs: number = Date.now()): T[] | null {
  if (!store) return null;
  try {
    const raw = store.getItem(LIST_SNAPSHOT_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as { savedAt?: number; rows?: unknown };
    if (typeof j.savedAt !== "number" || !Array.isArray(j.rows) || !j.rows.length) return null;
    if (nowMs - j.savedAt > LIST_SNAPSHOT_MAX_AGE_MS || j.savedAt > nowMs + 60_000) { store.removeItem?.(LIST_SNAPSHOT_KEY); return null; }
    return (j.rows as T[]).filter((r) => r && typeof r === "object" && "id" in (r as object));
  } catch { return null; }
}
