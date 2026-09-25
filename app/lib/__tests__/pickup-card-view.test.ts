// 売上サポの物件カード（リアプロの物件一覧と同じ並び）と、まとめの回の寄せ方のテスト
// 実行: npx tsx app/lib/__tests__/pickup-card-view.test.ts
// 形は 2026-09-24〜25 の実物（property_pickups id 370・369・359・58・54・3）。お客様の名前・電話番号は無い
import {
  parseSummaryText, buildPickupCardView, cardHeadline, verdictMark, groupPickupRounds, mergeRoundItems,
  roundSiteSummary, verdictCounts, siteLabel, DASH, scoreGapNote, type PickupCardInput,
} from "../pickup-card-view";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}
const cell = (v: ReturnType<typeof buildPickupCardView>, key: string) => v.cells.find((c) => c.key === key);

// id 370（リアプロ・terms/location/equipment あり）
const R370: PickupCardInput = {
  rank: 1, property_name: "アリビオ夕陽丘", room_no: "202", verdict: "pass", score: 162, ad_yen: 166000, recommended: 0, site: "realpro",
  summary_text: "【1】アリビオ夕陽丘 202号室\n83,000円 10,500円\n1K 30.25㎡\n谷町線「四天王寺前夕陽ヶ丘」徒歩4分\nAD 2ヶ月",
  image_lines: ["間取り: 1K", "所在階: 2階部分", "向き: 東", "築年: 2021年06月", "現況: 空室", "入居可能日: 即入"],
  terms: { deposit: 0, keyMoney: 0, guaranteeDeposit: 0, buildingAge: 5, newBuild: false, moveIn: { kind: "immediate", current: "vacant", availableFrom: "2026-09-25" }, evidence: { amortization: "償却・敷引なし", area: "専有面積30.25m2" } },
  location: { ward: "大阪市天王寺区", stations: [{ line: "谷町線", walk: 4, station: "四天王寺前夕陽ケ丘" }] },
  equipment: { roomFloor: 2, totalFloors: 9 },
  reason_codes: ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "SQM_OK", "WALK_OK", "AD_HIGH", "MOVE_IN_OK"],
  reasons_ja: [],
};

console.log("■ 説明文を読む（リアプロの形）");
{
  const s = parseSummaryText(R370.summary_text);
  t("名前と号室を分ける", s.name === "アリビオ夕陽丘" && s.room === "202", s);
  t("賃料と管理費", s.rent === "83,000円" && s.admin === "10,500円", s);
  t("間取りと㎡", s.madori === "1K" && s.sqm === "30.25㎡", s);
  t("沿線と徒歩", s.access === "谷町線「四天王寺前夕陽ヶ丘」徒歩4分", s);
  t("AD", s.ad === "2ヶ月", s);
  const s2 = parseSummaryText("【1🌟★】エステムコート難波Ⅶビヨンド\n78,000円 7,000円\n1K 21.81㎡\nAD 171,600円");
  t("🌟★ の見出しでも名前が取れる・AD 円", s2.name === "エステムコート難波Ⅶビヨンド" && s2.ad === "171,600円" && s2.room == null, s2);
  // id 3: 末尾に「🧠 ブレイン判定」のまとめが付いた説明文
  const s3 = parseSummaryText("【3】Abelia(アベリア)\n83,000円 8,000円\n1LDK 39.13㎡\n\n🧠 ブレイン判定 5件（通す3・保留0・外す候補2）\n外す候補: X（この建物は送付済み）");
  t("ブレイン判定のまとめは読まない", s3.name === "Abelia(アベリア)" && s3.madori === "1LDK" && s3.ad == null && s3.access == null, s3);
  const s4 = parseSummaryText("【9🌟★】物件\nAD 2.5ヶ月");
  t("itandi の「物件」は名前にしない", s4.name == null && s4.ad === "2.5ヶ月", s4);
  t("空・null は空の形", parseSummaryText(null).name == null && parseSummaryText("").rent == null);
  const s5 = parseSummaryText("【2】X\n70,000円 なし\nワンルーム 18.5㎡");
  t("管理費なし・ワンルーム", s5.admin === "なし" && s5.madori === "ワンルーム" && s5.sqm === "18.5㎡", s5);
}

