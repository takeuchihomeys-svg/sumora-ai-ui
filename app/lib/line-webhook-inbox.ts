// app/lib/line-webhook-inbox.ts — LINE の webhook の生の本文を、DB が止まっていても残る所（Vercel Blob の private）に貯めて、後で入れ直す（作業員M・2026-11-21）
//
// 竹内さん 11/21「LINE に返信が来ているのに、ツールに反映されないお客さんがいる。原因を見つけて改善する」（統括役の最優先の頼み）。
//   本番のログに「[line-webhook] conversation作成失敗: undefined」が DB の止まった時間に4回（11/19 23:56Z〜11/20 01:20Z）。
//   受け口は保存に失敗すると 500 を返すだけで、本文はどこにも残らなかった（LINE の送り直しは LINE の管理画面の「Webhook の再送」が on の時だけ・こちらからは確かめられない）。
//   → 失敗した時は、生の本文と署名をそのまま Blob に置き（private・お客様の文が入るので公開しない）、DB が戻った後の受け口の成功のついでに少しずつ入れ直す（新しい cron は足さない）。
//   入れ直しは同じ受け口（/api/line-webhook）に同じ本文と署名で送る＝署名の確かめと重複の防ぎ（line_message_id）がそのまま効く。時刻は LINE の event.timestamp を使う。
// スイッチ LINE_WEBHOOK_INBOX（既定 on・止める =off）。BLOB_READ_WRITE_TOKEN が無ければ何もしない（ログだけ）。
// テスト: app/lib/__tests__/line-webhook-inbox.test.ts
import { put, list, del, get } from "@vercel/blob";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export const INBOX_PREFIX = "line-webhook-inbox/pending/";
/** 入れ直しの印（受け口がこの見出しを見たら、時刻を LINE の event.timestamp にし、ついでの入れ直しはしない） */
export const REPLAY_HEADER = "x-line-inbox-replay";

export function lineInboxOn(env: Env = envOf()): boolean {
  return (env.LINE_WEBHOOK_INBOX ?? "").trim().toLowerCase() !== "off" && !!(env.BLOB_READ_WRITE_TOKEN ?? "").trim();
}

export type InboxSource = "webhook" | "relay";
export type InboxItem = { v: 1; receivedAt: string; source: InboxSource; reason: string; signature: string; rawBody: string; tries: number };

/** 置き場の名前（時刻の順に並ぶ・同じ時刻でも重ならない） */
export function inboxPathOf(receivedAt: string, rand: string): string {
  return `${INBOX_PREFIX}${receivedAt.replace(/[:.]/g, "-")}-${rand.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "x"}.json`;
}

/** 本文から数（イベント・メッセージ・テキスト）と line の message id を数える（ログ用・本文は出さない） */
export function inboxCountsOf(rawBody: string): { events: number; messages: number; ids: string[] } {
  try {
    const b = JSON.parse(rawBody) as { events?: Array<{ type?: string; message?: { id?: string } }> };
    const ev = Array.isArray(b.events) ? b.events : [];
    const msgs = ev.filter((e) => e?.type === "message");
    return { events: ev.length, messages: msgs.length, ids: msgs.map((e) => String(e.message?.id ?? "")).filter(Boolean).slice(0, 20) };
  } catch {
    return { events: 0, messages: 0, ids: [] };
  }
}

/** 入れ直しの時の event の時刻（LINE の timestamp・ミリ秒）。無ければ undefined（今の時刻を使う） */
export function replayAtOf(event: { timestamp?: unknown } | null | undefined, isReplay: boolean): string | undefined {
  if (!isReplay) return undefined;
  const t = typeof event?.timestamp === "number" ? event.timestamp : Number(event?.timestamp);
  return Number.isFinite(t) && t > 1_500_000_000_000 ? new Date(t).toISOString() : undefined;
}

/**
 * 生の本文を Blob（private）に置く。失敗しても投げない（受け口の応答を止めない）。置けたら pathname、置けなければ null。
 *   メッセージが無い本文（follow・unfollow だけ等）も置く（入れ直しは受け口が判断する）
 */
