// 2026-10-13 P1 0593a0aa（未桜）: 画面の物件名（状況の1行の主のお部屋・AIX の物件名の候補・【必ず】の物件名）をブレインの今の物件にそろえる。
// 実行: npx tsx app/lib/__tests__/brain-property-display.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCustomerState, isBrainPickFresh, brainFocusRoom, type CustomerStateInput } from "../customer-state";
import { withBrainPropertyFirst, resolvePromisePropertyName, applyBrainToPromiseEntries, brainPickFromMetas, brainPropertyDisplayEnabled } from "../brain-property-display";
import { promiseEventRows } from "../promise-calendar";
import { classifyStaffTextFacts } from "../action-ledger";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

// ── 実物（未桜 22b2511e・10/7〜10/9）──
const MIOU: CustomerStateInput["messages"] = [
  { sender: "customer", text: "https://vt.tiktok.com/ZSbVCMp8j/", createdAt: "2026-10-07T03:49:14.691Z" },
  { sender: "customer", text: "こちらの物件の詳細希望です", createdAt: "2026-10-07T03:49:50.477Z" },
  { sender: "staff", text: "未桜さんお世話になっております！！\nお送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😊！！", createdAt: "2026-10-07T04:24:30.152Z" },
  { sender: "staff", text: "未桜さん確認させていただきました！！\nAlivis新町 802号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！", isAix: true, createdAt: "2026-10-07T09:59:07.212Z" },
  { sender: "customer", text: "https://vt.tiktok.com/ZSbgmmfFJ/", createdAt: "2026-10-08T05:14:54.771Z" },
  { sender: "customer", text: "ここはもう埋まっちゃてますか？", createdAt: "2026-10-08T05:15:09.578Z" },
  { sender: "staff", text: "未桜さん\nお部屋について調べさせていただきましたが特定出来ませんでしたので、住所やマンション名などより詳しい情報頂けますと募集状況の確認可能となります😊！！", createdAt: "2026-10-08T07:27:49.934Z" },
  { sender: "customer", text: "レジュールアッシュ難波MINAMIです🙇🏻‍♀️", createdAt: "2026-10-09T03:12:55.207Z" },
];
const MIOU_AIX = [{ created_at: "2026-10-07T09:59:10.243Z", sent_at: "2026-10-07T09:59:10.243Z", aix_type: "property_check_result", property_names: ["Alivis新町 802号室"], prop_statuses: ["available"], estimate_sent: true, generated_text: null }];
const BRAIN_MIOU = { name: "レジュールアッシュ難波MINAMI", analyzedMsgTs: "2026-10-09T03:12:55.207+00:00" };
const NOW = Date.parse("2026-10-09T03:20:00Z");

console.log("■ 新しさ");
t("判断した発言＝最新の発言 → 新しい", isBrainPickFresh(BRAIN_MIOU, "2026-10-09T03:12:55.207Z"));
t("判断の後にお客様の発言 → 古い", !isBrainPickFresh(BRAIN_MIOU, "2026-10-09T05:00:00Z"));
t("判断の時刻が無い → 古い", !isBrainPickFresh({ analyzedMsgTs: null }, "2026-10-09T03:00:00Z"));

