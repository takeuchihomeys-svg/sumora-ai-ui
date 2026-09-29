// app/lib/__tests__/screen-watch-expect.test.ts
// 見張りの「決め方のズレ」（screen-watch-expect.ts）のテスト。実行: npx tsx app/lib/__tests__/screen-watch-expect.test.ts
//
// 2026-09-29 見張り: ブレインの意図（intent）と、resolve-area・ブレインを通らない別の道の期待（expect）を比べる。
//   本番の search_audits（9/15〜9/29・146回）に当てて誤警報を目で読み、直した言い回しを実物のままテストに残す
//   （「南方では無く」・「大阪メトロ」の大阪・「日本橋1.2丁目」・「枚方市光善寺駅」・「茨木、豊中」を区で入れた回・スタッフの個別の検索）
import { independentExpectation, buildSearchIntent, decisionDrift, splitExcluded, intentSummary, expectSummary, INTENT_STATION_CAP } from "../screen-watch-expect";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}
const intentOf = (intended: Record<string, unknown>, o: { site?: string; is_wide?: boolean; trigger?: string; snap?: Record<string, unknown> } = {}) =>
  buildSearchIntent({ site: o.site ?? "realpro", is_wide: o.is_wide ?? false, trigger: o.trigger ?? "web_brain", intended, customer_snapshot: o.snap ?? null }, null, null);

console.log("\n■ 通勤の到達駅（別の道の期待）");
{
  const e = independentExpectation({ desired_area: "梅田まで電車で30分" });
  const st = new Set(e.commute?.stations ?? []);
  t("梅田30分で 十三・江坂 が入る", st.has("十三") && st.has("江坂"), e.commute?.stations.slice(0, 20));
  t("高槻・堺東 は入らない", !st.has("高槻") && !st.has("堺東"));
  t("上限240駅で切る（capped）", (e.commute?.stations.length ?? 0) <= 240 && e.commute?.capped === true, { n: e.commute?.stations.length, total: e.commute?.total });
  const concrete = independentExpectation({ desired_area: "大日駅", commute_station: "梅田", commute_minutes: 30 });
  t("列だけの通勤＋具体的な希望エリア → 広げない（skipped=concrete_area）", concrete.commute?.skipped === "concrete_area", concrete.commute);
}

console.log("\n■ 決め方のズレ");
{
  const e = independentExpectation({ desired_area: "難波駅・梅田駅まで電車で30分以内で行ける距離" });
  const three = intentOf({ area_mode: "station", station_names: ["難波", "なんば", "梅田"] });
  const d = decisionDrift(three, e, null);
  t("実物（9/28 09:13）: 3駅と240駅 → commute_missing（warn）", d.severity === "warn" && d.items[0]?.kind === "commute_missing", d);
  const reach = e.commute!.stations;
  const full = intentOf({ area_mode: "station", station_names: reach, commute: { targets: [{ target: "梅田", minutes: 30 }], stations: reach.length } });
  t("到達駅が入っていれば ok", decisionDrift(full, e, null).severity === "ok", decisionDrift(full, e, null));
  const concreteE = independentExpectation({ desired_area: "大日駅", commute_station: "梅田", commute_minutes: 30 });
  t("広げなかった（concrete_area）は ok", decisionDrift(intentOf({ area_mode: "station", station_names: ["大日"] }), concreteE, null).severity === "ok");

  const named = independentExpectation({ desired_area: "京都駅、梅小路京都西、丹波口、二条、円町" });
  const nd = decisionDrift(intentOf({ area_mode: "station", station_names: ["小路", "丹波口", "二条", "円町"] }), named, null);
  t("実物（9/28 06:15）: 名指しの駅（京都）が入っていない → bad", nd.severity === "bad" && nd.missing.includes("京都"), nd);

  const wards = independentExpectation({ desired_area: "西区、浪速区、西成区" });
  const wideI = intentOf({ area_mode: "ward", city_codes: ["27106", "27111", "27122", "27128"] }, { is_wide: true });
  t("広げての余計な区（中央区）は許す", decisionDrift(wideI, wards, null).severity === "ok", decisionDrift(wideI, wards, null));
  const pinI = intentOf({ area_mode: "ward", city_codes: ["27106", "27111", "27122", "27128"] });
  const pd = decisionDrift(pinI, wards, null);
  t("ピンポイントで希望に無い区 → warn（ward_extra）", pd.severity === "warn" && pd.items[0]?.kind === "ward_extra" && pd.extra.includes("大阪市中央区"), pd);
  const adj = independentExpectation({ desired_area: "大阪市浪速区、大阪市天王寺区", adjacent_ok: true });
  const adjD = decisionDrift(intentOf({ area_mode: "ward", city_codes: ["27108", "27106", "27111", "27109"] }), adj, null);
  const noAdjD = decisionDrift(intentOf({ area_mode: "ward", city_codes: ["27108", "27106", "27111", "27109"] }), independentExpectation({ desired_area: "大阪市浪速区、大阪市天王寺区", adjacent_ok: false }), null);
  t("実物（9/27 01:42）: 隣の区も可（adjacent_ok）なら隣の区（西区）は余計ではない・隣でない区（大正区）は余計", !adjD.extra.includes("大阪市西区") && adjD.extra.includes("大阪市大正区") && noAdjD.extra.includes("大阪市西区"), { adj: adjD.extra, noAdj: noAdjD.extra });
  const wardMiss = decisionDrift(intentOf({ area_mode: "ward", city_codes: ["27106", "27111"] }), wards, null);
  t("名指しの区（西成区）が抜けた → bad", wardMiss.severity === "bad" && wardMiss.missing.includes("大阪市西成区"), wardMiss);
  const stationInWard = decisionDrift(intentOf({ area_mode: "ward", city_codes: ["27109", "27128"] }), independentExpectation({ desired_area: "上本町、谷町" }), null);
  t("実物: 「上本町、谷町」を区で入れた回 → 駅の区が入っていれば ok・読めない語（谷町）があれば余計を言わない", stationInWard.severity === "ok", stationInWard);
}

