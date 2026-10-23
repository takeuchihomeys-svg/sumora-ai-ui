// app/lib/__tests__/send-idempotency.test.ts — 2026-10-23 送信の二重防止（10/23 10:05 Fetch is aborted の事例）
//   実行: npx tsx app/lib/__tests__/send-idempotency.test.ts
import { parseSendId, retryKeyFor, parseRetryKeyAccepted, isUncertainFetchError, sendIdempotencyOn } from "../send-idempotency";
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

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
