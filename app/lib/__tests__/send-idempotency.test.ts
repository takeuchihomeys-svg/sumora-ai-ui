// app/lib/__tests__/send-idempotency.test.ts — 2026-10-23 送信の二重防止（10/23 10:05 Fetch is aborted の事例）
//   実行: npx tsx app/lib/__tests__/send-idempotency.test.ts
import {
  parseSendId, retryKeyFor, parseRetryKeyAccepted, isUncertainFetchError, sendIdempotencyOn,
  SendIdBook, postWithConfirm, sendWithIdempotency, linePushIdem, contentKey, propertyListSendKey, UncertainSendError,
} from "../send-idempotency";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const id = "3f2b8c1e-9a4d-4e2f-8b7a-ffffffffffff";
t("印: UUID は受ける（小文字に）", parseSendId(id.toUpperCase()) === id);
t("印: 形が違えば null（従来どおり鍵なし）", parseSendId("abc") === null && parseSendId(undefined) === null && parseSendId(123) === null);
t("鍵: 1回目は印そのもの", retryKeyFor(id, 0) === id);
t("鍵: 2回目以降は別の UUID・毎回同じ", retryKeyFor(id, 1) !== id && retryKeyFor(id, 1) === retryKeyFor(id, 1) && UUID.test(retryKeyFor(id, 1)));
t("鍵: 末尾が桁あふれしても 12 桁", retryKeyFor(id, 1).endsWith("000000000000"));
t("鍵: 回数ごとに違う", new Set([0, 1, 2, 3].map((i) => retryKeyFor(id, i))).size === 4);
const body409 = JSON.stringify({ message: "The retry key is already accepted", sentMessages: [{ id: "111", quoteToken: "q" }, { id: "222" }] });
const acc = parseRetryKeyAccepted(409, body409);
t("409 受付済み: 届いた通の id を返す", acc.accepted && acc.sentMessageIds.join(",") === "111,222");
t("409 でも別の理由なら受付済みではない", !parseRetryKeyAccepted(409, JSON.stringify({ message: "Conflict" })).accepted);
t("200 は受付済みの判定の外", !parseRetryKeyAccepted(200, body409).accepted);
t("打ち切り: TimeoutError / AbortError / Fetch is aborted", isUncertainFetchError({ name: "TimeoutError" }) && isUncertainFetchError({ name: "AbortError" }) && isUncertainFetchError(new Error("Fetch is aborted")));
t("打ち切りでない失敗は分かる失敗", !isUncertainFetchError(new Error("HTTP 500")) && !isUncertainFetchError(null));
t("SEND_IDEMPOTENCY=off で止まる", !sendIdempotencyOn({ SEND_IDEMPOTENCY: "off" }) && sendIdempotencyOn({}));