console.log("■ カード（リアプロの物件一覧の並び）");
{
  const v = buildPickupCardView(R370);
  t("建物の段: 名前・住所・沿線", v.name === "アリビオ夕陽丘" && v.address === "大阪市天王寺区" && v.access === "谷町線「四天王寺前夕陽ヶ丘」徒歩4分", v);
  t("築年・階建", v.building === "築5年・9階建", v.building);
  t("○ 通す 162点", v.mark.symbol === "○" && v.mark.score === 162, v.mark);
  t("部屋/階 202・2階", cell(v, "room")?.value === "202" && cell(v, "room")?.sub === "2階", cell(v, "room"));
  t("状態/入居 空室・即入", cell(v, "state")?.value === "空室" && cell(v, "state")?.sub === "即入", cell(v, "state"));
  t("間取り/㎡", cell(v, "madori")?.value === "1K" && cell(v, "madori")?.sub === "30.25㎡");
  t("賃料/管理費", cell(v, "rent")?.value === "83,000円" && cell(v, "rent")?.sub === "10,500円");
  t("敷金/礼金 なし なし", cell(v, "deposit")?.value === "なし" && cell(v, "deposit")?.sub === "なし");
  t("保証金/償却 なし なし", cell(v, "guarantee")?.value === "なし" && cell(v, "guarantee")?.sub === "なし", cell(v, "guarantee"));
  t("AD 2ヶ月", cell(v, "ad")?.value === "2ヶ月");
  t("点数の項目", cell(v, "score")?.value === "162点" && cell(v, "score")?.sub === "通す");
  // 2026-09-25 竹内「カードの項目もお客さんの理想の条件に合わせて表示する。それと AD。そして点数も（各項目の点数）」:
  //   お客様が書いた条件の項目（賃料・敷礼・間取り・徒歩・入居）→ AD → 事実だけの項目（部屋・保証金・築年）→ 点数
  t("並び: 書いた条件 → AD → 事実 → 点数", v.cells.map((c) => c.key).join(",") === "rent,deposit,madori,walk,state,ad,room,guarantee,built,score", v.cells.map((c) => c.key));
  t("敷金/礼金 なし なし +20（初期費用を抑えたい・一致）・緑", cell(v, "deposit")?.points === 20 && cell(v, "deposit")?.note === "初期費用を抑えたい・一致" && cell(v, "deposit")?.tone === "ok" && cell(v, "deposit")?.written === true, cell(v, "deposit"));
  t("間取り/㎡ は間取り＋広さの点（15＋3）", cell(v, "madori")?.points === 18, cell(v, "madori"));
  t("駅徒歩 4分・+10（徒歩・一致）", cell(v, "walk")?.value === "4分" && cell(v, "walk")?.points === 10 && cell(v, "walk")?.note === "徒歩・一致", cell(v, "walk"));
  t("AD は必ず出す・2ヶ月 +20 緑", cell(v, "ad")?.points === 20 && cell(v, "ad")?.tone === "ok", cell(v, "ad"));
  t("事実だけの項目は点なし（部屋/階）", cell(v, "room")?.points == null && cell(v, "room")?.written === false);

  // id 369: 償却の記載なし・入居 9月下旬
  const v369 = buildPickupCardView({ ...R370, summary_text: "【1】CITY　SPIRE難波WEST 508号室\n93,000円 12,000円\n1R 30.06㎡\n関西線「JR難波」徒歩8分\nAD 2ヶ月", room_no: "508",
    terms: { deposit: 0, keyMoney: 0, guaranteeDeposit: 0, buildingAge: 20, newBuild: false, moveIn: { kind: "date", date: "2026-09", part: "下旬", current: "vacant", availableFrom: "2026-09-21" }, evidence: {} } });
  t("償却の記載なし → －", cell(v369, "guarantee")?.sub === DASH, cell(v369, "guarantee"));
  t("入居 9月下旬", cell(v369, "state")?.sub === "9月下旬", cell(v369, "state"));
  t("1R を間取りに", cell(v369, "madori")?.value === "1R");

  // id 58（itandi・古い行: terms/location なし・説明文は「物件」と AD だけ・画像の読み取りあり）
  const v58 = buildPickupCardView({ rank: 9, property_name: "物件", room_no: null, verdict: "pass", score: 120, ad_yen: null, recommended: 2, site: "itandi",
    summary_text: "【9🌟★】物件\nAD 2.5ヶ月", image_lines: ["間取り: 1K", "所在階: 9階", "築年: 2008年6月", "現況: 空き", "入居可能日: 相談"], terms: null, location: null, equipment: null,
    reason_codes: null, reasons_ja: ["ADが高い（2ヶ月以上）"] });
  t("itandi: 名前なし（null）", v58.name == null);
  t("itandi: 画像の読み取りから 階・状態・入居・間取り", cell(v58, "room")?.value === DASH && cell(v58, "room")?.sub === "9階" && cell(v58, "state")?.value === "空室" && cell(v58, "state")?.sub === "相談" && cell(v58, "madori")?.value === "1K", v58.cells);
  t("itandi: 書いていない値は －", cell(v58, "rent")?.value === DASH && cell(v58, "deposit")?.value === DASH && v58.access == null && v58.address == null);
  t("itandi: 築年は画像の読み取りから", cell(v58, "built")?.value === "2008年築", cell(v58, "built"));
  const v54 = buildPickupCardView({ rank: 5, property_name: "物件", room_no: null, verdict: "pass", score: 105, ad_yen: null, site: "itandi",
    summary_text: "【5】物件\nAD 1ヶ月", image_lines: ["現況: 居住中", "入居可能日: 2026年11月中旬", "間取り: 1K"] });
  t("居住中・11月中旬", cell(v54, "state")?.value === "居住中" && cell(v54, "state")?.sub === "11月中旬", cell(v54, "state"));
  t("AD は説明文 → 無ければ ad_yen", buildPickupCardView({ ...R370, summary_text: "【1】X\n80,000円", ad_yen: 150000 }).cells.find((c) => c.key === "ad")?.value === "150,000円");
  t("沿線は説明文 → 無ければ場所の駅", buildPickupCardView({ ...R370, summary_text: "【1】X" }).access === "谷町線「四天王寺前夕陽ケ丘」徒歩4分");
  t("room_no が優先", buildPickupCardView({ ...R370, room_no: "0202" }).room === "0202");
}

