// 2026-10-13 竹内（未桜）「動画の URL が送られてきたけど、それが物件の URL で『レジュールアッシュ難波MINAMI』と把握できていない」
//   持ち込み（動画の URL・画像）の後の名前だけの発言を、持ち込みの物件の名前の候補として台帳（property-thread・customer-state）に結ぶ。
//   こちらの確認の約束の通に書いた物件名を【必ず】の行に残す。実物（会話 22b2511e・10/7〜10/9）の本文をそのまま使う。
// 実行: npx tsx app/lib/__tests__/customer-name-after-share.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { nameOnlyMessage, customerNamedAfterShare, customerPropertyOptionsForAix, customerNameAfterShareEnabled } from "../customer-property-names";
import { propertyNamePrefill, customerTurnOf } from "../aix-prefill";
import { resolvePropertyThreads, buildPropertyThreadNote, type PtMsg, type PtAix } from "../property-thread";
import { resolveCustomerState } from "../customer-state";
import { classifyStaffTextFacts, confirmPropertyNameOf } from "../action-ledger";
import { promiseEventRows, planPromiseCompletion } from "../promise-calendar";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

// ── 実物（未桜 22b2511e）──
const MSGS: PtMsg[] = [
  { sender: "customer", text: "https://vt.tiktok.com/ZSbVCMp8j/", created_at: "2026-10-07T03:49:14.691Z" },
  { sender: "customer", text: "こちらの物件の詳細希望です", created_at: "2026-10-07T03:49:50.477Z" },
  { sender: "staff", text: "未桜さんお世話になっております！！\nお送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😊！！", created_at: "2026-10-07T04:24:30.152Z" },
  { sender: "staff", text: "[画像]", image_url: "https://x/1.jpg", is_aix_generated: true, created_at: "2026-10-07T09:59:06.787Z" },
  { sender: "staff", text: "[画像]", image_url: "https://x/2.jpg", is_aix_generated: true, created_at: "2026-10-07T09:59:06.909Z" },
  { sender: "staff", text: "未桜さん確認させていただきました！！\nAlivis新町 802号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！\n\nお手隙の際にご査収ください！！", is_aix_generated: true, created_at: "2026-10-07T09:59:07.212Z" },
  { sender: "customer", text: "https://vt.tiktok.com/ZSbgmmfFJ/", created_at: "2026-10-08T05:14:54.771Z" },
  { sender: "customer", text: "ここはもう埋まっちゃてますか？", created_at: "2026-10-08T05:15:09.578Z" },
  { sender: "staff", text: "未桜さん\nお部屋お送りいただきありがとうございます！！\n\nお部屋について調べさせていただきましたが特定出来ませんでしたので、住所やマンション名などより詳しい情報頂けますと募集状況の確認可能となります😊！！", created_at: "2026-10-08T07:27:49.934Z" },
  { sender: "customer", text: "レジュールアッシュ難波MINAMIです🙇🏻‍♀️", created_at: "2026-10-09T03:12:55.207Z" },
];
const STAFF_REPLY = "未桜さんお世話になっております！！\n\nレジュールアッシュ難波MINAMIの件、かしこまりました！！\n募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！";
const AIX: PtAix[] = [{ created_at: "2026-10-07T09:59:10.243Z", aix_type: "property_check_result", property_names: ["Alivis新町 802号室"], prop_statuses: ["available"], estimate_sent: true }];

console.log("■ 名前だけの発言の見分け");
t("「レジュールアッシュ難波MINAMIです🙇🏻‍♀️」→ 名前", nameOnlyMessage("レジュールアッシュ難波MINAMIです🙇🏻‍♀️")?.name === "レジュールアッシュ難波MINAMI");
t("「メゾンボヌールの203です！」→ 名前＋号室", JSON.stringify(nameOnlyMessage("メゾンボヌールの203です！")) === JSON.stringify({ name: "メゾンボヌール", room: "203" }), nameOnlyMessage("メゾンボヌールの203です！"));
t("「セレニテ本町グラン 1203号室です」→ 名前＋号室", nameOnlyMessage("セレニテ本町グラン 1203号室です")?.room === "1203");
for (const s of ["梅田です", "ありがとうございます", "ここはもう埋まっちゃてますか？", "ギリギリにすみせん", "旦那の方からLINE来る", "クリエオーレの方は", "oosakahiro0717@gmail.com", "分かりました！", "オンラインでお願いします。", "インターネット無料がいいです"]) {
  t(`「${s}」→ 名前ではない`, nameOnlyMessage(s) === null, nameOnlyMessage(s));
}

