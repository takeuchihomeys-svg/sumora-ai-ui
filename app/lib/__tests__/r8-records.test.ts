// 返信の質 8巡目（記録・2026-10-08 竹内「大丈夫」）のテスト: 見積書の記録の行・送った物件名・見張りの材料の要約・台帳の金額
// 本文は本番の実物の形（名前は外し、数字は実物の桁のまま）。実行: npx tsx app/lib/__tests__/r8-records.test.ts
import { estimateRecordItemsFromLog, parseCostNote, splitNameRoom } from "../estimate-record-items";
import { recommendationNamesFromText, namesNearSend, aixPropertyNamesForLog } from "../aix-sent-names";
import { summarizeMaterialLog, mergeWatchMaterials, openTurnKey, replyMaterialSizes, isTimeoutError, suppressedDraftSummary } from "../line-watch-materials";
import { resolvePropertyThreads, buildPropertyThreadNote, estimateAmountText, recommendGist, type PtMsg } from "../property-thread";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const ON = {} as Record<string, string | undefined>;
const OFF = { ESTIMATE_RECORDS_ALL: "off" };

console.log("── ① 見積書の AIX → estimate_records の行（全件）");
{
  const ONE = "【アコード中之島 1402号室】\n\n初期費用さらに\n🌟26,500円割引させて頂き\n初期費用：208,110円";
  const a = estimateRecordItemsFromLog({ aixType: "estimate_sheet", generatedText: ONE }, ON);
  t("【】の本文は従来どおり（aix_text・割引・初期費用）", a.length === 1 && a[0].source === "aix_text" && a[0].propertyName === "アコード中之島" && a[0].discountYen === 26_500 && a[0].initialCostYen === 208_110, a);

  // 物件確認した＋同封（60日 82通の形）: 本文に金額が無い・物件名は property_names
  const CHECK = "お待たせ致しました！！\nお送り頂きました物件の中で\n・オーロラ・タワー難波 1203号室\n・エスライズ難波 805号室\nこちら2件現在募集中となります！！\n最大限割引しました初期費用御見積書同封させて頂きました。\nお手隙の際にご査収ください！！";
  const b = estimateRecordItemsFromLog({ aixType: "property_check_result", generatedText: CHECK, propertyNames: ["オーロラ・タワー難波 1203号室", "エスライズ難波 805号室", "アドバンス難波南ワイズ 302号室"], propStatuses: ["available", "available", "unavailable"] }, ON);
  t("★ 物件確認した＋同封: property_names から（募集終了/申込ありは除く・金額なし）", b.length === 2 && b.every((x) => x.source === "check_names" && x.discountYen === null) && b[0].propertyName === "オーロラ・タワー難波" && b[0].roomNo === "1203" && b[1].roomNo === "805", b);
  t("★ 戻す（ESTIMATE_RECORDS_ALL=off）と従来どおり0件", estimateRecordItemsFromLog({ aixType: "property_check_result", generatedText: CHECK, propertyNames: ["オーロラ・タワー難波 1203号室"] }, OFF).length === 0);
  t("★ 仮の名前（物件①）は使わない", estimateRecordItemsFromLog({ aixType: "property_check_result", generatedText: CHECK, propertyNames: ["物件①", "シャーメゾン フェリシード 101号室"], propStatuses: ["available", "available"] }, ON).map((x) => x.propertyName).join("|") === "シャーメゾン フェリシード");

  // 会話に合わせる経路の費用メモ（13通の形）
  const notes = ["アーバネックス本町II 1105号室 / 初期費用合計: 254,300円 / 割引額: 61,000円 / 一般業者との差額（節約額）: 180,000円 / 家賃: 98,000円 / 高額項目: 賃貸保証料49,000円", "スプランディッド堀江 702号室 / 初期費用合計: 198,000円 / 割引額: 44,000円 / 家賃: 76,000円"];
  const c = estimateRecordItemsFromLog({ aixType: "property_check_result", generatedText: CHECK, propertyNames: ["アーバネックス本町II 1105号室", "スプランディッド堀江 702号室"], propStatuses: ["available", "available"], propCostNotes: notes }, ON);
  t("★ 費用メモがあれば金額つき（cost_notes・割引・初期費用・家賃）", c.length === 2 && c[0].source === "cost_notes" && c[0].propertyName === "アーバネックス本町II" && c[0].roomNo === "1105" && c[0].discountYen === 61_000 && c[0].initialCostYen === 254_300 && c[0].rentYen === 98_000 && c[1].discountYen === 44_000, c);
  t("費用メモの1行: 名前の無いメモは null", parseCostNote("初期費用合計: 100,000円", 0) === null);

  // 見積書送る・【】なし（4通の形）
  const NOHEAD = "お待たせいたしました！！\n\nMaison de Mine Nagai Parc Est. 805号室の10/15日ご入居の場合の初期費用お見積書をお送りさせていただきました！！\n\n管理会社より明細書送られ前の概算となりますのでご参考にください！！";
  const d = estimateRecordItemsFromLog({ aixType: "estimate_sheet", generatedText: NOHEAD }, ON);
  t("★ 【】なしの本文の「〇〇 805号室」（aix_text_room）", d.length === 1 && d[0].source === "aix_text_room" && d[0].propertyName === "Maison de Mine Nagai Parc Est." && d[0].roomNo === "805", d);
  const DISC = "お待たせいたしました！！\n\n代表から特別に許可をいただき仲介手数料無料と更に¥20,000円追加で割引ができましたので、最大限割引させていただいたお見積書をお送りさせていただきました😊！！";
  const e = estimateRecordItemsFromLog({ aixType: "estimate_sheet", generatedText: DISC }, ON);
  t("★ 物件名の無い本文は物件名なしの1行（割引だけ読む）", e.length === 1 && e[0].source === "aix_no_items" && e[0].propertyName === "" && e[0].discountYen === 20_000, e);
  const f = estimateRecordItemsFromLog({ aixType: "estimate_sheet", generatedText: null }, ON);
  t("★ 本文が空（6通）でも送った事実の1行", f.length === 1 && f[0].source === "aix_no_items" && f[0].discountYen === null, f);
  const g = estimateRecordItemsFromLog({ aixType: "estimate_sheet", generatedText: "10月20日ご入居の場合の日割り家賃と日割り駐車場料金も含めたお見積書お送りさせていただきました😊！！" }, ON);
  t("日付だけの本文は物件名にしない（aix_no_items）", g.length === 1 && g[0].source === "aix_no_items", g);
  t("splitNameRoom: 階＋号室は全体を名前に", splitNameRoom("ハイツ秋桜 2階8号室").room === null && splitNameRoom("Comforza 0302号室").room === "302");
}