console.log("■ 項目ごとの点（案B）: 合う緑・合わない赤・要確認灰・全部合う・書いていない");
{
  const v = buildPickupCardView({ ...R370, reason_codes: ["RENT_SLIGHTLY_OVER", "ZERO_ZERO", "FLOOR_PLAN_MATCH", "SQM_UNKNOWN", "WALK_OK", "WALK_NEAR_W5", "BUILDING_AGE_TEXT_OK", "AGE_W5",
    "EQUIP_AUTOLOCK_MUST_OK", "EQUIP_DELIVERY_BOX_UNLISTED", "AD_COVERS_DISCOUNT", "AD_1M", "FIT_ONE_MISS"] });
  const keys = v.cells.map((c) => c.key);
  t("書いた条件が上（賃料→間取り→徒歩→築年→設備）→ 全部合う → AD → 書いていない（敷礼0）", keys.slice(0, 9).join(",") === "rent,madori,walk,built,eq:AUTOLOCK,eq:DELIVERY_BOX,fit,ad,deposit", keys);
  t("家賃 少し超え → 赤・±0（予算・外れ）", cell(v, "rent")?.tone === "ng" && cell(v, "rent")?.points === 0 && cell(v, "rent")?.note === "予算・外れ", cell(v, "rent"));
  t("間取り ○＋広さ 要確認 → 緑（読めない広さは外れにしない）", cell(v, "madori")?.tone === "ok", cell(v, "madori"));
  t("駅近: 徒歩 +10＋5分以内 +5 ＝ +15（駅近・一致）", cell(v, "walk")?.points === 15 && cell(v, "walk")?.note === "駅近・一致", cell(v, "walk"));
  t("築浅: +12（築浅・一致）", cell(v, "built")?.points === 12 && cell(v, "built")?.note === "築浅・一致", cell(v, "built"));
  t("設備 オートロック（必須）○ +5", cell(v, "eq:AUTOLOCK")?.head === "オートロック" && cell(v, "eq:AUTOLOCK")?.value === "○" && cell(v, "eq:AUTOLOCK")?.points === 5 && cell(v, "eq:AUTOLOCK")?.note === "必須・一致", cell(v, "eq:AUTOLOCK"));
  t("設備 宅配ボックス 記載なし → 灰・要確認", cell(v, "eq:DELIVERY_BOX")?.tone === "unread" && cell(v, "eq:DELIVERY_BOX")?.value === DASH, cell(v, "eq:DELIVERY_BOX"));
  t("全部合うの行: 1つだけ外れ +5", cell(v, "fit")?.points === 5 && /1つ外れ/.test(cell(v, "fit")?.note ?? ""), cell(v, "fit"));
  t("書いていない敷礼0: +8（書いていない）・見出しは薄い（written=false）", cell(v, "deposit")?.points === 8 && cell(v, "deposit")?.note === "書いていない" && cell(v, "deposit")?.written === false, cell(v, "deposit"));
  t("項目の点の合計＋50 ＝ 判定の点（札が全部どこかの項目に入る）", 50 + v.cells.reduce((a, c) => a + (c.points ?? 0), 0) === 50 + 0 + 8 + 15 + 0 + 10 + 5 + 0 + 12 + 5 + 0 + 0 + 15 + 5, v.cells.map((c) => [c.key, c.points]));
  const held = buildPickupCardView({ ...R370, verdict: "hold", reason_codes: ["RENT_OK", "INITIAL_COST_NOT_ZERO", "AD_HIGH_HELD"] });
  t("保留の物件の AD は 0点（保留の物件なので0点）", cell(held, "ad")?.points === 0 && cell(held, "ad")?.note === "保留の物件なので0点", cell(held, "ad"));
  t("敷礼あり（抑えたい人）→ 赤 −15", cell(held, "deposit")?.tone === "ng" && cell(held, "deposit")?.points === -15, cell(held, "deposit"));
  const none = buildPickupCardView({ ...R370, reason_codes: ["RENT_OK", "AD_NONE", "PROFIT_NEGATIVE"] });
  t("AD なし → 赤 −20（割引の方が大きい）", cell(none, "ad")?.tone === "ng" && cell(none, "ad")?.points === -20, cell(none, "ad"));
  const noAd = buildPickupCardView({ ...R370, summary_text: "【1】X\n80,000円", ad_yen: null, reason_codes: ["RENT_OK"] });
  t("AD の札が無い行でも AD の項目は出す（要確認）", cell(noAd, "ad")?.value === DASH && cell(noAd, "ad")?.note === "要確認", cell(noAd, "ad"));
}