export async function inboxPut(rawBody: string, signature: string, reason: string, source: InboxSource, env: Env = envOf()): Promise<string | null> {
  const c = inboxCountsOf(rawBody);
  if (!lineInboxOn(env)) {
    console.error(JSON.stringify({ tag: "line-inbox:dropped", source, reason, ...c, why: "LINE_WEBHOOK_INBOX が off か BLOB_READ_WRITE_TOKEN が無い" }));
    return null;
  }
  const receivedAt = new Date().toISOString();
  const item: InboxItem = { v: 1, receivedAt, source, reason: reason.slice(0, 200), signature, rawBody, tries: 0 };
  const path = inboxPathOf(receivedAt, Math.random().toString(36).slice(2));
  try {
    await put(path, JSON.stringify(item), { access: "private", contentType: "application/json", addRandomSuffix: false });
    inboxMarkDirty();
    console.warn(JSON.stringify({ tag: "line-inbox:stored", source, reason, path, ...c }));
    return path;
  } catch (e) {
    console.error(JSON.stringify({ tag: "line-inbox:dropped", source, reason, ...c, why: `Blob に置けなかった: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) }));
    return null;
  }
}

/** 置いてある物を古い順に少しだけ取る */
export async function inboxListPending(limit = 3): Promise<Array<{ pathname: string; uploadedAt: Date }>> {
  const r = await list({ prefix: INBOX_PREFIX, limit: Math.max(1, Math.min(limit * 3, 50)) });
  return r.blobs.map((b) => ({ pathname: b.pathname, uploadedAt: b.uploadedAt })).sort((a, b) => a.pathname.localeCompare(b.pathname)).slice(0, limit);
}

async function readItem(pathname: string): Promise<InboxItem | null> {
  const r = await get(pathname, { access: "private", useCache: false });
  if (!r) return null;
  const text = await new Response(r.stream).text();
  const o = JSON.parse(text) as InboxItem;
  return o && o.v === 1 && typeof o.rawBody === "string" ? o : null;
}

/** 1つ入れ直す: 同じ受け口に同じ本文と署名で送り、2xx なら消す。4xx（署名・宛先の拒否）も消す（何度送っても同じ）。5xx は残す（次の機会に） */
export async function inboxReplayOne(pathname: string, targetUrl: string): Promise<"done" | "kept" | "gone" | "dropped"> {
  const item = await readItem(pathname).catch(() => null);
  if (!item) { await del(pathname).catch(() => {}); return "gone"; }
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-line-signature": item.signature, [REPLAY_HEADER]: item.receivedAt },
    body: item.rawBody,
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const c = inboxCountsOf(item.rawBody);
  if (res && res.ok) { await del(pathname).catch(() => {}); console.log(JSON.stringify({ tag: "line-inbox:replayed", pathname, ...c })); return "done"; }
  if (res && res.status >= 400 && res.status < 500) { await del(pathname).catch(() => {}); console.error(JSON.stringify({ tag: "line-inbox:dropped", pathname, why: `入れ直しが ${res.status} で拒まれた`, ...c })); return "dropped"; }
  console.warn(JSON.stringify({ tag: "line-inbox:kept", pathname, status: res?.status ?? null, ...c }));
  return "kept";
}

/**
 * 2026-11-21 統括役の指摘①: 成功のたびに Blob の list を呼ぶと本番の通数で回数が多い → 最後に空だったのが N 分以内なら list しない（関数の実体ごとの覚え）。
 *   貯めた時（inboxPut）は覚えを消す＝同じ実体なら次の成功で入れ直す。止める LINE_WEBHOOK_INBOX_IDLE_MIN=0
 */
let lastEmptyAt = 0;
export function inboxIdleMinutes(env: Env = envOf()): number {
  const n = Number((env.LINE_WEBHOOK_INBOX_IDLE_MIN ?? "10").trim());
  return Number.isFinite(n) && n >= 0 ? n : 10;
}
/** list を飛ばすか（純関数・テスト用に時刻を渡せる） */
export function inboxSkipList(lastEmptyMs: number, nowMs: number, idleMin: number): boolean {
  return idleMin > 0 && lastEmptyMs > 0 && nowMs - lastEmptyMs < idleMin * 60_000;
}
export function inboxMarkDirty(): void { lastEmptyAt = 0; }

/** 受け口が成功した後のついでに、古い物から少しだけ入れ直す（新しい cron を足さない）。投げない */
export async function inboxDrain(targetUrl: string, limit = 3, env: Env = envOf()): Promise<{ done: number; kept: number; dropped: number }> {
  const out = { done: 0, kept: 0, dropped: 0 };
  if (!lineInboxOn(env)) return out;
  if (inboxSkipList(lastEmptyAt, Date.now(), inboxIdleMinutes(env))) return out;
  try {
    const items = await inboxListPending(limit);
    if (!items.length) { lastEmptyAt = Date.now(); return out; }
    for (const it of items) {
      const r = await inboxReplayOne(it.pathname, targetUrl);
      if (r === "done" || r === "gone") out.done++;
      else if (r === "dropped") out.dropped++;
      else { out.kept++; break; } // まだ DB が戻っていない＝続けない
    }
  } catch (e) {
    console.warn(JSON.stringify({ tag: "line-inbox:drain-failed", error: e instanceof Error ? e.message : String(e) }));
  }
  return out;
}
