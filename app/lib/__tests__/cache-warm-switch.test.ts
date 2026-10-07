// 2026-10-02 竹内「今日の1日に○通以上やり取りしているお客さんは…切り替わるスイッチ…1日でおわらせて、次の日もまた振り出しに戻す」
//   スイッチ（decideCacheWarm）の閾値・夜・静かになったら止める・日が変わったら戻る と、TTL の切り替え・mode・損得の見積もりを固定する
// 実行: npx tsx app/lib/__tests__/cache-warm-switch.test.ts（自己完結・env 不要。全 OK で exit 0）
import {
  decideCacheWarm, cacheWarmMode, cacheWarmParams, convBlockCacheControl, convBlockMarkEnabled, compactCacheWarm, estimateHotDayNetUsd, buildConvBlocks,
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
t("digest の短い形", JSON.stringify(compactCacheWarm(d({}), "shadow", "abcd1234")) === JSON.stringify({ on: true, r: "on", n: 12, th: 10, m: "shadow", h: "abcd1234", bn: "3:1,6:1,10:1" }));
// 2026-10-02 竹内「記録だけとる」: N=3/6/10 それぞれなら ON だったかを影で記録（挙動は th のまま）
t("影の N=3/6/10（7通・閾値10）→ 本物は OFF・3 と 6 は ON", (() => { const x = d({ exchangesToday: 7 }); return !x.on && x.reason === "below_threshold" && x.byN?.[3] === true && x.byN?.[6] === true && x.byN?.[10] === false && compactCacheWarm(x, "shadow", null).bn === "3:1,6:1,10:0"; })());
t("影の N も夜は全部 OFF", (() => { const x = d({ nowMs: Date.parse("2026-10-02T14:00:00Z") }); return x.reason === "night" && !x.byN?.[3] && !x.byN?.[6] && !x.byN?.[10]; })());
t("温めの行の hash", convWarmHash("c1") === "convwarm:c1");
t("温めの名札はブレインの組（本物と同じモデルに写る）", cacheGroupOf("brain-conv-warm").includes("brain_fresh") && cacheGroupOf("brain_fresh").includes("brain-conv-warm"));

console.log("── 損得の見積もり（q が低い今は損・q が高ければ得）");
const hot = { calls: 9, P: 3000, S: 40000, p5: 0.38, p60: 0.87, warms: 2 };
t("今の q=0.43・P=3k → 損", estimateHotDayNetUsd({ ...hot, q: 0.43 }) < 0, estimateHotDayNetUsd({ ...hot, q: 0.43 }));
t("q=0.9・P=8k → 得", estimateHotDayNetUsd({ ...hot, q: 0.9, P: 8000 }) > 0, estimateHotDayNetUsd({ ...hot, q: 0.9, P: 8000 }));

// 2026-10-02 キャッシュ①（竹内「4はオススメでする」）: 会話専用ブロックを A（変わりにくい）・B（変わりやすい）に分ける
console.log("── 会話専用ブロックの組み立て（buildConvBlocks）");
{
  const five = { type: "ephemeral" as const };
  const hour = { type: "ephemeral" as const, ttl: "1h" as const };
  const two = buildConvBlocks({ isFreshLayer: true, a: "A", b: "B", combined: "", warmCc: hour });
  t("A・B の2ブロック・A が先・A は温めの印・B は5分", two.length === 2 && two[0].text === "A" && two[1].text === "B" && JSON.stringify(two[0].cache_control) === JSON.stringify(hour) && JSON.stringify(two[1].cache_control) === JSON.stringify(five));
  const onlyB = buildConvBlocks({ isFreshLayer: true, a: "  ", b: "B", combined: "", warmCc: hour });
  t("A が空なら B だけ・B が温めの印（旧の1ブロックと同じ）", onlyB.length === 1 && onlyB[0].text === "B" && JSON.stringify(onlyB[0].cache_control) === JSON.stringify(hour));
  t("両方空なら出さない（空のブロックは API エラー）", buildConvBlocks({ isFreshLayer: true, a: "", b: "", combined: "", warmCc: five }).length === 0);
  const full = buildConvBlocks({ isFreshLayer: false, a: "", b: "", combined: "X", warmCc: five });
  t("全体分析の層は今まで通り1ブロック・1h", full.length === 1 && full[0].text === "X" && JSON.stringify(full[0].cache_control) === JSON.stringify(hour));
  t("全体分析の層で空なら出さない", buildConvBlocks({ isFreshLayer: false, a: "", b: "", combined: "", warmCc: five }).length === 0);
}

console.log("── 会話専用ブロックの印（convBlockMarkEnabled・2026-10-07 ③キャッシュ）");
{
  const five = { type: "ephemeral" as const };
  const on = decideCacheWarm({ nowMs: Date.parse("2026-10-07T05:00:00Z"), exchangesToday: 12, lastCustomerMsgMs: Date.parse("2026-10-07T04:50:00Z") });
  const off = decideCacheWarm({ nowMs: Date.parse("2026-10-07T05:00:00Z"), exchangesToday: 2, lastCustomerMsgMs: Date.parse("2026-10-07T04:50:00Z") });
  t("温め ON×mode on → 印あり", convBlockMarkEnabled(on, "on", {}) === true);
  t("温め ON×shadow（今の本番）→ 印なし", convBlockMarkEnabled(on, "shadow", {}) === false);
  t("温め OFF×on → 印なし", convBlockMarkEnabled(off, "on", {}) === false);
  t("null → 印なし", convBlockMarkEnabled(null, "shadow", {}) === false);
  t("BRAIN_CONV_BLOCK_MARK=always → 今まで通り印あり", convBlockMarkEnabled(null, "shadow", { BRAIN_CONV_BLOCK_MARK: "always" }) === true);
  const noMark = buildConvBlocks({ isFreshLayer: true, a: "A", b: "B", combined: "", warmCc: five, mark: false });
  const withMark = buildConvBlocks({ isFreshLayer: true, a: "A", b: "B", combined: "", warmCc: five });
  t("印なしでも文字・ブロックの分け方は同じ（cache_control だけ外れる）", noMark.length === 2 && noMark.map((b) => b.text).join("|") === withMark.map((b) => b.text).join("|") && noMark.every((b) => b.cache_control === undefined));
  t("印なし・A が空 → B だけ・印なし", JSON.stringify(buildConvBlocks({ isFreshLayer: true, a: "", b: "B", combined: "", warmCc: five, mark: false })) === JSON.stringify([{ type: "text", text: "B" }]));
  t("全体分析の層は mark に関係なく 1h の1ブロック", buildConvBlocks({ isFreshLayer: false, a: "", b: "", combined: "X", warmCc: five, mark: false })[0].cache_control?.ttl === "1h");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