console.log("── ② 物件オススメ・物件送付の物件名");
{
  const STAR = "🌟YOURMAISON粉浜駅前 305号室\n\n（オススメポイント）\n・家賃68,000円・管理費5,000円（合計73,000円）";
  t("★ 🌟の行から「建物 305号室」（台帳と同じ書き方）", JSON.stringify(recommendationNamesFromText(STAR)) === JSON.stringify(["YOURMAISON粉浜駅前 305号室"]), recommendationNamesFromText(STAR));
  t("★ 号室の無い🌟は建物名", JSON.stringify(recommendationNamesFromText("🌟エステムコート難波VIIピランド\n\n大国町駅徒歩6分…")) === JSON.stringify(["エステムコート難波VIIピランド"]), recommendationNamesFromText("🌟エステムコート難波VIIピランド\n\n大国町駅徒歩6分…"));
  t("見積書の🌟（割引）は名前にしない", recommendationNamesFromText("初期費用さらに\n🌟26,500円割引させて頂き").length === 0);
  const rows = [
    { property_name: "クリエオーレ私市山手", room_no: "104", sent_at: "2026-10-06T04:15:40Z", delivery: "customer" },
    { property_name: "フェリオ永田", room_no: "101", sent_at: "2026-10-06T04:15:52Z", delivery: "customer" },
    { property_name: "フェリオ永田", room_no: "101", sent_at: "2026-10-06T04:15:53Z", delivery: "customer" },
    { property_name: "グループの共有", room_no: null, sent_at: "2026-10-06T04:15:55Z", delivery: "line_group" },
    { property_name: "前の日の物件", room_no: "201", sent_at: "2026-10-05T04:15:00Z", delivery: "customer" },
  ];
  const n = namesNearSend(rows, "2026-10-06T04:15:36Z");
  t("★ 送信の前後の資料の記録だけ・重複なし・グループ共有は除く", JSON.stringify(n) === JSON.stringify(["クリエオーレ私市山手 104号室", "フェリオ永田 101号室"]), n);
}