// ── 2026-10-23 AIX・物件出しリスト・見積の送信にも広げた分 ──
const abortErr = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const resp = (status: number, body: unknown = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

async function main() {
  // 帳簿: 同じ鍵は同じ印・違う鍵は別・届いたら消す・10分で捨てる
  let n = 0;
  const book = new SendIdBook(10 * 60_000, () => `id-${++n}`);
  const a1 = book.idFor("txt\u0001c1\u0001了解です", 0);
  t("帳簿: 同じ中身の押し直しは同じ印", book.idFor("txt\u0001c1\u0001了解です", 1000) === a1);
  t("帳簿: 中身が違えば別の印", book.idFor("txt\u0001c1\u0001はい", 1000) !== a1);
  t("帳簿: 会話が違えば別の印", book.idFor("txt\u0001c2\u0001了解です", 1000) !== a1);
  book.done("txt\u0001c1\u0001了解です");
  t("帳簿: 届いたら消える（後で同じ文をわざと送る時は新しい印）", book.idFor("txt\u0001c1\u0001了解です", 2000) !== a1);
  const old = book.idFor("call\u0001c1", 0);
  t("帳簿: 10分を過ぎた印は捨てる", book.idFor("call\u0001c1", 10 * 60_000 + 1) !== old);

  // 確かめ: 1回目が打ち切り → 同じ印でもう一度 → 届いていれば confirmedAfterTimeout
  let calls = 0;
  const r1 = await postWithConfirm(async () => { calls++; if (calls === 1) throw abortErr(); return resp(200, { ok: true, alreadySent: true }); }, { hasSendId: true });
  t("確かめ: 打ち切りの後に同じ印で1回だけ送り直す", calls === 2 && r1.confirmedAfterTimeout && r1.res.ok);
  let threw: unknown = null;
  try { await postWithConfirm(async () => { throw abortErr(); }, { hasSendId: true }); } catch (e) { threw = e; }
  t("確かめも返事が無い → 届いたか分からない（UncertainSendError）", threw instanceof UncertainSendError);
  threw = null; calls = 0;
  try { await postWithConfirm(async () => { calls++; if (calls === 1) throw abortErr(); return resp(500); }, { hasSendId: true }); } catch (e) { threw = e; }
  t("確かめが 5xx → 届いたか分からない（未送信とは言わない）", threw instanceof UncertainSendError);
  threw = null; calls = 0;
  try { await postWithConfirm(async () => { calls++; throw abortErr(); }, { hasSendId: false }); } catch (e) { threw = e; }
  t("印なしは従来どおり1回だけ（打ち切りはそのまま）", calls === 1 && !(threw instanceof UncertainSendError) && isUncertainFetchError(threw));
  threw = null; calls = 0;
  try { await postWithConfirm(async () => { calls++; throw new Error("HTTP 500"); }, { hasSendId: true }); } catch (e) { threw = e; }
  t("打ち切りでない失敗は送り直さない", calls === 1 && !(threw instanceof UncertainSendError));

  // 帳簿つき送信: 打ち切り→確かめの2回とも同じ印・届いたら印を消す・失敗なら印を残す（押し直しで同じ印）
  const b2 = new SendIdBook();
  const seen: string[] = [];
  let k = 0;
  await sendWithIdempotency(b2, "imgs\u0001c1\u0001u1", async (sid) => { seen.push(sid); if (++k === 1) throw abortErr(); return resp(200); });
  t("帳簿つき: 打ち切りと確かめは同じ印", seen.length === 2 && seen[0] === seen[1] && parseSendId(seen[0]) === seen[0]);
  t("帳簿つき: 届いたら印を消す", !b2.has("imgs\u0001c1\u0001u1"));
  const seen2: string[] = [];
  await sendWithIdempotency(b2, "img\u0001c1\u0001u2", async (sid) => { seen2.push(sid); return resp(500); });
  await sendWithIdempotency(b2, "img\u0001c1\u0001u2", async (sid) => { seen2.push(sid); return resp(200); });
  t("帳簿つき: 失敗の後の押し直しは同じ印（前に一部届いていても二重にならない）", seen2[0] === seen2[1]);

  // サーバー: linePushIdem（X-Line-Retry-Key・409 受付済み → alreadySent）
  const sid = "3f2b8c1e-9a4d-4e2f-8b7a-000000000001";
  let hdr: Record<string, string> = {};
  const fakeFetch = (status: number, body: unknown) => (async (_u: unknown, init?: RequestInit) => { hdr = (init?.headers ?? {}) as Record<string, string>; return resp(status, body); }) as unknown as typeof fetch;
  const p1 = await linePushIdem({ token: "x", to: "g", messages: [{ type: "text", text: "a" }], sendId: sid, pushIndex: 1, fetchImpl: fakeFetch(200, { sentMessages: [{ id: "9" }] }) });
  t("push: 印があれば X-Line-Retry-Key（回数ごとの鍵）", hdr["X-Line-Retry-Key"] === retryKeyFor(sid, 1) && p1.ok && !p1.alreadySent && p1.sentMessageIds[0] === "9");
  const p2 = await linePushIdem({ token: "x", to: "g", messages: [], sendId: sid, fetchImpl: fakeFetch(409, { message: "The retry key is already accepted", sentMessages: [{ id: "7" }] }) });
  t("push: 409 受付済み → 届いている扱い（alreadySent・最初の id）", p2.ok && p2.alreadySent && p2.sentMessageIds.join() === "7");
  const p3 = await linePushIdem({ token: "x", to: "g", messages: [], sendId: null, fetchImpl: fakeFetch(200, {}) });
  t("push: 印なしは鍵を付けない（従来どおり）", !("X-Line-Retry-Key" in hdr) && p3.ok && !p3.alreadySent);
  const p4 = await linePushIdem({ token: "x", to: "g", messages: [], sendId: null, fetchImpl: fakeFetch(409, { message: "Conflict" }) });
  t("push: 印なしの 409 は失敗のまま", !p4.ok && p4.status === 409);
  const p5 = await linePushIdem({ token: "x", to: "g", messages: [], sendId: sid, fetchImpl: fakeFetch(429, "monthly limit") });
  t("push: 429 は失敗（本文を返す）", !p5.ok && p5.status === 429 && p5.errorText.includes("monthly"));

  // 鍵の作り方
  const big = "data:image/png;base64," + "A".repeat(50000);
  t("中身の鍵: 同じ中身は同じ・1文字違えば別", contentKey(big) === contentKey(big) && contentKey(big) !== contentKey(big.slice(0, -1) + "B"));
  t("物件出しリスト: 同じ日は同じ鍵・日が違えば別", propertyListSendKey(new Date("2026-10-23T01:00:00Z")) === propertyListSendKey(new Date("2026-10-23T14:00:00Z"))
    && propertyListSendKey(new Date("2026-10-23T14:00:00Z")) !== propertyListSendKey(new Date("2026-10-23T15:30:00Z")));

  console.log(`\n${pass} OK / ${fail} NG`);
  if (fail) process.exit(1);
}
void main();