console.log("■ 状況の1行（resolveCustomerState・brainProperty）");
{
  // 未桜の実物（10/9 03:20）: 規則（38ec54d3 の後）もレジュールアッシュ。ブレインの判断で主にした事（出所 brain）を確かめる。
  //   規則とブレインが違う時に上書きする事は、下の「ブレイン＝Alivis」で確かめる
  const base: CustomerStateInput = { status: "proposing", messages: MIOU, aixRows: MIOU_AIX, recordedFacts: [], viewingHistory: [], sentProperties: [], now: NOW };
  const st = resolveCustomerState({ ...base, brainProperty: BRAIN_MIOU });
  t("未桜: 1行にレジュールアッシュ難波MINAMI", /レジュールアッシュ難波MINAMI/.test(st.headline) && !/^[^｜]*Alivis/.test(st.headline), st.headline);
  t("未桜: 主のお部屋の出所＝brain", st.focusSource === "brain", st.focusSource);
  // ブレインが Alivis（台帳にある別の部屋）を言った時は Alivis が主
  const alv = resolveCustomerState({ ...base, brainProperty: { name: "Alivis新町 802号室", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs } });
  t("ブレイン＝Alivis新町 802号室 → 主は Alivis", /Alivis新町 802号室/.test(alv.headline) && alv.focusSource === "brain", alv.headline);
  // 古い判断（判断の後にお客様が話した）は使わない
  const stale = resolveCustomerState({ ...base, messages: [...MIOU, { sender: "customer", text: "よろしくお願いします", createdAt: "2026-10-09T03:15:00Z" }], brainProperty: { name: "Alivis新町 802号室", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs } });
  t("古い判断は使わない（規則のまま）", stale.focusSource === "rule" && /レジュールアッシュ/.test(stale.headline), { s: stale.focusSource, h: stale.headline });
  // 台帳に無い名前は主にしない（新しい部屋は作らない）
  const none = resolveCustomerState({ ...base, brainProperty: { name: "エスリード難波セントラル", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs } });
  t("台帳に無い名前は主にしない・部屋を作らない", none.focusSource === "rule" && !none.properties.some((p) => /エスリード難波セントラル/.test(p.name)), { h: none.headline });
  // 渡さない（ブレインの入力の経路）＝今まで通り
  const plain = resolveCustomerState(base);
  t("brainProperty を渡さない時は規則のまま（出所 rule）", plain.focusSource === "rule" && plain.headline === none.headline, plain.headline);
  // 似ているだけは寄せない
  const maybe = brainFocusRoom(st.properties, { name: "レジュールアッシュ難波", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs });
  t("似ているだけ（略称）は寄せない", maybe === null, maybe?.name);
}
{
  // 内覧予定の部屋は記録で決まる相手（安全の線）→ ブレインが別の部屋でも主は内覧の部屋・食い違いを info に
  const msgs: CustomerStateInput["messages"] = [
    { sender: "staff", text: "【ジュネスニッコー 1003号室】御見積書お送りさせて頂きます！！", createdAt: "2026-09-20T03:00:00Z" },
    { sender: "customer", text: "セレニテ本町グランの方も気になります", createdAt: "2026-09-25T03:00:00Z" },
  ];
  const st = resolveCustomerState({
    status: "viewing", messages: msgs, aixRows: [], recordedFacts: [], sentProperties: [{ property_name: "セレニテ本町グラン", room_no: "1203", sent_at: "2026-09-21T03:00:00Z" }, { property_name: "ジュネスニッコー", room_no: "1003", sent_at: "2026-09-19T03:00:00Z" }],
    viewingHistory: [{ scheduled_date: "2026-09-28", scheduled_time: "14:00", status: "scheduled", property_name: "ジュネスニッコー 1003号室", created_at: "2026-09-22T03:00:00Z" }],
    now: Date.parse("2026-09-25T04:00:00Z"),
    brainProperty: { name: "セレニテ本町グラン 1203号室", analyzedMsgTs: "2026-09-25T03:00:00Z" },
  });
  t("内覧予定の部屋は主のまま", /ジュネスニッコー/.test(st.headline) && st.focusSource === "rule", st.headline);
  t("ブレインとの違いは info の食い違い", st.conflicts.some((c) => c.code === "BRAIN_PROPERTY_DIFFERS" && c.severity === "info"), st.conflicts);
  t("info の食い違いは ⚠ずれ を出さない", !/⚠ずれ/.test(st.headline), st.headline);
}

console.log("■ 輪を作らない（ブレインの入力の経路は brainProperty を渡さない）");
{
  const root = join(__dirname, "..", "..", "..");
  const core = readFileSync(join(root, "app/lib/brain-core.ts"), "utf8");
  const calls = core.match(/getCustomerState\([^)]*\)/g) ?? [];
  t("brain-core の getCustomerState は会話 id だけ", calls.length > 0 && calls.every((c) => /^getCustomerState\(conversationId\)$/.test(c)), calls);
  const server = readFileSync(join(root, "app/lib/customer-state-server.ts"), "utf8");
  t("brainProperty の既定は使わない（opts.brainProperty が true の時だけ）", /const withBrain = !!opts\.brainProperty/.test(server));
  const route = readFileSync(join(root, "app/api/customer-state/route.ts"), "utf8");
  t("画面の経路（/api/customer-state）だけが brainProperty: true", /getCustomerState\(conversationId, \{ brainProperty: true \}\)/.test(route));
  // ほかに brainProperty: true を渡している所が無い
  for (const f of ["app/api/generate-reply/route.ts", "app/lib/estimate-handoff-server.ts", "app/lib/procedure-answer-server.ts", "app/lib/deal-outcome-server.ts", "app/lib/viewing-morning-greeting-server.ts"]) {
    t(`${f} は brainProperty を渡さない`, !/brainProperty/.test(readFileSync(join(root, f), "utf8")));
  }
}

