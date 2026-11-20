// LINE の webhook の本文を貯めて入れ直す（作業員M 2026-11-21・竹内さん「返信が来ているのにツールに反映されない」）
// 実行: npx tsx app/lib/__tests__/line-webhook-inbox.test.ts（Blob・DB には触らない純関数だけ）
import { lineInboxOn, inboxPathOf, inboxCountsOf, replayAtOf, INBOX_PREFIX, inboxPut } from "../line-webhook-inbox";
let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };

t("既定 on（鍵がある時）", lineInboxOn({ BLOB_READ_WRITE_TOKEN: "x" }) === true);
t("off で止まる", lineInboxOn({ BLOB_READ_WRITE_TOKEN: "x", LINE_WEBHOOK_INBOX: "off" }) === false);
t("Blob の鍵が無ければ何もしない", lineInboxOn({}) === false);
{
  const p = inboxPathOf("2026-11-21T03:04:05.678Z", "ab/c!d12345678901");
  t("置き場の名前（時刻の順・記号を落とす）", p.startsWith(INBOX_PREFIX) && p === `${INBOX_PREFIX}2026-11-21T03-04-05-678Z-abcd12345678.json`, p);
  t("空の乱数でも名前が付く", inboxPathOf("2026-11-21T00:00:00.000Z", "!!").endsWith("-x.json"));
}
{
  const body = JSON.stringify({ destination: "U1", events: [
    { type: "message", message: { id: "111", type: "text", text: "空いてますか" }, timestamp: 1763690000000 },
    { type: "follow" },
    { type: "message", message: { id: "222", type: "image" } },
  ] });
  const c = inboxCountsOf(body);
  t("数える（イベント3・メッセージ2・id）", c.events === 3 && c.messages === 2 && c.ids.join(",") === "111,222", c);
  t("壊れた本文は0", inboxCountsOf("{").events === 0);
}
t("入れ直しの時刻は LINE の timestamp", replayAtOf({ timestamp: 1763690000000 }, true) === new Date(1763690000000).toISOString());
t("入れ直しでなければ使わない", replayAtOf({ timestamp: 1763690000000 }, false) === undefined);
t("時刻が無い・おかしい時は使わない", replayAtOf({}, true) === undefined && replayAtOf({ timestamp: 12 }, true) === undefined);
(async () => {
  // 鍵が無い時は置かずに null（投げない・ログだけ）
  const r = await inboxPut("{}", "sig", "save_failed", "webhook", {});
  t("鍵が無い時は null（投げない）", r === null);
  console.log(`\nline-webhook-inbox: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
