// app/lib/call-tap.ts
// 2026-10-02 竹内「AIXの電話をかけるが、こっちが電話でれなくて不在だった場合 不在の通知がはいるようにする。今出ないのでわかりにくい」
//   LINEコール（お客様 → 公式アカウントの無料通話）は Messaging API の webhook に着信・不在着信のイベントが無い（LINE の仕様）。
//   そこで「電話をかける」ボタンの行き先を こちらの /api/call-tap を1回通してから通話URL へ転送する形にし、
//   **お客様がボタンを押した瞬間**を記録して、売上番長グループとトーク画面に知らせる（竹内さんの選択: 押した直後・グループ＋トーク画面）。
//   出られた時はスタッフが AIX【電話する】→電話終了後 を使えば、トーク画面の印は消える。
//
// リンクには会話の id とアカウントと署名を載せる（署名が合わない物は記録も通知もせず、通話URL へも飛ばさない）。
// 依存ゼロ（node:crypto だけ）。サーバー専用（画面から import しない）

import { createHmac, timingSafeEqual } from "node:crypto";

/** 同じ会話で続けて押された時に通知を重ねない間隔（押し直し・つながらずにもう1回） */
export const CALL_TAP_NOTIFY_GAP_MS = 3 * 60_000;

/** 署名の鍵（無ければ転送の形にしない＝今までどおり通話URL を直接入れる） */
export function callTapSecret(env: Record<string, string | undefined>): string | null {
  const s = (env.CALL_TAP_SECRET || env.INTERNAL_API_SECRET || env.SYNC_SECRET || "").trim();
  return s.length >= 8 ? s : null;
}

export function signCallTap(conversationId: string, accountKey: string, secret: string): string {
  return createHmac("sha256", secret).update(`call-tap:${conversationId}:${accountKey}`).digest("base64url").slice(0, 22);
}

export function verifyCallTap(conversationId: string, accountKey: string, sig: string, secret: string): boolean {
  if (!conversationId || !accountKey || !sig) return false;
  const want = Buffer.from(signCallTap(conversationId, accountKey, secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * 「電話をかける」ボタンに入れる URL。https の自分のサイトがある時だけ転送の形にする
 * （手元の開発サーバー http://localhost の時はお客様の端末から開けないので、通話URL をそのまま返す）
 */
export function buildCallTapUrl(input: { origin: string | null | undefined; conversationId: string | null | undefined; accountKey: string; callUrl: string; secret: string | null }): string {
  const { origin, conversationId, accountKey, callUrl, secret } = input;
  if (!secret || !conversationId || !origin || !/^https:\/\//.test(origin)) return callUrl;
  const u = new URL("/api/call-tap", origin);
  u.searchParams.set("c", conversationId);
  u.searchParams.set("a", accountKey);
  u.searchParams.set("s", signCallTap(conversationId, accountKey, secret));
  return u.toString();
}

/** 売上番長グループへの通知文（押した直後） */
export function buildCallTapNotice(customerName: string | null | undefined, at: Date): string {
  const hm = at.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
  const name = (customerName ?? "").trim();
  return `📞【電話】\n${name ? `${name}さん` : "名前なし"}が電話ボタンを押しました（${hm}）\n出られなかった時は折り返しをお願いします`;
}