console.log("── ③ 見張りの材料の要約");
{
  const blocks = { tag: "brain:blocks", conversationId: "c1", mode: "full", layer: "fresh", chars: { ledger: 1200, sentProps: 0, history: 5000, ragKnowledge: 0 }, userTotal: 9000 };
  const s = summarizeMaterialLog(blocks)!;
  t("★ brain:blocks → 届いた材料の文字数と空の材料", s.source === "brain" && s.key === "blocks" && JSON.stringify((s.summary as { empty: string[] }).empty) === JSON.stringify(["sentProps", "ragKnowledge"]) && (s.summary as { chars: Record<string, number> }).chars.ledger === 1200, s);
  const rag = summarizeMaterialLog({ tag: "brain:rag", conversationId: "c1", knowledge: { n: 8, max: 0.81, err: null }, winning: { n: 0, max: null, err: "canceling statement due to statement timeout" }, templates: { n: 3, max: 0.6, err: null } })!;
  const w = (rag.summary as { winning: { n: number; timeout?: boolean } }).winning;
  t("★ brain:rag → クエリごとの件数・時間切れ", w.n === 0 && w.timeout === true && (rag.summary as { knowledge: { n: number } }).knowledge.n === 8, rag);
  t("知らない tag は残さない", summarizeMaterialLog({ tag: "gen:blocks" }) === null);
  t("時間切れの見分け", isTimeoutError("fetch failed: AbortError") && isTimeoutError("57014") && !isTimeoutError("permission denied"));
  const sizes = replyMaterialSizes({ knowledge: "abc", examples: "", phrases: ["a", "b"], summary: null }, { tier: "T2" });
  t("★ 返信の材料の大きさ（空・null を分ける）", JSON.stringify(sizes) === JSON.stringify({ tier: "T2", sizes: { knowledge: 3, phrases: 2 }, empty: ["examples"] }), sizes);
  const merged = mergeWatchMaterials({ brain: { blocks: { userTotal: 1 } } }, [
    { source: "reply", key: "fetched", summary: sizes, at: "2026-10-08T00:00:00Z" },
    { source: "suppressed", key: "draft", summary: suppressedDraftSummary("x".repeat(5000), "duplicate_of_sent"), at: "2026-10-08T00:00:01Z" },
  ]);
  t("★ 前の要約を残して足す・下書きは 2,000字まで", (merged.brain.blocks as { userTotal: number }).userTotal === 1 && !!merged.reply.fetched && ((merged.suppressed.draft as { text: string }).text.length === 2000), merged);
  t("★ 番の鍵（トリガーと同じ）: 最後のスタッフより後の最初のお客様", openTurnKey([
    { sender: "customer", created_at: "2026-10-08T01:00:00Z" }, { sender: "staff", created_at: "2026-10-08T02:00:00Z" },
    { sender: "customer", created_at: "2026-10-08T03:00:00Z" }, { sender: "customer", created_at: "2026-10-08T03:05:00Z" },
  ]) === "2026-10-08T03:00:00Z");
  t("番が開いていなければ null", openTurnKey([{ sender: "customer", created_at: "2026-10-08T01:00:00Z" }, { sender: "staff", created_at: "2026-10-08T02:00:00Z" }]) === null);
}

