// app/lib/stale-reply.ts
// 返信の文（下書き・スタッフが打った文）を作った後に、お客様から新しい LINE が届いたか（すれ違い）の判定（純関数・依存なし）。
//
// 2026-10-20 竹内さん（設計知見 P1 54ec8c71「返信を送る前にお客様から新しい LINE が来たら、その新しい発言に返信する」）:
//   お客様 21:00「すぐ埋まっちゃう感じですかね？…埋まるようだったら別の所探して」→ スタッフが募集状況の画像（21:04）→
//   お客様 21:08「すみません他お願いします」→ その19秒後、前の質問への答え（残りの部屋・早く埋まる・申込で抑える）が送られ、
//   「他お願いします」に答えていなかった。「返信のタイミングの前にお客さんからラインきたら、ここの送られてきた部分に返信するようにする。
//   そうじゃないとすれ違ったままになってしまう」。
//   本番の記録: 送った文は AI の下書きではなくスタッフが入力欄で打っていた文（新しい発言の前に書き始めた物）。画面も送信 API も
//   「文を作った後にお客様の新しい発言が来たか」を見ていなかった。
//
// ここは「時刻」だけを見る安全の線（P0 9eb6aa9c: 規則は候補の網と安全の線だけ）。新しい発言が前の依頼を変えるか・何に答えるかは
// ブレインが文を読んで決める（brain-core の latestSupersedesRule・作り直しの下書き）。
//
// 戻す: 画面 NEXT_PUBLIC_STALE_REPLY_GUARD=off／サーバー STALE_DRAFT_GUARD=off

/** 同じ秒の書き込みの丸め（文の土台にした発言そのものを「新しい」と誤判定しない。draft-supersede と同じ値） */
export const STALE_REPLY_TOLERANCE_MS = 1_000;

/** 旗（既定 on）。"off" だけで止める */
export function staleGuardEnabled(flag: string | undefined | null): boolean {
  return (flag ?? "on").trim().toLowerCase() !== "off";
}

export type StaleMsg = { sender: string; text?: string | null; rawCreatedAt?: string | null; createdAt?: string | null };

function atOf(m: StaleMsg): number {
  const iso = m.rawCreatedAt ?? m.createdAt ?? null;
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

/** いちばん新しいお客様の発言の時刻（ISO）。時刻の読めない行は飛ばす */
export function latestCustomerAtOf(msgs: readonly StaleMsg[]): string | null {
  let best = NaN;
  let bestIso: string | null = null;
  for (const m of msgs) {
    if (m.sender !== "customer") continue;
    const ms = atOf(m);
    if (Number.isFinite(ms) && (!Number.isFinite(best) || ms > best)) { best = ms; bestIso = m.rawCreatedAt ?? m.createdAt ?? null; }
  }
  return bestIso;
}

/**
 * baseAt（文の土台にしたお客様の最新の発言の時刻）より後に届いたお客様の発言（いちばん新しい物）。
 * baseAt が無い・読めない時は null（判定できない＝止めない）。
 */
export function newerCustomerMessageSince(msgs: readonly StaleMsg[], baseAt: string | null | undefined): { at: string; text: string } | null {
  const baseMs = baseAt ? Date.parse(baseAt) : NaN;
  if (!Number.isFinite(baseMs)) return null;
  let hit: StaleMsg | null = null;
  let hitMs = NaN;
  for (const m of msgs) {
    if (m.sender !== "customer") continue;
    const ms = atOf(m);
    if (!Number.isFinite(ms) || ms <= baseMs + STALE_REPLY_TOLERANCE_MS) continue;
    if (!hit || ms > hitMs) { hit = m; hitMs = ms; }
  }
  return hit ? { at: (hit.rawCreatedAt ?? hit.createdAt) as string, text: (hit.text ?? "").trim() } : null;
}

/** 時刻2つだけの判定（サーバーの DB 版と同じ線）: latestAt が baseAt より後なら true */
export function isNewerThanBase(latestAt: string | null | undefined, baseAt: string | null | undefined): boolean {
  const l = latestAt ? Date.parse(latestAt) : NaN;
  const b = baseAt ? Date.parse(baseAt) : NaN;
  if (!Number.isFinite(l) || !Number.isFinite(b)) return false;
  return l > b + STALE_REPLY_TOLERANCE_MS;
}

/**
 * 入力欄の文の「土台」（その文を作り始めた時点のお客様の最新の発言の時刻）を次の状態でどうするか（画面の useEffect が使う）。
 *   - 入力欄が空になった → null（次に書き始めた時に取り直す）
 *   - 空 → 文が入った（下書きが入った・打ち始めた）→ 今のお客様の最新の発言の時刻
 *   - 文が入ったまま → そのまま（途中で届いた発言は「土台より新しい」として送る前に知らせる）
 */
export function nextComposerBase(prevBase: string | null, draft: string, latestCustomerAt: string | null): string | null {
  if (!draft.trim()) return null;
  if (prevBase) return prevBase;
  return latestCustomerAt;
}

/** 送信 API の 409 の印（画面がこの印で「このまま送る／作り直す」を出す） */
export const STALE_REPLY_ERROR_CODE = "stale_reply";