console.log("■ 持ち込みの後の名前（customerNamedAfterShare）");
{
  const c = customerNamedAfterShare(MSGS.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })));
  t("未桜: TikTok の URL の後の名前が1件", c.length === 1 && c[0].name === "レジュールアッシュ難波MINAMI" && c[0].url === "https://vt.tiktok.com/ZSbgmmfFJ/", c);
  const off = customerNamedAfterShare(MSGS.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })), { env: { CUSTOMER_NAME_AFTER_SHARE: "off" } });
  t("CUSTOMER_NAME_AFTER_SHARE=off で止まる", off.length === 0);
  // 本人確認書類の画像の後の名前（申込の物件）は持ち込みにしない（60日の監査 394b4cbc）
  const id = customerNamedAfterShare([
    { sender: "customer", text: "[画像] 本人確認書類", createdAt: "2026-09-04T06:13:19Z" },
    { sender: "customer", text: "プレサンス難波リバーオアシスです", createdAt: "2026-09-04T06:47:01Z" },
  ]);
  t("本人確認書類の後の名前は結ばない", id.length === 0, id);
  // 72時間より後は結ばない
  const late = customerNamedAfterShare([
    { sender: "customer", text: "https://vt.tiktok.com/abc/", createdAt: "2026-10-01T00:00:00Z" },
    { sender: "customer", text: "レジュールアッシュ難波MINAMIです", createdAt: "2026-10-05T00:00:00Z" },
  ]);
  t("72時間より後は結ばない", late.length === 0);
  // 持ち込みが無い名前だけの発言は結ばない
  t("持ち込みの無い名前は結ばない", customerNamedAfterShare([{ sender: "customer", text: "レジュールアッシュ難波MINAMIです", createdAt: "2026-10-05T00:00:00Z" }]).length === 0);
}

console.log("■ 台帳（property-thread）: 今の番の物件＝持ち込みの名前");
{
  const s = resolvePropertyThreads({ messages: MSGS, imageLabels: new Map(), aix: AIX });
  const room = s.rooms.find((r) => r.ref.display.startsWith("レジュールアッシュ難波MINAMI"));
  t("レジュールアッシュ難波MINAMI が台帳の部屋になる（持ち込み）", !!room && room.origin === "customer", s.rooms.map((r) => [r.ref.display, r.origin]));
  t("今の番の物件（turnTargets）がレジュールアッシュ難波MINAMI だけ", s.turnTargets.length === 1 && s.turnTargets[0].display.startsWith("レジュールアッシュ難波MINAMI"), s.turnTargets);
  const note = buildPropertyThreadNote(s);
  t("台帳の文に ▶ 今の番の物件: レジュールアッシュ難波MINAMI", /▶ 今の番の物件: レジュールアッシュ難波MINAMI/.test(note), note);
  t("台帳の文に「名前を送ってきた（…持ち込み（URL）の続き）」", /名前を送ってきた（名前だけ・10\/8 14:14の持ち込み（URL）の続き）/.test(note), note);
  t("Alivis新町 は今の番の物件ではない（他の物件の行）", !/▶ 今の番の物件: Alivis/.test(note));
  // こちらの返信の後: 「〇〇の件…確認させて頂きます」は同じ部屋の「確認中と伝えた」
  const s2 = resolvePropertyThreads({ messages: [...MSGS, { sender: "staff", text: STAFF_REPLY, created_at: "2026-10-09T03:16:10.092Z" }], imageLabels: new Map(), aix: AIX });
  const r2 = s2.rooms.find((r) => r.ref.display.startsWith("レジュールアッシュ"));
  t("こちらの「〇〇の件…募集状況確認させて頂きます」が同じ部屋の確認中", !!r2?.events.some((e) => e.kind === "staff_checking"), r2?.events);
  const prevEnv = process.env.CUSTOMER_NAME_AFTER_SHARE;
  process.env.CUSTOMER_NAME_AFTER_SHARE = "off";
  const sOff = resolvePropertyThreads({ messages: MSGS, imageLabels: new Map(), aix: AIX });
  t("off で旧と同じ（部屋にならない）", !sOff.rooms.some((r) => r.ref.display.startsWith("レジュールアッシュ")));
  if (prevEnv === undefined) delete process.env.CUSTOMER_NAME_AFTER_SHARE; else process.env.CUSTOMER_NAME_AFTER_SHARE = prevEnv;
}