console.log("── ④ 物件ごとの台帳に見積書の金額");
{
  t("金額の文", estimateAmountText({ discount_yen: 26_500, initial_cost_yen: 208_110 }, {}) === "割引 26,500円・初期費用 208,110円");
  t("戻す（PROPERTY_THREAD_ESTIMATE_AMOUNT=off）", estimateAmountText({ discount_yen: 26_500, initial_cost_yen: null }, { PROPERTY_THREAD_ESTIMATE_AMOUNT: "off" }) === null);
  const messages: PtMsg[] = [
    { sender: "customer", text: "アコード中之島 1402号室の初期費用知りたいです", created_at: "2026-10-06T04:58:37Z" },
    { sender: "staff", text: "【アコード中之島 1402号室】\n🌟26,500円割引させて頂き", created_at: "2026-10-06T06:00:00Z", is_aix_generated: true },
    { sender: "customer", text: "アコード中之島の礼金は安くなりますか", created_at: "2026-10-06T08:00:00Z" },
  ];
  const s = resolvePropertyThreads({
    messages, imageLabels: new Map(),
    aix: [{ created_at: "2026-10-06T06:00:01Z", aix_type: "estimate_sheet", generated_text: "【アコード中之島 1402号室】\n🌟26,500円割引させて頂き" }],
    estimates: [{ created_at: "2026-10-06T06:00:03Z", property_name: "アコード中之島", room_no: "1402", discount_yen: 26_500, initial_cost_yen: 208_110 }],
  });
  const room = s.rooms.find((r) => r.ref.display.includes("アコード中之島"));
  const ests = room?.events.filter((e) => e.kind === "estimate") ?? [];
  t("★ AIX の記録と見積書の記録が1つにまとまり、金額が付く", ests.length === 1 && ests[0].text === "割引 26,500円・初期費用 208,110円", room?.events);
  const note = buildPropertyThreadNote(s);
  t("★ 材料の文に「見積書を送った（割引 …・初期費用 …）」", /見積書を送った（割引 26,500円・初期費用 208,110円）/.test(note), note);
}

console.log("── ⑤ AIX の送信の物件名（号室まで）");
{
  t("★ 待ち合わせ: 画面の物件名", JSON.stringify(aixPropertyNamesForLog({ aixType: "meeting_place", text: "x", meetingPropertyName: "ロイヤル大淀 202号室" }, {})) === JSON.stringify(["ロイヤル大淀 202号室"]));
  const mp = aixPropertyNamesForLog({ aixType: "meeting_place", text: "かしこまりました！！\n9/12（金）ご案内させて頂きます！！\n\n9/12 15:00にロイヤル大淀 202号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！" }, {});
  t("★ 待ち合わせ: 本文の待ち合わせの場所", mp.length === 1 && /ロイヤル大淀/.test(mp[0]), mp);
  const es = aixPropertyNamesForLog({ aixType: "estimate_sheet", text: "①【スプランディッド本町グラン 1003号室】\n🌟40,000円割引\n②【ミラージュパレス本町Depart 1302号室】\n🌟30,000円割引" }, {});
  t("★ 見積書: 【】ごと", es.length === 2 && /1003号室/.test(es[0]) && /1302号室/.test(es[1]), es);
  const vi = aixPropertyNamesForLog({ aixType: "viewing_invite", text: "スプランディッド大阪EAST が現在建築中のお部屋となりますので\n🌟パークハイツアイリス2号館 のみご案内可能です😊！！\n\n直近ですと\n10/10(金) 11:00〜18:30" }, {});
  t("★ 内覧調整: 🌟の名前だけ（後ろの文は外す）", JSON.stringify(vi) === JSON.stringify(["パークハイツアイリス2号館"]), vi);
  t("内覧調整: 名前の無い候補日だけの文は付けない", aixPropertyNamesForLog({ aixType: "viewing_invite", text: "月曜日以降ですと\n10/13(月) 11:00〜18:30にてご案内可能です😊！！" }, {}).length === 0);
  t("物件送付: 売上サポの名前", aixPropertyNamesForLog({ aixType: "property_send", text: "ピックアップさせて頂きました", sentPropertyNames: ["A 101号室", "B 202号室"] }, {}).length === 2);
  t("戻す（AIX_SENT_NAMES=off）", aixPropertyNamesForLog({ aixType: "property_recommendation", text: "🌟A棟 101号室" }, { AIX_SENT_NAMES: "off" }).length === 0);
}

