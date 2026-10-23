// app/lib/__tests__/send-idempotency.test.ts — 2026-10-23 送信の二重防止（10/23 10:05 Fetch is aborted の事例）
//   実行: npx tsx app/lib/__tests__/send-idempotency.test.ts
import {
  parseSendId, retryKeyFor, parseRetryKeyAccepted, isUncertainFetchError, sendIdempotencyOn,
  SendIdBook, postWithConfirm, sendWithIdempotency, linePushIdem, contentKey, propertyListSendKey, UncertainSendError,
  retryKeyForContent, cronRetryKey, splitByExistingLineIds, UNCERTAIN_SAFE_WINDOW_NOTE, SEND_ID_TTL_MIN,
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

  // ── 2026-10-23 見直し（レビューの残り） ──
  // 1. 物件出しリスト: 鍵に中身を混ぜる（「対象者なし」とリストは別の鍵）
  const kNone = retryKeyForContent(sid, "none\u0001✅ 今日の物件出し対象者はいません！");
  const kList = retryKeyForContent(sid, "list\u0001📋 リスト（3名）");
  t("中身つきの鍵: UUID の形・同じ中身は同じ", UUID.test(kNone) && kNone === retryKeyForContent(sid, "none\u0001✅ 今日の物件出し対象者はいません！"));
  t("中身つきの鍵: 「対象者なし」とリストは別の鍵（押し直しでリストが送られる）", kNone !== kList);
  t("中身つきの鍵: 対象者が変われば別の鍵", kList !== retryKeyForContent(sid, "list\u0001📋 リスト（4名）"));
  t("中身つきの鍵: 印が違えば別の鍵", kList !== retryKeyForContent("3f2b8c1e-9a4d-4e2f-8b7a-000000000002", "list\u0001📋 リスト（3名）"));
  t("中身つきの鍵: 上半分は印のまま（大文字も小文字に）", retryKeyForContent(sid.toUpperCase(), "x").slice(0, 19) === sid.toLowerCase().slice(0, 19));
  // 2. 知らせの文に安全な時間
  t("知らせ: 安全に押し直せる時間（帳簿の分数）を言う", UNCERTAIN_SAFE_WINDOW_NOTE.includes(`${SEND_ID_TTL_MIN}分以内`) && SEND_ID_TTL_MIN === 10);
  // 3. AIX の「画像 → 文」: 文が届くまで画像の印を残す
  {
    let n = 0;
    const book = new SendIdBook(600_000, () => `id-${++n}`);
    const seen: string[] = [];
    await sendWithIdempotency(book, "imgs-A", async (s) => { seen.push(s); return resp(200, { sentMessageIds: ["L1"] }); }, undefined, { keep: true });
    t("ひとまとまり: 画像が届いても印を残す（keep）", book.has("imgs-A"));
    let threw = false;
    try { await sendWithIdempotency(book, "txt-A", async () => { throw abortErr(); }); } catch (e) { threw = e instanceof UncertainSendError; }
    t("ひとまとまり: 文は届いたか分からない", threw && book.has("txt-A"));
    await sendWithIdempotency(book, "imgs-A", async (s) => { seen.push(s); return resp(200, { alreadySent: true }); }, undefined, { keep: true });
    t("ひとまとまり: 押し直しの画像は同じ印（LINE は送らない）", seen[0] === seen[1]);
    await sendWithIdempotency(book, "txt-A", async () => resp(200, {}));
    book.done("imgs-A");   // 画面: 文が届いたら releaseComposeKeys
    t("ひとまとまり: 文が届いたら両方の印が消える", !book.has("txt-A") && !book.has("imgs-A"));
    await sendWithIdempotency(book, "imgs-B", async () => resp(200, {}));
    t("keep なしは従来どおり届いたら消す", !book.has("imgs-B"));
  }
  // 4. messages の行を二重に入れない
  {
    const items = [{ u: "a", lid: "L1" }, { u: "b", lid: "L2" }, { u: "c", lid: "L2" }, { u: "d", lid: null }, { u: "e", lid: "L3" }];
    const { toInsert, skipped } = splitByExistingLineIds(items, (x) => x.lid, new Set(["L1"]));
    t("二重の行: もう入っている id は外す・束の中の重なりも1回・id 無しは入れる",
      toInsert.map((x) => x.u).join() === "b,d,e" && skipped.map((x) => x.u).join() === "a,c");
    t("二重の行: 何も入っていなければ全部", splitByExistingLineIds(items.slice(0, 2), (x) => x.lid, new Set()).toInsert.length === 2);
  }
  // 5. cron の行の鍵
  const c1 = cronRetryKey("scheduled_messages", "row-1\u0001text");
  t("cron の鍵: UUID の形・同じ行は毎回同じ", UUID.test(c1) && c1 === cronRetryKey("scheduled_messages", "row-1\u0001text"));
  t("cron の鍵: 行・部分・処理が違えば別", new Set([c1, cronRetryKey("scheduled_messages", "row-2\u0001text"), cronRetryKey("scheduled_messages", "row-1\u0001img0"), cronRetryKey("viewing-announce", "row-1\u0001text")]).size === 4);
  t("cron の鍵: 数の id も使える", UUID.test(cronRetryKey("line_tasks:completed", 42)));
  const p6 = await linePushIdem({ token: "x", to: "g", messages: [], sendId: null, retryKey: c1, fetchImpl: fakeFetch(409, { message: "The retry key is already accepted", sentMessages: [{ id: "5" }] }) });
  t("push: 鍵を渡せばその鍵・409 は届いている扱い（cron の重なり）", hdr["X-Line-Retry-Key"] === c1 && p6.ok && p6.alreadySent && p6.sentMessageIds.join() === "5");
  const p7 = await linePushIdem({ token: "x", to: "g", messages: [], sendId: sid, pushIndex: 2, retryKey: kList, fetchImpl: fakeFetch(200, {}) });
  t("push: 渡した鍵は印と回数より優先", hdr["X-Line-Retry-Key"] === kList && p7.ok);

  console.log(`\n${pass} OK / ${fail} NG`);
  if (fail) process.exit(1);
}
void main();