console.log("■ お客様の状況（customer-state）: 主のお部屋が持ち込みに移る");
{
  const msgs = [...MSGS, { sender: "staff", text: STAFF_REPLY, created_at: "2026-10-09T03:16:10.092Z" }]
    .map((m) => ({ sender: m.sender, text: m.text ?? null, createdAt: m.created_at, isAix: !!m.is_aix_generated }));
  const st = resolveCustomerState({ status: "proposing", messages: msgs, aixRows: AIX.map((a) => ({ ...a, sent_at: a.created_at, generated_text: null })), recordedFacts: [], viewingHistory: [], sentProperties: [], now: Date.parse("2026-10-09T03:20:00Z") });
  t("主のお部屋＝レジュールアッシュ難波MINAMI", (st.focusKey ?? "").startsWith(st.properties.find((p) => p.name.startsWith("レジュールアッシュ"))?.key ?? "×"), { focus: st.focusKey, headline: st.headline });
  t("状況の1行にレジュールアッシュ難波MINAMI（旧: 見積送付済み Alivis新町 802号室）", /レジュールアッシュ難波MINAMI/.test(st.headline) && !/^[^｜]*Alivis/.test(st.headline), st.headline);
}

console.log("■ 【必ず】の行に物件名");
{
  t("confirmPropertyNameOf: 「〇〇の件、かしこまりました…募集状況確認」", confirmPropertyNameOf(STAFF_REPLY) === "レジュールアッシュ難波MINAMI");
  t("confirmPropertyNameOf: 「お送り頂きましたＭｖ．ｆｍ大阪大正の募集状況」→ Mv.fm大阪大正", confirmPropertyNameOf("併せてお送り頂きましたＭｖ．ｆｍ大阪大正の募集状況確認させて頂きます！！") === "Mv.fm大阪大正");
  t("confirmPropertyNameOf: 名前の無い約束は null", confirmPropertyNameOf("未桜さんお世話になっております！！\nお送り頂きました物件の募集状況確認させて頂きます！！") === null);
  t("confirmPropertyNameOf: 「インターネットの件」は null", confirmPropertyNameOf("インターネットの件確認させて頂きます！！") === null);
  t("confirmPropertyNameOf: 駅＋間取り「森ノ宮1LDK3階」は null", confirmPropertyNameOf("お送り頂きました森ノ宮1LDK3階の募集状況確認させて頂きます！！") === null);
  t("confirmPropertyNameOf: 報告の文の名前は拾わない", confirmPropertyNameOf("エグゼ難波西Ⅱの募集状況確認させていただきましたが、既にご契約が決まったお部屋となります！！\n他お気に召されましたお部屋のご案内可否も確認させていただきます！！") === null);
  t("PROMISE_PROPERTY_NAME=off で null", confirmPropertyNameOf(STAFF_REPLY, { PROMISE_PROPERTY_NAME: "off" }) === null);
  const es = classifyStaffTextFacts(STAFF_REPLY, "2026-10-09T03:16:10.092Z");
  const rows = promiseEventRows(es, { customerName: "未桜", conversationId: "c", sentAt: "2026-10-09T03:16:10.092Z" });
  t("【必ず】募集状況の確認→ご連絡（レジュールアッシュ難波MINAMI）", rows[0]?.notes.split("\n")[0] === "【必ず】募集状況の確認→ご連絡（レジュールアッシュ難波MINAMI）", rows.map((r) => r.notes.split("\n")[0]));
  t("件名も「未桜 募集状況の確認→ご連絡（レジュールアッシュ難波MINAMI）」", rows[0]?.title === "未桜 募集状況の確認→ご連絡（レジュールアッシュ難波MINAMI）", rows[0]?.title);
  // 物件確認した（報告）・物件送付・御見積書で閉じる（物件名つきの行も要件の読み方は同じ）
  const open = [{ id: 1, event_type: "follow_up", notes: rows[0]?.notes ?? "", is_done: false }];
  t("確認結果の報告（募集状況）で閉じる", planPromiseCompletion([{ kind: "confirmation_reported", object: "募集状況" }], open).includes(1));
  t("御見積書の送付で閉じる", planPromiseCompletion([{ kind: "estimate_sent" }], open).includes(1));
  const cond = [{ id: 2, event_type: "follow_up", notes: "【必ず】入居時期の確認→ご連絡（レジュールアッシュ難波MINAMI）", is_done: false }];
  t("条件の確認（入居時期）は物件送付で閉じない（物件名つきでも要件を読む）", !planPromiseCompletion([{ kind: "properties_sent" }], cond).includes(2));
}