console.log("■ 判定の札と畳んだ時の1行");
{
  t("△ 保留", verdictMark("hold", 62).symbol === "△" && verdictMark("hold", 62).label === "保留");
  t("× 外す候補", verdictMark("drop", 10).symbol === "×");
  t("判定なし", verdictMark(null, null).symbol === "－" && verdictMark(null, null).score == null);
  const hold = cardHeadline({ verdict: "hold", reason_codes: ["RENT_OK", "PROFIT_NEGATIVE", "FLOOR_PLAN_MATCH"], reasons_ja: [] });
  t("保留: 理由の最初の1つ", !!hold && hold.text.startsWith("保留の理由: ") && hold.tone === "minus", hold);
  const drop = cardHeadline({ verdict: "drop", reason_codes: ["FLOOR_PLAN_MATCH", "ALREADY_SENT"], reasons_ja: [] });
  t("外す候補: 外す理由が先", !!drop && drop.text.startsWith("外す理由: ") && drop.tone === "drop", drop);
  const pass = cardHeadline({ verdict: "pass", reason_codes: ["AD_HIGH", "FLOOR_PLAN_MATCH"], reasons_ja: [] });
  t("通す: 減点が無ければ一番の加点", !!pass && pass.text.startsWith("良い点: ") && pass.tone === "plus", pass);
  const old = cardHeadline({ verdict: "pass", reason_codes: null, reasons_ja: ["ADが高い（2ヶ月以上）"] });
  t("古い行（コードなし）は説明の1つ目", old?.text === "ADが高い（2ヶ月以上）" && old.tone === "info", old);
  t("理由が何も無ければ null", cardHeadline({ verdict: "pass", reason_codes: [], reasons_ja: [] }) == null);
}

