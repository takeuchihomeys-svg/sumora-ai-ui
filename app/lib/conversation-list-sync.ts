// app/lib/conversation-list-sync.ts — 会話一覧の読み込みを「変わった所だけ」にする決まり（純関数・画面からも読む・DB 依存なし）
//
// 2026-10-06 ⑫ 竹内「AIXツールひらくとき重すぎる。原因見つけて改善する。もっと開いてから限定的にするなどする。今全部見ている気がする」
//   測った（本番・anon キー）: 30秒ごとに 会話 371行（967KB）＋直近90日のメッセージ（limit 5000 だが max_rows で 1000行＝4日分・644KB）
//   ＋紐付けの物件顧客 233行（428KB）＝約2MB を丸ごと読み直していた（毎分 約4MB）。会話の Realtime は publication に無く届いていない。
//   一覧がメッセージから使っていたのは「お客様の最後の発言の時刻」（未読・AIX の鮮度・下書きの先回り）と「本文の検索」だけ
//   → 前者は DB の集計（conversation_last_customer_at・43KB）、後者は DB の検索（search_conversation_ids_by_message）にし、
//     メッセージは開いた会話の分だけ読む。会話は Realtime で変わった行だけを直し、30秒ごとは「更新時刻が新しい行」だけ、丸ごとは5分ごと。

/** 会話のお客様の最後の発言の時刻（読み込んだメッセージと DB の集計の新しい方） */
export function lastCustomerTs(
  messages: ReadonlyArray<{ sender: string; rawCreatedAt?: string | null }>,
  fromDb: string | null | undefined,
): string | null {
  let fromMsgs: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender === "customer") { fromMsgs = messages[i].rawCreatedAt ?? null; break; }
  }
  if (!fromMsgs) return fromDb ?? null;
  if (!fromDb) return fromMsgs;
  return Date.parse(fromDb) > Date.parse(fromMsgs) ? fromDb : fromMsgs;
}

/**
 * AIX の鮮度の判定（aix-button-view.isAixListBadge）に渡すメッセージ。読み込んでいない会話は DB のお客様の最後の時刻を1件の形で渡す
 * （旧は 90日のメッセージを全部持っている前提で、実際は4日分しか無く、それより前の会話は鮮度を見ていなかった）
 */
export function badgeMessages<M extends { sender: string; rawCreatedAt?: string | null }>(
  messages: ReadonlyArray<M>,
  fromDb: string | null | undefined,
): ReadonlyArray<{ sender: string; rawCreatedAt?: string | null }> {
  const ts = lastCustomerTs(messages, fromDb);
  if (!ts) return messages;
  const inMsgs = [...messages].reverse().find((m) => m.sender === "customer")?.rawCreatedAt ?? null;
  if (inMsgs === ts) return messages;
  return [...messages, { sender: "customer", rawCreatedAt: ts }];
}

/** 30秒ごとの読み直しを丸ごと（full）にするか、更新時刻が新しい行だけ（delta）にするか */
export const FULL_REFRESH_EVERY_MS = 5 * 60_000;
export function pollPlan(nowMs: number, lastFullAtMs: number | null, everyMs = FULL_REFRESH_EVERY_MS): "full" | "delta" {
  if (lastFullAtMs == null || !Number.isFinite(lastFullAtMs)) return "full";
  return nowMs - lastFullAtMs >= everyMs ? "full" : "delta";
}

/** 差分の読み直しの起点（今持っている一番新しい更新時刻から少し戻す＝時計のずれ・同じ時刻の書き込みを落とさない） */
export function deltaSinceIso(rows: ReadonlyArray<{ updatedAt?: string | null }>, overlapMs = 90_000): string | null {
  let max = NaN;
  for (const r of rows) {
    const t = Date.parse(r.updatedAt ?? "");
    if (Number.isFinite(t) && !(t <= max)) max = t;
  }
  return Number.isFinite(max) ? new Date(max - overlapMs).toISOString() : null;
}

/**
 * 会話の行を差し替える（無ければ足す）。読み込み済みのメッセージは消さない（行の情報だけ新しくする）。並びは更新時刻の新しい順
 *   rebuild: DB の行 → 画面の行（メッセージは今持っている物を渡す）
 */
export function upsertConversationRows<C extends { id: string; updatedAt?: string; messages: ReadonlyArray<unknown> }, R>(
  prev: ReadonlyArray<C>,
  rows: ReadonlyArray<R>,
  idOf: (r: R) => string,
  rebuild: (r: R, existing: C | undefined) => C,
): C[] {
  if (!rows.length) return prev as C[];
  const byId = new Map(prev.map((c) => [c.id, c]));
  const incoming = new Map<string, C>();
  for (const r of rows) {
    const id = idOf(r);
    incoming.set(id, rebuild(r, byId.get(id)));
  }
  const out = prev.map((c) => incoming.get(c.id) ?? c);
  for (const [id, c] of incoming) if (!byId.has(id)) out.push(c);
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