console.log("■ レビュー 2026-10-13: 物件でない語は名前にしない（持ち込みの後の1行）");
for (const w of ["TikTok", "インスタ", "SUUMO", "ホームズ", "アットホーム", "ユーチューブ", "ワンルーム", "1LDK", "オートロック", "ペット可", "ヤマダハナコ", "Yuma Takeuchi", "ヤマダ ハナコ", "オッケー", "ミナミ", "レオパレス"]) {
  for (const s of [w, `${w}です`]) t(`「${s}」→ 名前ではない`, nameOnlyMessage(s) === null, nameOnlyMessage(s));
}
t("実物の正解は今まで通り: レジュールアッシュ難波MINAMI", nameOnlyMessage("レジュールアッシュ難波MINAMIです🙇🏻‍♀️")?.name === "レジュールアッシュ難波MINAMI");
t("実物の正解は今まで通り: コンフォリアリブ博労町一丁目", nameOnlyMessage("コンフォリアリブ博労町一丁目")?.name === "コンフォリアリブ博労町一丁目", nameOnlyMessage("コンフォリアリブ博労町一丁目"));
t("実物の正解は今まで通り: メゾンボヌールの203", nameOnlyMessage("メゾンボヌールの203です！")?.name === "メゾンボヌール");
{
  const share = (s: string) => customerNamedAfterShare([
    { sender: "customer", text: "https://vt.tiktok.com/abc/", createdAt: "2026-10-01T00:00:00Z" },
    { sender: "customer", text: s, createdAt: "2026-10-01T01:00:00Z" },
  ]);
  t("持ち込みの後の「TikTokです」は結ばない", share("TikTokです").length === 0);
  t("持ち込みの後の「Yuma Takeuchi」は結ばない", share("Yuma Takeuchi").length === 0);
}

console.log("■ レビュー: 確認の約束の「AとB」・設備の語");
{
  const a = "YUYAさん\nお部屋お送りいただきありがとうございます！！\nクレアート新大阪パンルループとエスリード大阪シティノースの募集状況と初期費用確認させて頂きます！！";
  t("クレアート新大阪パンルループとエスリード大阪シティノース → 両方", confirmPropertyNameOf(a) === "クレアート新大阪パンルループ・エスリード大阪シティノース", confirmPropertyNameOf(a));
  const b = "お部屋お送りいただきありがとうございます😊！！\nRenuts新大阪の他のお部屋とハイツ西三国の募集状況確認させていただきます！！";
  t("Renuts新大阪の他のお部屋とハイツ西三国 → 両方", confirmPropertyNameOf(b) === "Renuts新大阪・ハイツ西三国", confirmPropertyNameOf(b));
  const c = "インターネットとハイツ西三国の空き状況確認させていただきます！！";
  t("インターネットとハイツ西三国 → 物件に見えない片方は落とす", confirmPropertyNameOf(c) === "ハイツ西三国", confirmPropertyNameOf(c));
  const d = "ご希望のお部屋とメゾンデリアンの募集状況確認させて頂きます！！";
  t("平仮名の語の「と」では分けない・名前だけ", confirmPropertyNameOf(d) === "メゾンデリアン", confirmPropertyNameOf(d));
}
for (const w of ["ロフト", "カーテン", "エレベーター", "セキュリティ", "ウォシュレット", "リフォーム", "オーナー様", "トランクルーム", "デザイナーズ", "ルームシェア", "インスタ"]) {
  const s = `${w}の件確認させて頂きます！！`;
  t(`「${w}の件」→ 物件名ではない`, confirmPropertyNameOf(s) === null, confirmPropertyNameOf(s));
}

console.log("■ レビュー: 画面（AIX）の戻すスイッチ");
{
  const msgs = MSGS.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, rawCreatedAt: m.created_at }));
  const on = customerPropertyOptionsForAix(msgs, {});
  const off = customerPropertyOptionsForAix(msgs, { CUSTOMER_NAME_AFTER_SHARE: "off" });
  t("on: 候補にレジュールアッシュ難波MINAMI", on.some((c) => c.name === "レジュールアッシュ難波MINAMI"), on);
  t("off: 候補に出ない（旧と同じ）", !off.some((c) => c.name === "レジュールアッシュ難波MINAMI"), off);
  t("画面の NEXT_PUBLIC_CUSTOMER_NAME_AFTER_SHARE=off も効く", !customerNameAfterShareEnabled({ NEXT_PUBLIC_CUSTOMER_NAME_AFTER_SHARE: "off" }));
  // namePrefill（AixModal と同じ組み立て）: お客様が送った物件の候補は値に使わない作り（aix-prefill 114行）＝ on/off で同じ
  const prefill = (opts: typeof on) => {
    const turn = customerTurnOf(msgs);
    const ts = Date.parse(turn[0]?.rawCreatedAt ?? "");
    return propertyNamePrefill({ pickupNames: [], customerSharedThisTurn: opts.filter((c) => c.at && Date.parse(c.at) >= ts).map((c) => c.name), staffSent: ["Alivis新町 802号室"], customerTurnText: turn.map((m) => m.text).join("\n") });
  };
  t("namePrefill は off で元と同じ値（on と同じ）", JSON.stringify(prefill(on)) === JSON.stringify(prefill(off)), [prefill(on), prefill(off)]);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
