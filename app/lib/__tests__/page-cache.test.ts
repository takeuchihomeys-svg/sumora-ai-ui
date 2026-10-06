// app/lib/__tests__/page-cache.test.ts — 画面をまたいで残る読み込みの控え（実行: npx tsx app/lib/__tests__/page-cache.test.ts）
import { cacheGet, cacheSet, cacheUpdate, cacheDrop, cachedLoad, cacheClearAll } from "../page-cache";
import { pendingByCustomer } from "../pickup-list-load";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

(async () => {
  cacheClearAll();
  cacheSet("a", { n: 1 }, 1000);
  t("控えを返す（年齢つき）", cacheGet<{ n: number }>("a", 5000, 3000)?.value.n === 1 && cacheGet("a", 5000, 3000)?.ageMs === 2000);
  t("古すぎる控えは出さない", cacheGet("a", 1000, 3000) === null);
  cacheUpdate("a", { n: 2 });
  t("中身だけ差し替え（読んだ時刻は同じ）", cacheGet<{ n: number }>("a", 5000, 3000)?.value.n === 2 && cacheGet("a", 5000, 3000)?.at === 1000);
  cacheUpdate("nokey", { n: 9 });
  t("無い鍵は差し替えない", cacheGet("nokey", 1e9) === null);
  cacheSet("pickups:list:1", 1); cacheSet("pickups:list:30", 30);
  cacheDrop("pickups:list:");
  t("頭が同じ鍵をまとめて捨てる", cacheGet("pickups:list:1", 1e9) === null && cacheGet("pickups:list:30", 1e9) === null && cacheGet("a", Infinity) !== null);

  // 同時に2回読んでも1回だけ（親のタブの数と子の一覧）
  let calls = 0;
  const loader = () => new Promise<number>((r) => { calls++; setTimeout(() => r(42), 20); });
  const [x, y] = await Promise.all([cachedLoad("k", loader, { freshMs: 1000 }), cachedLoad("k", loader, { freshMs: 1000 })]);
  t("同時の読み込みは1回（同じ約束を待つ）", calls === 1 && x === 42 && y === 42, String(calls));
  await cachedLoad("k", loader, { freshMs: 60_000 });
  t("新しい控えがあれば読まない", calls === 1);
  await cachedLoad("k", loader, { freshMs: 60_000, force: true });
  t("force は読み直す", calls === 2);
  let fails = 0;
  await cachedLoad("e", () => { fails++; return Promise.reject(new Error("x")); }).catch(() => {});
  await cachedLoad("e", () => { fails++; return Promise.resolve(1); });
  t("失敗した読み込みは控えに残らず、次は読み直す", fails === 2 && cacheGet("e", 1e9)?.value === 1);

  const m = pendingByCustomer({ ok: true, customers: [{ key: "a", property_customer_id: "p1", conversation_id: null, pending: 2 }, { key: "b", property_customer_id: "p2", conversation_id: null, pending: 0 }, { key: "c", property_customer_id: null, conversation_id: "c", pending: 3 }] });
  t("未確認の数（紐付けのある・1件以上だけ）", m.size === 1 && m.get("p1") === 2);
  console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
})();
