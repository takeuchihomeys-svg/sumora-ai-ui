// app/lib/send-idempotency.ts — 2026-10-23 送信の二重防止（同じ送信の印＝send_id）
//   事例 10/23 10:05 JST: スタッフが送信 → LINE には届いたが、DB（Supabase）が約2分止まりサーバーの応答が30秒を超えた →
//   画面は「⚠️ LINE送信エラー: Fetch is aborted。…再試行」を出した。ここで送信を押し直すと二重に届いていた。
//   直し: 画面が「送信1回ごと」に印（UUID）を作り、押し直しでも同じ印を使う。サーバーは印を LINE の X-Line-Retry-Key に入れる。
//   LINE は同じ鍵の2回目を送らずに 409 と「最初に届いた通の id（sentMessages）」を返す（push のみ・24時間有効）。
//   → 印の記録に DB を使わない（DB が止まっていても二重にならない・DB の変更なし）。戻す: SEND_IDEMPOTENCY=off（サーバー）
//   画面と API の両方から使うので純粋な関数だけ（node:crypto を使わない）。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 画面から来た send_id を確かめる（UUID の形だけ受ける・違えば null＝印なしの従来どおり） */
export function parseSendId(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null;
}

/** サーバーで印を使うか（既定 on・SEND_IDEMPOTENCY=off で従来どおり鍵を付けない） */
export function sendIdempotencyOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SEND_IDEMPOTENCY ?? "on").toLowerCase() !== "off";
}

/**
 * push 1回ごとの LINE の再送の鍵。画像をまとめて送ると push が複数回になるので、2回目以降は印から決まった別の UUID にする
 * （末尾12桁に回数を足す・同じ印と回数なら毎回同じ鍵）。
 */
export function retryKeyFor(sendId: string, pushIndex: number): string {
  const id = sendId.toLowerCase();
  if (pushIndex <= 0) return id;
  const head = id.slice(0, 24);
  const tail = parseInt(id.slice(24), 16);   // 48ビット（Number で正確に扱える）
  const next = (tail + pushIndex) % 2 ** 48;
  return head + next.toString(16).padStart(12, "0");
}

/** LINE の 409 が「同じ鍵はもう受け付けた（＝前の送信で届いている）」か。届いた通の id も返す */
export function parseRetryKeyAccepted(status: number, bodyText: string): { accepted: boolean; sentMessageIds: string[] } {
  if (status !== 409) return { accepted: false, sentMessageIds: [] };
  try {
    const j = JSON.parse(bodyText) as { message?: string; sentMessages?: Array<{ id?: string }> };
    const accepted = /retry key is already accepted/i.test(j.message ?? "") || Array.isArray(j.sentMessages);
    const ids = (j.sentMessages ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
    return { accepted, sentMessageIds: ids };
  } catch {
    return { accepted: /retry key is already accepted/i.test(bodyText), sentMessageIds: [] };
  }
}

/** fetch の打ち切り（AbortSignal.timeout・abort）や通信切れか（＝サーバーに届いたか分からない失敗） */
export function isUncertainFetchError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: string }).name ?? "";
  const msg = (e as { message?: string }).message ?? "";
  return name === "TimeoutError" || name === "AbortError" || name === "TypeError" || /abort|timed? ?out|network|failed to fetch|load failed/i.test(msg);
}

/** 入力欄の中身の指紋（同じ中身の押し直しだけ同じ印を使う・中身を変えたら新しい印） */
export function sendFingerprint(convId: string, text: string, files: Array<{ name: string; size: number; lastModified: number }>): string {
  return [convId, text, ...files.map((f) => `${f.name}:${f.size}:${f.lastModified}`)].join("\u0001");
}

export function newSendId(): string {
  return crypto.randomUUID().toLowerCase();
}
