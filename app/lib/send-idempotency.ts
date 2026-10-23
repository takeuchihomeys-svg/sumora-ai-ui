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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-23 送信の二重防止を AIX・物件出しリスト・見積の送信にも広げる（手動送信と同じ仕組み）

/** 返事が来ず、同じ印での確かめも返事が無い（＝届いたか分からない）。「未送信」とは言わない */
export class UncertainSendError extends Error {
  constructor() { super("send_uncertain"); this.name = "UncertainSendError"; }
}

/**
 * 画面の送信の印の帳簿（AIX・電話ボタン・物件出しリスト等の、入力欄を持たない送信用）。
 * 同じ中身（鍵）の押し直しには同じ印を返す。届いたら done で消す。古い印（既定10分）は捨てる
 * （後で同じ中身をわざと送る時、古い印が残ると LINE が「もう届いている」として送らない＝新しい送信が消えるため）。
 */
/** 帳簿の印を覚えておく分数（この間の押し直しだけ同じ印＝二重に届かない） */
export const SEND_ID_TTL_MIN = 10;
/** 「届いたか分からない」の知らせに添える、安全に押し直せる時間（帳簿を使う送信用） */
export const UNCERTAIN_SAFE_WINDOW_NOTE = `${SEND_ID_TTL_MIN}分以内にもう一度押せば二重には届きません（${SEND_ID_TTL_MIN}分を過ぎてからだと二重に届くことがあります）`;

export class SendIdBook {
  private m = new Map<string, { id: string; at: number }>();
  constructor(private ttlMs = SEND_ID_TTL_MIN * 60_000, private gen: () => string = newSendId) {}
  idFor(key: string, now = Date.now()): string {
    for (const [k, v] of this.m) if (now - v.at > this.ttlMs) this.m.delete(k);
    const cur = this.m.get(key);
    if (cur) return cur.id;
    const id = this.gen();
    this.m.set(key, { id, at: now });
    return id;
  }
  done(key: string): void { this.m.delete(key); }
  has(key: string): boolean { return this.m.has(key); }
}

/**
 * 印つきの送信を1回送る。最初の返事を firstMs 待ち、打ち切り・通信切れなら同じ印でもう一度（confirmMs）送って確かめる
 * （届いていれば LINE は送らずに届いた通の id を返す）。確かめも返事が無い・失敗なら UncertainSendError。
 * 印が無い（hasSendId=false）時は従来どおり1回だけ（打ち切りはそのまま投げる）。
 */
export async function postWithConfirm(
  doFetch: (timeoutMs: number) => Promise<Response>,
  opts: { hasSendId: boolean; firstMs?: number; confirmMs?: number },
): Promise<{ res: Response; confirmedAfterTimeout: boolean }> {
  try {
    return { res: await doFetch(opts.firstMs ?? 30_000), confirmedAfterTimeout: false };
  } catch (e) {
    if (!opts.hasSendId || !isUncertainFetchError(e)) throw e;
    let r: Response;
    try {
      r = await doFetch(opts.confirmMs ?? 25_000);
    } catch {
      throw new UncertainSendError();
    }
    if (!r.ok) throw new UncertainSendError();
    return { res: r, confirmedAfterTimeout: true };
  }
}