console.log("■ AIX の物件名の候補（withBrainPropertyFirst）");
{
  const opts = [
    { name: "プルス新北野", label: "プルス新北野 3階", url: "https://suumo.jp/a", at: "2026-10-08T00:00:00Z" },
    { name: "レジュールアッシュ難波MINAMI", label: "レジュールアッシュ難波MINAMI", url: "https://vt.tiktok.com/x/", at: "2026-10-09T03:12:55.207Z" },
  ];
  const latestCustomerAt = "2026-10-09T03:12:55.207Z";
  const r = withBrainPropertyFirst(opts, BRAIN_MIOU, { latestCustomerAt, env: {} });
  t("候補にある物件は一番上に移す（印あり・表記はそのまま）", r[0].name === "レジュールアッシュ難波MINAMI" && r[0].fromBrain === true && r[0].url === "https://vt.tiktok.com/x/" && r.length === 2, r);
  const add = withBrainPropertyFirst(opts, { name: "Mv.fm大阪大正 405号室", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs }, { latestCustomerAt, env: {} });
  t("無い物件は一番上に足す（at は null＝お客様の送付時刻を出さない・今回の連投の共有に数えない）", add[0].name === "Mv.fm大阪大正 405号室" && add[0].at === null && add.length === 3, add[0]);
  t("古い判断は候補のまま", withBrainPropertyFirst(opts, BRAIN_MIOU, { latestCustomerAt: "2026-10-09T05:00:00Z", env: {} })[0].name === "プルス新北野");
  t("ブレインが物件を決めていない（null）時は候補のまま", withBrainPropertyFirst(opts, { name: null, analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs }, { latestCustomerAt, env: {} })[0].name === "プルス新北野");
  t("NEXT_PUBLIC_BRAIN_PROPERTY_DISPLAY=off で候補のまま", withBrainPropertyFirst(opts, BRAIN_MIOU, { latestCustomerAt, env: { NEXT_PUBLIC_BRAIN_PROPERTY_DISPLAY: "off" } })[0].name === "プルス新北野");
  t("BRAIN_PROPERTY_DISPLAY=off で止まる", !brainPropertyDisplayEnabled({ BRAIN_PROPERTY_DISPLAY: "off" }) && brainPropertyDisplayEnabled({}));
  const aix = readFileSync(join(__dirname, "..", "..", "components", "AixModal.tsx"), "utf8");
  t("先入れ（namePrefill）はブレインを足す前の候補を使う", /const sharedThisTurn = customerPropertyBaseOptions/.test(aix));
}