console.log("── ⑥ 台帳の2本柱（オススメした・お客様が送ってきた）＋食いつき・フリーレント");
{
  t("オススメの要旨", recommendGist("🌟YOURMAISON粉浜駅前 305号室\n\n（オススメポイント）\n・家賃68,000円・管理費5,000円\n・敷金なしのため初期費用を抑えてご入居頂けます！！\n・間取り：1LDK") === "家賃68,000円・管理費5,000円／敷金なしのため初期費用を抑えてご入居頂けます");
  const messages: PtMsg[] = [
    { sender: "customer", text: "[画像] 【物件の画面（ポータル）】\nグランメール弁天 0503号室\n7.3万円\n1LDK", created_at: "2026-10-01T03:00:00Z" },
    { sender: "staff", text: "確認させていただきました！！\nグランメール弁天 503号室現在募集中となります！！\nこちらフリーレント1ヶ月（家賃1ヶ月分免除）のお部屋となります！！", created_at: "2026-10-01T05:00:00Z", is_aix_generated: true },
    { sender: "staff", text: "🌟YOURMAISON粉浜駅前 305号室\n\n（オススメポイント）\n・敷金なしのため初期費用を抑えてご入居頂けます！！", created_at: "2026-10-03T05:00:00Z", is_aix_generated: true },
    { sender: "customer", text: "YOURMAISON粉浜駅前って内覧できますか", created_at: "2026-10-03T07:00:00Z" },
    { sender: "staff", text: "かしこまりました！！", created_at: "2026-10-03T07:10:00Z" },
    { sender: "customer", text: "前にオススメしてもらった物件ってまだ空いてますか？", created_at: "2026-10-06T07:00:00Z" },
  ];
  const s = resolvePropertyThreads({
    messages, imageLabels: new Map(),
    aix: [
      { created_at: "2026-10-01T05:00:01Z", aix_type: "property_check_result", property_names: ["グランメール弁天 503号室"], prop_statuses: ["available"] },
      { created_at: "2026-10-03T05:00:01Z", aix_type: "property_recommendation", property_names: ["YOURMAISON粉浜駅前 305号室"], generated_text: "🌟YOURMAISON粉浜駅前 305号室" },
    ],
    recommendations: [{ sent_at: "2026-10-03T05:00:00Z", star_name: "YOURMAISON粉浜駅前", star_room: "305", star_text: "🌟YOURMAISON粉浜駅前 305号室\n\n（オススメポイント）\n・敷金なしのため初期費用を抑えてご入居頂けます！！" }],
  });
  const ben = s.rooms.find((r) => /グランメール弁天/.test(r.ref.display));
  const kon = s.rooms.find((r) => /粉浜/.test(r.ref.display));
  t("★ お客様が送ってきた物件（画面の書き起こし）が1件の物件として残る（持ち込み）", !!ben && ben.origin === "customer" && ben.events.some((e) => e.kind === "customer_shared"), ben);
  t("★ 持ち込みと確認の結果が同じ物件にまとまる（0503 と 503）", s.rooms.filter((r) => /グランメール弁天/.test(r.ref.display)).length === 1 && !!ben?.events.some((e) => e.kind === "check_available"), s.rooms.map((r) => r.ref.display));
  t("★ フリーレントはスタッフの送付の文から物件ごとに", ben?.freeRent?.kind === "yes" && /フリーレント1ヶ月/.test(ben?.freeRent?.phrase ?? ""), ben?.freeRent);
  const recs = kon?.events.filter((e) => e.kind === "recommended") ?? [];
  t("★ オススメした出来事が1つ（控えと AIX が重ならない）・要旨つき", kon?.origin === "ours" && recs.length === 1 && /敷金なし/.test(recs[0].text ?? ""), kon?.events);
  t("★ 食いついた（内覧の質問）", kon?.hooked?.topic === "viewing", kon?.hooked);
  t("★ 名前の無い「前にオススメしてもらった物件」→ 一番新しいオススメ（推定）", s.turnTargets.length === 1 && /粉浜/.test(s.turnTargets[0].display) && s.turnTargets[0].by === "inferred", s.turnTargets);
  const note = buildPropertyThreadNote(s);
  t("★ 材料の文に出所・食いつき・オススメの要旨", /こちらがオススメした物件/.test(note) && /食いついた/.test(note) && /オススメした（🌟）（敷金なし/.test(note) && /グランメール弁天[\s\S]*持ち込み[\s\S]*フリーレント/.test(note), note);
  const u = resolvePropertyThreads({ messages: [
    { sender: "staff", text: "🌟プルス新北野 302号室\n・駅徒歩3分", created_at: "2026-10-01T01:00:00Z", is_aix_generated: true },
    { sender: "customer", text: "募集終了て言われた物件がSUUMOで即入居でありますが\nプルス新北野 3階\nhttps://suumo.jp/chintai/jnc_000000000000/?bc=100000000000\nby SUUMO", created_at: "2026-10-02T01:00:00Z" },
  ], imageLabels: new Map(), aix: [] });
  const pl = u.rooms.filter((r) => /プルス新北野/.test(r.ref.display));
  t("★ SUUMO の共有文＝お客様が送ってきた（元の URL を残す・知っている物件と同じ建物は1つに）", pl.length === 1 && pl[0].events.some((e) => e.kind === "customer_shared" && /suumo\.jp/.test(e.text ?? "")), u.rooms);
  const b2 = resolvePropertyThreads({ messages: [...messages.slice(0, 5), { sender: "customer", text: "最初に送った物件ってフリーレント付いてますか？", created_at: "2026-10-06T07:00:00Z" }], imageLabels: new Map(),
    aix: [{ created_at: "2026-10-01T05:00:01Z", aix_type: "property_check_result", property_names: ["グランメール弁天 503号室"], prop_statuses: ["available"] }] });
  t("★ 「最初に送った物件」＝お客様が送ってきた物件（推定）", b2.turnTargets.length === 1 && /グランメール弁天/.test(b2.turnTargets[0].display) && /お客様が送ってきた物件/.test(b2.turnTargets[0].why ?? ""), b2.turnTargets);
  const n2 = buildPropertyThreadNote(b2);
  t("★ その物件のフリーレント（スタッフの送付）が材料に出る", /▶ 今の番の物件: グランメール弁天[\s\S]*フリーレント: スタッフの送付「こちらフリーレント1ヶ月/.test(n2), n2);
  process.env.PROPERTY_THREAD_ORIGIN = "off";
  const off = resolvePropertyThreads({ messages, imageLabels: new Map(), aix: [], recommendations: [{ sent_at: "2026-10-03T05:00:00Z", star_name: "YOURMAISON粉浜駅前", star_room: "305", star_text: "" }] });
  delete process.env.PROPERTY_THREAD_ORIGIN;
  t("戻す（PROPERTY_THREAD_ORIGIN=off）: オススメ・持ち込みを足さない", !off.rooms.some((r) => r.events.some((e) => e.kind === "recommended")) && off.turnTargets.length === 0, off.rooms.map((r) => r.ref.display));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