console.log("\n■ 誤警報にしない（実物の言い回し）");
{
  const a = independentExpectation({ desired_area: "なんば駅まで30分圏内(南方では無く大阪市内に近い方)" });
  t("「南方では無く」は名指しにしない（除外の語）", !a.named_stations.includes("南方") && a.excluded.some((x) => x.includes("南方")), a);
  const b = independentExpectation({ desired_area: "大阪メトロ中央線・千日前線・御堂筋線・四つ橋線・谷町線付近" });
  t("「大阪メトロ」の大阪を駅と読まない", !b.named_stations.includes("大阪"), b.named_stations);
  const c = independentExpectation({ desired_area: "日本橋1.2丁目" });
  t("「日本橋1.2丁目」は町名（駅の日本橋にしない）", !c.named_stations.includes("日本橋"), c);
  const d = independentExpectation({ desired_area: "枚方市光善寺駅・香里園" });
  t("「枚方市光善寺駅」の枚方市を区の名指しにしない", !d.named_wards.includes("枚方市"), d.named_wards);
  const e = independentExpectation({ desired_area: "カシータ神戸元町" });
  t("「神戸三宮・神戸元町」の神戸を区の名指しにしない（駅の中の語）", !e.named_wards.includes("神戸市") || decisionDrift(intentOf({ area_mode: "station", station_names: ["元町"] }), e, null).severity === "ok");
  const f = decisionDrift(intentOf({ area_mode: "ward", city_codes: ["27211", "27203"], ward_names: ["茨木市", "豊中市"] }, { site: "itandi", is_wide: true }), independentExpectation({ desired_area: "茨木、豊中" }), null);
  t("「茨木、豊中」を茨木市・豊中市で入れた回は ok", f.severity === "ok", f);
  const g = decisionDrift(intentOf({ area_mode: "ward", city_codes: ["27102", "27103", "27104", "27106", "27211", "27207"] }), independentExpectation({ desired_area: "大阪市内・茨木市・高槻市" }), null);
  t("「大阪市内」は大阪市の区を全部入ってよい区に", g.extra.every((w) => !w.startsWith("大阪市")), g);
  t("除外の語を分ける", splitExcluded("鶴見区以外、城東区").excluded.join() === "鶴見区以外" && splitExcluded("鶴見区以外、城東区").use === "城東区");
}

console.log("\n■ 比べない回");
{
  const e = independentExpectation({ desired_area: "大国町" });
  const single = decisionDrift(intentOf({ area_mode: "station", station_names: ["九条", "大正"] }, { trigger: "single" }), e, null);
  t("実物（9/27 11:36）: スタッフの個別の検索（一時調整）は比べない", single.severity === "ok", single);
  const ov = decisionDrift(intentOf({ area_mode: "station", station_names: ["大正"] }, { snap: { _search_override: { location: { mode: "only", stations: ["大正"] } } } }), e, null);
  t("メモの一時調整（場所）がある回は比べない", ov.severity === "ok", ov);
  const brain = decisionDrift(intentOf({ area_mode: "station", station_names: ["九条", "大正"] }), e, null);
  t("ブレインの回で名指しの駅が抜けたら bad", brain.severity === "bad" && brain.missing.includes("大国町"), brain);
  const capped = intentOf({ area_mode: "station", station_names: Array.from({ length: INTENT_STATION_CAP }, (_, i) => `駅${i}`) });
  t("点検の記録が駅の数で切れた回は「抜けた」と言わない", capped.stations_capped && decisionDrift(capped, e, null).severity === "ok");
  const oldCap = intentOf({ area_mode: "station", station_names: Array.from({ length: 80 }, (_, i) => `駅${i}`) });
  t("古い拡張の上限（80）で切れた回も言わない", oldCap.stations_capped);
  t("場所が1つも入っていない回は比べない（既存の点検が言う）", decisionDrift(intentOf({}), e, null).severity === "ok");
}

console.log("\n■ 意図の形・要約");
{
  const i = buildSearchIntent({ site: "realpro", is_wide: false, trigger: "web_brain", intended: { area_mode: "ward", city_codes: ["27106", "99999"], station_names: [] } },
    { source: "web_brain", chain: { from: "pinpoint" } }, [{ changed_field: "desired_area", created_at: "2026-09-29T01:00:00Z", source_message_id: "m1" }]);
  t("知らない市区のコード → wards_unknown（区は比べない）", i.wards_unknown && i.wards.join() === "大阪市西区", i);
  t("コマンドの出どころ・自動の広げて・最新の条件の変更", i.source === "web_brain" && i.chain && i.last_change?.field === "desired_area");
  t("要約の1行", /区 大阪市西区/.test(intentSummary(i)) && /ピンポイント/.test(intentSummary(i)), intentSummary(i));
  t("期待の要約", /通勤 梅田30分/.test(expectSummary(independentExpectation({ desired_area: "梅田まで30分" }))), expectSummary(independentExpectation({ desired_area: "梅田まで30分" })));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