console.log("■ 【必ず】の物件名（resolvePromisePropertyName）");
{
  const latestCustomerAt = "2026-10-09T03:12:55.207Z";
  const o = { latestCustomerAt, env: {} };
  t("本文に名前が無い → ブレイン", JSON.stringify(resolvePromisePropertyName(null, BRAIN_MIOU, o)) === JSON.stringify({ name: "レジュールアッシュ難波MINAMI", textName: null, source: "brain" }));
  t("本文「A・B」にブレインの1件が入る → 本文のまま", resolvePromisePropertyName("クレアート新大阪パンルループ・レジュールアッシュ難波MINAMI", BRAIN_MIOU, o).name === "クレアート新大阪パンルループ・レジュールアッシュ難波MINAMI");
  t("本文の名前が号室付きでも同じ建物なら本文のまま", resolvePromisePropertyName("レジュールアッシュ難波MINAMI 302号室", BRAIN_MIOU, o).source === "text");
  const diff = resolvePromisePropertyName("Alivis新町", BRAIN_MIOU, o);
  t("食い違う → ブレインを先・本文の名前を残す", diff.name === "レジュールアッシュ難波MINAMI" && diff.textName === "Alivis新町" && diff.source === "brain", diff);
  t("表記ゆれ（ラヴィータ西梅田／西橘田 603）は本文のまま", resolvePromisePropertyName("ラヴィータ西梅田603号室", { name: "ラヴィータ西橘田603号室", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs }, o).source === "text");
  t("ブレインの「A・B」の片方が本文と同じ → 本文のまま", resolvePromisePropertyName("ハイツ西三国", { name: "Renatus新大阪 2階/3階・ハイツ西三国 2階", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs }, o).source === "text");
  t("何件もの約束（お送り頂きました5件）は名前なしのまま", resolvePromisePropertyName(null, BRAIN_MIOU, { ...o, promiseText: "お送り頂きました5件、募集状況確認させて頂きます！！" }).name === null);
  t("「確認出来次第まとめてご連絡」も名前なしのまま", resolvePromisePropertyName(null, BRAIN_MIOU, { ...o, promiseText: "お送り頂きました物件の募集状況確認させて頂きます！！確認出来次第まとめてご連絡させて頂きます！！" }).name === null);
  t("本文に別の物件名らしい語（アービングNeo岸里玉出の駐車場）→ 名前なしのまま", resolvePromisePropertyName(null, { name: "堀江サン・ユー 501号室", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs }, { ...o, promiseText: "アービングNeo岸里玉出の駐車場の詳細につきまして明日管理会社に確認させて頂き、確認出来次第ご連絡させて頂きます！！" }).name === null);
  t("本文の語がブレインの物件の一部（ヴィレ堺湊の管理会社）→ ブレイン", resolvePromisePropertyName(null, { name: "ヴィレ堺湊 102号室", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs }, { ...o, promiseText: "ヴィレ堺湊の管理会社にご連絡させていただきましたが、本日お休みとなっており確認が出来ませんでしたので明日確認出来次第ご連絡させていただきます！！" }).name === "ヴィレ堺湊 102号室");
  t("設備の語（エアコンの件）は別の物件名にしない → ブレイン", resolvePromisePropertyName(null, { name: "カーサピエント 203号室", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs }, { ...o, promiseText: "はい😊！！\nエアコンの件、明日確認してご連絡させて頂きます😌！！" }).name === "カーサピエント 203号室");
  t("画面の仮の名前（物件no.92）は使わない", resolvePromisePropertyName(null, { name: "物件no.92", analyzedMsgTs: BRAIN_MIOU.analyzedMsgTs }, o).name === null);
  t("古い判断 → 本文のまま", resolvePromisePropertyName("Alivis新町", BRAIN_MIOU, { latestCustomerAt: "2026-10-09T09:00:00Z", env: {} }).name === "Alivis新町");
  t("off → 本文のまま", resolvePromisePropertyName(null, BRAIN_MIOU, { latestCustomerAt, env: { BRAIN_PROPERTY_DISPLAY: "off" } }).name === null);
  // 実物の本文（10/7 の約束「お送り頂きました物件の募集状況確認」＝名前なし）→ 行に物件名
  const sentAt = "2026-10-09T03:30:00Z";
  const entries = classifyStaffTextFacts("未桜さんお世話になっております！！\nお送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😊！！", sentAt);
  const withBrain = applyBrainToPromiseEntries(entries, BRAIN_MIOU, o);
  const rows = promiseEventRows(withBrain, { customerName: "未桜", conversationId: "c", sentAt });
  const row = rows.find((r) => r.event_type === "follow_up");
  t("名前の無い約束の【必ず】にブレインの物件名", !!row && /（レジュールアッシュ難波MINAMI）/.test(row.notes.split("\n")[0]), rows.map((r) => r.notes.split("\n")[0]));
  const rows2 = promiseEventRows(applyBrainToPromiseEntries(classifyStaffTextFacts("Alivis新町の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", sentAt), BRAIN_MIOU, o), { customerName: "未桜", conversationId: "c", sentAt });
  const r2 = rows2.find((r) => r.event_type === "follow_up");
  t("食い違う時は notes に「本文の名前: Alivis新町」", !!r2 && /（レジュールアッシュ難波MINAMI）/.test(r2.notes) && /本文の名前: Alivis新町/.test(r2.notes), r2?.notes);
  t("sent_facts の記録（元の entries）は本文のまま", !entries.some((e) => (e.detail as { textPropertyName?: string }).textPropertyName));
}

console.log("■ suggested_aix_meta / last_brain_meta から取る（brainPickFromMetas）");
{
  const a = { current_property: "Alivis新町 802号室", analyzed_msg_ts: "2026-10-07T03:49:50.477Z" };
  const b = { current_property: "レジュールアッシュ難波MINAMI", analyzed_msg_ts: "2026-10-09T03:12:55.207Z" };
  t("新しい方の判断", brainPickFromMetas(a, b)?.name === "レジュールアッシュ難波MINAMI" && brainPickFromMetas(b, a)?.name === "レジュールアッシュ難波MINAMI");
  t("新しい判断の null は古い判断の物件に戻さない", brainPickFromMetas(a, { current_property: null, analyzed_msg_ts: "2026-10-09T03:12:55.207Z" })?.name === null);
  t("判断の時刻が無いもの（生成の控え）は使わない", brainPickFromMetas({ current_property: "x" }, null) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