console.log("■ まとめの回（時刻で寄せる）");
type B = { batch_id: string; created_at: string; site: string | null; round_id?: string | null; items: Array<{ id: number; rank: number; recommended: number; score: number | null; verdict: string | null }> };
const mk = (id: string, at: string, site: string, items: B["items"], round_id: string | null = null): B => ({ batch_id: id, created_at: at, site, items, round_id });
{
  // 実物: d08cf59e の 3回（05:17・05:19・05:19）／60be5b3d の 3回（09:01・09:01・09:02）
  const bs = [
    mk("b3", "2026-09-25T05:19:31Z", "realpro", [{ id: 371, rank: 1, recommended: 0, score: 150, verdict: "pass" }]),
    mk("b1", "2026-09-25T05:17:00Z", "realpro", [{ id: 368, rank: 1, recommended: 0, score: 160, verdict: "pass" }, { id: 367, rank: 2, recommended: 0, score: 90, verdict: "hold" }]),
    mk("b2", "2026-09-25T05:19:15Z", "itandi", [{ id: 369, rank: 1, recommended: 2, score: 120, verdict: "pass" }]),
    mk("old", "2026-09-24T09:01:00Z", "realpro", [{ id: 10, rank: 1, recommended: 0, score: 80, verdict: "pass" }]),
  ];
  const r = groupPickupRounds(bs);
  t("2つの回に寄る（前日と当日）", r.length === 2, r.map((x) => x.key));
  t("古い順", r[0].batch_ids[0] === "old");
  t("当日の3回が1つ（届いた順）", r[1].batch_ids.join(",") === "b1,b2,b3" && r[1].key === "b1,b2,b3", r[1]);
  t("最初と最後の時刻", r[1].created_at === "2026-09-25T05:17:00Z" && r[1].last_at === "2026-09-25T05:19:31Z");
  t("1回だけの回は元の batch_id が鍵", r[0].key === "old");
  const merged = mergeRoundItems(r[1].batches);
  // 2026-09-25 点の高い順（🌟★ は同点の時だけ上）。👑（bestId）を渡せば先頭
  t("まとめた並び: 点の高い順（🌟★ の 120点は3番目）", merged.map((x) => x.id).join(",") === "368,371,369,367", merged.map((x) => x.id));
  t("まとめた並び: 👑 を先頭に", mergeRoundItems(r[1].batches, 371).map((x) => x.id).join(",") === "371,368,369,367");
  t("サイトの内訳", roundSiteSummary(r[1].batches) === "リアプロ 3・itandi 1", roundSiteSummary(r[1].batches));
  t("判定の数", verdictCounts(merged) === "○通す 3・△保留 1", verdictCounts(merged));

  const gap = groupPickupRounds([mk("a", "2026-09-25T10:00:00Z", "realpro", []), mk("b", "2026-09-25T10:31:00Z", "itandi", [])]);
  t("31分空いたら別の回", gap.length === 2);
  const chain = groupPickupRounds([mk("a", "2026-09-25T10:00:00Z", "realpro", []), mk("b", "2026-09-25T10:29:00Z", "itandi", []), mk("c", "2026-09-25T10:58:00Z", "realpro", [])]);
  t("前の回から30分以内なら続ける", chain.length === 1 && chain[0].batch_ids.length === 3);
  const long = groupPickupRounds(Array.from({ length: 8 }, (_, i) => mk(`x${i}`, new Date(Date.parse("2026-09-25T10:00:00Z") + i * 29 * 60_000).toISOString(), "realpro", [])));
  t("最初から3時間を超えたら切る", long.length === 2 && long[0].batch_ids.length === 7, long.map((x) => x.batch_ids.length));
  t("空の入力", groupPickupRounds([]).length === 0);
}

console.log("■ まとめの回（完了の印 round_id を優先）");
{
  const bs = [
    mk("a", "2026-09-25T10:00:00Z", "realpro", [], "R1"),
    mk("b", "2026-09-25T10:05:00Z", "realpro", [], "R2"),   // 5分後でも別の回（完了の後の新しい回）
    mk("c", "2026-09-25T11:10:00Z", "itandi", [], "R1"),    // 70分後でも同じ印なら同じ回
    mk("d", "2026-09-25T10:06:00Z", "itandi", [], null),    // 印の無い回は印のある回に混ぜない
  ];
  const r = groupPickupRounds(bs);
  t("印ごとに寄る", r.length === 3, r.map((x) => x.key));
  t("R1 は時刻が離れていても1つ", r.find((x) => x.round_id === "R1")?.batch_ids.join(",") === "a,c");
  t("R2 は別", r.find((x) => x.round_id === "R2")?.batch_ids.join(",") === "b");
  t("印なしは単独", r.find((x) => x.round_id == null)?.batch_ids.join(",") === "d");
  t("空白だけの印は印なし扱い", groupPickupRounds([mk("a", "2026-09-25T10:00:00Z", "realpro", [], "  "), mk("b", "2026-09-25T10:01:00Z", "realpro", [])]).length === 1);
}