/** サーバー: 印つきで LINE に push 1回（409「同じ鍵はもう受け付けた」→ 届いている扱い・alreadySent） */
export type LinePushResult = { ok: boolean; status: number; alreadySent: boolean; sentMessageIds: string[]; errorText: string };
export async function linePushIdem(opts: {
  token: string; to: string; messages: unknown[]; sendId: string | null; pushIndex?: number; timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 鍵をそのまま渡す（中身つきの鍵 retryKeyForContent・cron の行の鍵 cronRetryKey）。あれば sendId・pushIndex より優先 */
  retryKey?: string | null;
}): Promise<LinePushResult> {
  const f = opts.fetchImpl ?? fetch;
  const key = opts.retryKey ?? (opts.sendId ? retryKeyFor(opts.sendId, opts.pushIndex ?? 0) : null);
  const res = await f("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${opts.token}`,
      ...(key ? { "X-Line-Retry-Key": key } : {}),
    },
    body: JSON.stringify({ to: opts.to, messages: opts.messages }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (key && res.status === 409) {
    const bodyText = await res.text().catch(() => "");
    const acc = parseRetryKeyAccepted(res.status, bodyText);
    if (acc.accepted) return { ok: true, status: 200, alreadySent: true, sentMessageIds: acc.sentMessageIds, errorText: "" };
    return { ok: false, status: 409, alreadySent: false, sentMessageIds: [], errorText: bodyText };
  }
  if (!res.ok) return { ok: false, status: res.status, alreadySent: false, sentMessageIds: [], errorText: await res.text().catch(() => "") };
  let ids: string[] = [];
  try {
    const j = await res.json() as { sentMessages?: Array<{ id?: string }> };
    ids = (j.sentMessages ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
  } catch { /* 送信自体は成功 */ }
  return { ok: true, status: res.status, alreadySent: false, sentMessageIds: ids, errorText: "" };
}

/** 帳簿の印で1回送る（同じ鍵の押し直しは同じ印・届いたら（2xx）印を消す・返事が無ければ同じ印で確かめる） */
/**
 * opts.keep=true: 届いても印を消さない（AIX の「画像 → 文」のひとまとまりで、文が届くまで画像の印を残す。
 *   文が「届いたか分からない」まま押し直した時、届いた画像を同じ印で送り直す＝LINE は送らない。呼ぶ側が後で book.done する）
 */
export async function sendWithIdempotency(
  book: SendIdBook, key: string,
  doFetch: (sendId: string, timeoutMs: number) => Promise<Response>,
  firstMs?: number,
  opts: { keep?: boolean } = {},
): Promise<{ res: Response; confirmedAfterTimeout: boolean }> {
  const sendId = book.idFor(key);
  // 確かめも最初と同じだけ待つ（画像をまとめて送る時は push が複数回で長い。25秒で切ると届いていても「分からない」になる）
  const out = await postWithConfirm((ms) => doFetch(sendId, ms), { hasSendId: true, firstMs, confirmMs: firstMs && firstMs > 25_000 ? firstMs : undefined });
  if (out.res.ok && !opts.keep) book.done(key);
  return out;
}

/** 大きな中身（画像の base64 等）から短い鍵を作る（FNV-1a 32bit×2・長さつき。送信の押し直しの見分けだけに使う） */
export function contentKey(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${s.length}:${h1.toString(16)}:${h2.toString(16)}`;
}

/**
 * 印と中身から決まる LINE の再送の鍵（同じ印・同じ中身なら毎回同じ鍵・中身が違えば別の鍵）。
 *   2026-10-23 物件出しリスト: 「対象者なし」が届いたか分からないまま対象者が増えて押し直すと、旧は同じ鍵でリストが送られず
 *   画面だけ「✅ N名送信」になった → 鍵に中身（送る文の種類・対象者）を混ぜる。UUID の形（下16桁に中身の指紋を XOR）を保つ
 */
export function retryKeyForContent(sendId: string, content: string): string {
  const hex = sendId.toLowerCase().replace(/-/g, "");
  let h1 = 0x811c9dc5, h2 = (0x9747b28c ^ content.length) >>> 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  const mix = h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");   // 16桁
  let out = hex.slice(0, 16);
  for (let i = 0; i < 16; i++) out += (parseInt(hex[16 + i], 16) ^ parseInt(mix[i], 16)).toString(16);
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/**
 * サーバーの定期処理（cron）の送信の印: 行の id から毎回同じ UUID を作る（回数・時刻に依らない）。
 *   cron が重なって同じ行を2回送っても、LINE は同じ鍵の2回目を送らずに 409 を返す（24時間有効）。
 *   scope で処理ごとに分ける（同じ id でも別の処理なら別の鍵）
 */
export function cronRetryKey(scope: string, rowId: string | number): string {
  // 上16桁は scope の指紋（処理ごと）・下16桁は scope＋行の指紋（64ビット）
  const head = retryKeyForContent("00000000-0000-4000-8000-000000000000", scope).replace(/-/g, "").slice(16);
  const base = `${head.slice(0, 8)}-${head.slice(8, 12)}-4${head.slice(13, 16)}-8000-000000000000`;
  return retryKeyForContent(base, `${scope}\u0001${rowId}`);
}

/**
 * 画面が messages に入れる前に、もう入っている LINE の通（line_message_id）を外す（同じ印の押し直しで LINE が
 * 「もう届いていた通の id」を返した時に二重の行・二重の吹き出しにしない）。同じ id が束の中に2回ある時も1回だけ。
 * 印の無い行（id 無し）はそのまま入れる
 */
export function splitByExistingLineIds<T>(
  items: T[], lineIdOf: (t: T) => string | null | undefined, existing: ReadonlySet<string>,
): { toInsert: T[]; skipped: T[] } {
  const seen = new Set(existing);
  const toInsert: T[] = [], skipped: T[] = [];
  for (const it of items) {
    const lid = lineIdOf(it);
    if (lid && seen.has(lid)) { skipped.push(it); continue; }
    if (lid) seen.add(lid);
    toInsert.push(it);
  }
  return { toInsert, skipped };
}

/** 物件出しリスト（売上番長グループ）の送信の帳簿（物件条件・物件出しの画面で共有）。同じ日の押し直しは同じ印 */
export const propertyListSendBook = new SendIdBook();
export function propertyListSendKey(now = new Date()): string {
  return `property-list\u0001${now.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}`;
}
