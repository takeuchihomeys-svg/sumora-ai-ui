// 2026-10-02 竹内「今日の1日に○通以上やり取りしているお客さんは…切り替わるスイッチ…1日でおわらせて、次の日もまた振り出しに戻す」
//   スイッチ（decideCacheWarm）の閾値・夜・静かになったら止める・日が変わったら戻る と、TTL の切り替え・mode・損得の見積もりを固定する
// 実行: npx tsx app/lib/__tests__/cache-warm-switch.test.ts（自己完結・env 不要。全 OK で exit 0）
import {
  decideCacheWarm, cacheWarmMode, cacheWarmParams, convBlockCacheControl, compactCacheWarm, estimateHotDayNetUsd,
  CACHE_WARM_DEFAULTS, convWarmHash,
} from "../cache-warm-switch";
import { cacheGroupOf } from "../claude-model-map";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}
// 2026-10-02 15:00 JST = 06:00 UTC
const NOW = Date.parse("2026-10-02T06:00:00Z");
const min = (m: number) => NOW - m * 60_000;
const d = (o: Partial<Parameters<typeof decideCacheWarm>[0]>) => decideCacheWarm({ nowMs: NOW, exchangesToday: 12, lastCustomerMsgMs: min(10), ...o });

console.log("── 既定値（本番 9.1日の帯の損得から N=10・静か120分）");
t("N=10", CACHE_WARM_DEFAULTS.minExchangesToday === 10);
t("静か120分", CACHE_WARM_DEFAULTS.quietMinutes === 120);

console.log("── スイッチ");
t("12通・10分前 → ON", d({}).on && d({}).reason === "on");
t("9通 → OFF（below_threshold）", !d({ exchangesToday: 9 }).on && d({ exchangesToday: 9 }).reason === "below_threshold");
t("ちょうど10通 → ON", d({ exchangesToday: 10 }).on);
t("お客様の最後の通から121分 → OFF（quiet）", d({ lastCustomerMsgMs: min(121) }).reason === "quiet");
t("120分ちょうどは ON", d({ lastCustomerMsgMs: min(120) }).on);
t("数えられない → OFF", d({ exchangesToday: null }).reason === "unknown_count");
t("今日のお客様の通が無い（昨日が最後）→ OFF", d({ lastCustomerMsgMs: Date.parse("2026-10-01T14:00:00Z") }).reason === "no_customer_msg_today");
const night = decideCacheWarm({ nowMs: Date.parse("2026-10-02T13:30:00Z"), exchangesToday: 30, lastCustomerMsgMs: Date.parse("2026-10-02T13:20:00Z") });
t("22:30 JST → OFF（night）", !night.on && night.reason === "night", night);
const early = decideCacheWarm({ nowMs: Date.parse("2026-10-02T23:30:00Z"), exchangesToday: 30, lastCustomerMsgMs: Date.parse("2026-10-02T23:20:00Z") });
t("翌 8:30 JST → OFF（night）", early.reason === "night");
t("日の印は JST", d({}).day === "2026-10-02");
// 振り出しに戻す: 日が変わるとやり取りは 0 から（呼び出し側が今日の分だけ数える）。翌 9:10 の 1通目は OFF
const nextDay = decideCacheWarm({ nowMs: Date.parse("2026-10-03T00:10:00Z"), exchangesToday: 1, lastCustomerMsgMs: Date.parse("2026-10-03T00:05:00Z") });
t("翌日 9:10・今日1通 → OFF（振り出し）", !nextDay.on && nextDay.day === "2026-10-03");
t("閾値の上書き", decideCacheWarm({ nowMs: NOW, exchangesToday: 5, lastCustomerMsgMs: min(1), minExchangesToday: 5 }).on);

console.log("── mode と TTL（文面は変えず cache_control だけ）");
t("既定は shadow", cacheWarmMode({}) === "shadow");
t("on / off", cacheWarmMode({ BRAIN_CACHE_WARM: "ON" }) === "on" && cacheWarmMode({ BRAIN_CACHE_WARM: "off" }) === "off");
t("ON×on → 1h", JSON.stringify(convBlockCacheControl(d({}), "on")) === JSON.stringify({ type: "ephemeral", ttl: "1h" }));
t("ON×shadow → 今まで通り 5分", JSON.stringify(convBlockCacheControl(d({}), "shadow")) === JSON.stringify({ type: "ephemeral" }));
t("OFF×on → 5分", JSON.stringify(convBlockCacheControl(d({ exchangesToday: 3 }), "on")) === JSON.stringify({ type: "ephemeral" }));
t("null → 5分", JSON.stringify(convBlockCacheControl(null, "on")) === JSON.stringify({ type: "ephemeral" }));
t("params の上書きと壊れた値", cacheWarmParams({ BRAIN_CACHE_WARM_MIN_EXCHANGES: "15", BRAIN_CACHE_WARM_QUIET_MIN: "x" }).minExchangesToday === 15 && cacheWarmParams({ BRAIN_CACHE_WARM_QUIET_MIN: "x" }).quietMinutes === 120);
t("digest の短い形", JSON.stringify(compactCacheWarm(d({}), "shadow", "abcd1234")) === JSON.stringify({ on: true, r: "on", n: 12, th: 10, m: "shadow", h: "abcd1234" }));
t("温めの行の hash", convWarmHash("c1") === "convwarm:c1");
t("温めの名札はブレインの組（本物と同じモデルに写る）", cacheGroupOf("brain-conv-warm").includes("brain_fresh") && cacheGroupOf("brain_fresh").includes("brain-conv-warm"));

console.log("── 損得の見積もり（q が低い今は損・q が高ければ得）");
const hot = { calls: 9, P: 3000, S: 40000, p5: 0.38, p60: 0.87, warms: 2 };
t("今の q=0.43・P=3k → 損", estimateHotDayNetUsd({ ...hot, q: 0.43 }) < 0, estimateHotDayNetUsd({ ...hot, q: 0.43 }));
t("q=0.9・P=8k → 得", estimateHotDayNetUsd({ ...hot, q: 0.9, P: 8000 }) > 0, estimateHotDayNetUsd({ ...hot, q: 0.9, P: 8000 }));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