console.log("■ サイトの札");
t("リアプロ／itandi", siteLabel("realpro") === "リアプロ" && siteLabel("itandi") === "itandi" && siteLabel(null) === "-");

console.log("■ 点数の項目の一言（項目の合計＋50 と合計点が合わない時だけ・反証レビュー 2026-09-25）");
{
  const codes = ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "AD_HIGH"]; // 50+15+20+15+20 = 120
  t("一致する時は何も出さない", scoreGapNote(codes, 120) === null);
  t("保存が前の配点（案B の前の行）", scoreGapNote(codes, 110) === "今の配点では 120点", scoreGapNote(codes, 110));
  const big = [...codes, "AD_1_5M", "WALK_OK", "AGE_W5", "RENT_CHEAP_W80", "SQM_OK", "AREA_STATION_MATCH", "FIT_ALL", "EQUIP_BATH_TOILET_OK", "COMMUTE_OK", "MOVE_IN_OK", "AGE_COL_W5", "AD_VERY_HIGH"];
  const gb = scoreGapNote(big, 200);
  t("上限200で丸めた時は素点を出す", gb != null && gb.startsWith("上限200（素点 "), gb);
  const cap = [...codes, "EQUIP_BATH_TOILET_NG", "EQUIP_MUST_NG_CAP"];
  t("必須の × の上限20", scoreGapNote(cap, 20) === "必須の×で上限20（素点 110）", scoreGapNote(cap, 20));
  t("札が無い古い行・点なしは出さない", scoreGapNote(null, 100) === null && scoreGapNote(codes, null) === null);
  const v = buildPickupCardView({ ...R370, reason_codes: codes, score: 110 });
  t("カードの点数の項目に一言が付く", cell(v, "score")?.note === "今の配点では 120点", cell(v, "score"));
}

console.log("■ 必須の設備が × ／読めない時も「必須」（YUMA テスト お客様E 2026-09-25）");
{
  // 札の EQUIP_X_NG／_UNLISTED には強さが付かない → 保存した照合（equipment.match の strong）から引く
  const codes = ["RENT_OK", "FLOOR_PLAN_MATCH", "EQUIP_DELIVERY_BOX_UNLISTED", "EQUIP_AUTOLOCK_MUST_OK", "EQUIP_BATH_DRYER_UNLISTED", "AD_1M"];
  const equipment = { roomFloor: 3, totalFloors: 6, basement: false, match: [
    { key: "delivery_box", strong: true }, { key: "autolock", strong: true }, { key: "bath_dryer", strong: false },
  ] };
  const v = buildPickupCardView({ ...R370, reason_codes: codes, score: 50 + 15 + 15 + 5 + 15, equipment });
  t("宅配ボックス（必須・読めない）は「必須・要確認」", cell(v, "eq:DELIVERY_BOX")?.note === "必須・要確認", cell(v, "eq:DELIVERY_BOX"));
  t("オートロック（必須・○）は「必須・一致」", cell(v, "eq:AUTOLOCK")?.note === "必須・一致", cell(v, "eq:AUTOLOCK"));
  t("浴室乾燥機（必須でない・読めない）は「希望・要確認」", cell(v, "eq:BATH_DRYER")?.note === "希望・要確認", cell(v, "eq:BATH_DRYER"));
  const ng = buildPickupCardView({ ...R370, reason_codes: ["RENT_OK", "EQUIP_DELIVERY_BOX_NG", "EQUIP_MUST_NG_CAP"], score: 20, equipment });
  t("必須の × は「必須・外れ」（赤）", cell(ng, "eq:DELIVERY_BOX")?.note === "必須・外れ" && cell(ng, "eq:DELIVERY_BOX")?.tone === "ng", cell(ng, "eq:DELIVERY_BOX"));
  const noMatch = buildPickupCardView({ ...R370, reason_codes: codes, score: 100, equipment: { roomFloor: 3 } });
  t("照合が無い古い行は今まで通り「希望」", cell(noMatch, "eq:DELIVERY_BOX")?.note === "希望・要確認", cell(noMatch, "eq:DELIVERY_BOX"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
