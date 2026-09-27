// 2026-09-27 竹内「AIXにずれがないか確認するためにも実際のスタッフが送ったようになるように／AIXを活用しながらテスト進めていく」
//   app/lib/staff-send-pattern.ts: 送り方の分類・画面の AIX とブレインのズレ・スタッフ役の決め方・ピッカー・申込フォーマット・一言のテンプレ
// 実行: npx tsx app/lib/__tests__/staff-send-pattern.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyStaffTurn, brainSceneLabel, deterministicHit, readAixView, checkAfterReply, decideSimStaffTurn, secondAixMaterial,
  simPickerFor, pickerLogFields, pickerAixBody, parseAppFormatSections, buildAppFormatText,
  followupTemplateUsable, pickFollowupTemplate, fillFollowupTemplate, followupPropertyLabel, pickupsWithoutSendImage, summarizeViewMismatch,
  followupAllowed, simRowShape, REAL_SHAPE_RATE, REPLY_THEN_AIX_RATE, AIX_PAIR_RATE, FOLLOWUP_TEMPLATE_CATEGORY,
} from "../staff-send-pattern";
import { resolveAixButtonView, type AixViewMeta, type AixViewMessage } from "../aix-button-view";
import { sanitizePickerChoices } from "../aix-pickers";
import { AIX_FOLLOWUP_RATE } from "../customer-sim-shadow";
import type { SimAixMaterial, SimPickupSource } from "../customer-sim-material";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(c: unknown, m = "条件が偽") { if (!c) throw new Error(m); }

const T0 = Date.parse("2026-09-20T03:00:00Z");
const min = 60_000;

console.log("\n■ 送り方の分類（classifyStaffTurn）");
it("何も送っていない → none", () => eq(classifyStaffTurn([]).shape, "none"));
it("手打ちだけ → reply_only", () => eq(classifyStaffTurn([{ t: T0, isAix: false, aixType: null, text: "かしこまりました！！" }]).shape, "reply_only"));
it("返信を先に送ってから見積書送る（実物「エスライズの初期費用お願い致します。」の番）→ reply_then_aix・間を測る", () => {
  const c = classifyStaffTurn([
    { t: T0, isAix: false, aixType: null, text: "かしこまりました！！ エスライズ北堀江の最大限割引させて頂いた初期費用の御見積書お送りさせて頂きます😊！！" },
    { t: T0 + 13 * min, isAix: true, aixType: "estimate_sheet" },
  ]);
  eq(c.shape, "reply_then_aix"); eq(c.firstAix, "estimate_sheet"); eq(c.replyToAixMs, 13 * min);
});
it("見積書送るの後10分以内に一言（テンプレ「…御見積書となります！！…ご査収ください」）→ aix_then_line", () => {
  const c = classifyStaffTurn([
    { t: T0, isAix: true, aixType: "estimate_sheet" },
    { t: T0 + 2 * min, isAix: false, aixType: null, text: "きえさんお世話になっております！！ フェリスシエロ堺301号室最大限割引しました初期費用の御見積書となります！！" },
  ]);
  eq(c.shape, "aix_then_line"); ok(c.followup?.text?.includes("フェリスシエロ堺"));
});
it("AIX の後10分を過ぎた手打ちは一言に数えない → aix_only", () => {
  eq(classifyStaffTurn([{ t: T0, isAix: true, aixType: "viewing_invite" }, { t: T0 + 11 * min, isAix: false, aixType: null, text: "物件から川まで100m程の距離にございます！！" }]).shape, "aix_only");
});
it("物件ピックアップした→物件オススメ → aix_aix（種類の順を保つ）", () => {
  const c = classifyStaffTurn([{ t: T0, isAix: true, aixType: "property_send" }, { t: T0 + min, isAix: true, aixType: "property_recommendation" }, { t: T0 + 2 * min, isAix: false, aixType: null, text: "お送りさせて頂きましたお部屋の中でも特に…" }]);
  eq(c.shape, "aix_aix"); eq(c.aixTypes, ["property_send", "property_recommendation"]);
});
it("同じ種類の AIX を2回（画像と本文が別の行）は aix_aix にしない", () => {
  eq(classifyStaffTurn([{ t: T0, isAix: true, aixType: "property_send" }, { t: T0 + 1000, isAix: true, aixType: "property_send" }]).shape, "aix_only");
});
it("場面の見出し: AIX の判断は AIX:種類・action だけ（返信）は 点滅・無しは 返信", () => {
  eq(brainSceneLabel({ suggested_action: "estimate_sheet", suggested_reply_mode: "aix" }), "AIX:estimate_sheet");
  eq(brainSceneLabel({ suggested_action: "property_send", suggested_reply_mode: "draft" }), "返信（点滅 property_send）");
  eq(brainSceneLabel({ suggested_action: null, suggested_reply_mode: "draft" }), "返信");
});

console.log("\n■ 決定論の割合（deterministicHit）");
it("0 は一度も・1 は毎回", () => { ok(![1, 2, 3, 50].some((n) => deterministicHit(n, 0))); ok([1, 2, 3, 50].every((n) => deterministicHit(n, 1))); });
it("1〜1000 往復で当たる回数は割合 ±2%（18%・25%・75%）", () => {
  for (const r of [0.18, 0.25, 0.75]) {
    let h = 0; for (let n = 1; n <= 1000; n++) if (deterministicHit(n, r, "x")) h++;
    ok(Math.abs(h / 1000 - r) <= 0.02, `rate=${r} hit=${h}`);
  }
});
it("同じ番号・割合・salt なら毎回同じ（乱数でない）", () => { for (let n = 1; n < 30; n++) eq(deterministicHit(n, 0.14, "reply_then_aix:estimate_sheet"), deterministicHit(n, 0.14, "reply_then_aix:estimate_sheet")); });
it("短い往復（1〜12）でも 18% は 1〜3回当たる（テストの12往復で一度は返信→AIX が出る）", () => {
  let h = 0; for (let n = 1; n <= 12; n++) if (deterministicHit(n, REPLY_THEN_AIX_RATE.property_send.rate, "reply_then_aix:property_send")) h++;
  ok(h >= 1 && h <= 3, `hit=${h}`);
});

console.log("\n■ 画面の AIX とブレイン（readAixView・resolveAixButtonView をそのまま当てる）");
const custAt = "2026-09-27T05:00:00.000Z";
const msgs: AixViewMessage[] = [
  { sender: "staff", rawCreatedAt: "2026-09-27T04:50:00.000Z", isAix: true },
  { sender: "customer", rawCreatedAt: custAt },
];
const view = (meta: AixViewMeta | null, m: AixViewMessage[] = msgs) => resolveAixButtonView({ meta, messages: m });
it("ブレイン=見積書送る（aix・新しい）→ 画面は見積書の帯・ズレなし", () => {
  const meta = { action: "estimate_sheet", reply_mode: "aix", analyzed_msg_ts: custAt, note: "" };
  const r = readAixView(view(meta), meta);
  eq([r.shownAction, r.channel], ["estimate_sheet", "banner"]); eq(r.mismatches, []);
});
it("ブレイン=見積書送る だが判断が古い（前の発言を見た物）→ 画面に出ない＝brain_aix_not_shown", () => {
  const meta = { action: "estimate_sheet", reply_mode: "aix", analyzed_msg_ts: "2026-09-27T04:00:00.000Z" };
  eq(readAixView(view(meta), meta).mismatches.map((x) => x.kind), ["brain_aix_not_shown"]);
});
it("ブレインは返信（reply_mode=draft）なのに action=property_send → 画面は物件ピックアップの帯＝shown_brain_reply", () => {
  const meta = { action: "property_send", reply_mode: "draft", analyzed_msg_ts: custAt };
  const r = readAixView(view(meta), meta);
  eq(r.shownAction, "property_send"); eq(r.mismatches.map((x) => x.kind), ["shown_brain_reply"]);
});
it("2択（two_choice_mode）→ two_choice:<action> を外して押す AIX にする", () => {
  const meta = { action: "property_recommendation", reply_mode: "aix", analyzed_msg_ts: custAt, two_choice_mode: true };
  const r = readAixView(view(meta), meta);
  eq([r.shown, r.shownAction, r.channel], ["two_choice:property_recommendation", "property_recommendation", "two_choice"]);
});
it("返信を先に送ると判断は消える（送信で suggested_aix_meta=null）→ 押す AIX が画面に無い＝gone_after_reply", () => {
  const after = readAixView(view(null, [...msgs, { sender: "staff", rawCreatedAt: "2026-09-27T05:10:00.000Z" }]), null);
  eq(checkAfterReply("estimate_sheet", after)?.kind, "gone_after_reply");
  const still = readAixView(view({ action: "estimate_sheet", reply_mode: "aix", analyzed_msg_ts: custAt }), { action: "estimate_sheet", reply_mode: "aix" });
  eq(checkAfterReply("estimate_sheet", still), null);
});
it("ズレの要約は0件の種類も並べる", () => {
  const s = summarizeViewMismatch([{ viewMismatches: [{ kind: "shown_differs" }] }, { viewMismatches: null }]);
  eq(s.length, 5); eq(s.find((x) => x.kind === "shown_differs")?.count, 1);
});

console.log("\n■ スタッフ役の決め方（decideSimStaffTurn）");
const vr = (shownAction: string | null, channel: "banner" | "card" | "two_choice" | "pulse" | "none" = "banner") => ({ shown: shownAction, channel, shownAction, shownAlt: [] as string[], mismatches: [] });
it("画面に出ている AIX を押す（見積書送る）・一言は 84% → 添える", () => {
  const p = decideSimStaffTurn({ round: 1, meta: { action: "estimate_sheet", reply_mode: "aix" }, view: vr("estimate_sheet") });
  eq([p.pressAix, p.followup, p.secondAix], ["estimate_sheet", true, null]);
});
it("画面に AIX が無い → 返信（ブレインが AIX でも押さない＝ズレは readAixView が出す）", () => {
  const p = decideSimStaffTurn({ round: 1, meta: { action: "estimate_sheet", reply_mode: "aix" }, view: vr(null, "none") });
  eq(p.pressAix, null);
});
it("ブレインは返信なのに帯が出ている（property_send）→ 実送信 0/4 なので押さない", () => {
  const p = decideSimStaffTurn({ round: 1, meta: { action: "property_send", reply_mode: "draft" }, view: vr("property_send") });
  eq(p.pressAix, null); ok(p.reasons.some((r) => r.includes("押さない")));
});
it("物件ピックアップした → 続けて物件オススメ（75%）・一言はオススメの後（71%）", () => {
  const p = decideSimStaffTurn({ round: 1, meta: { action: "property_send", reply_mode: "aix" }, view: vr("property_send") });
  eq([p.pressAix, p.secondAix, p.followup], ["property_send", "property_recommendation", true]);
});
it("物件確認した → 2つ目なし・一言なし（18%）・check_pattern はブレインの物", () => {
  const p = decideSimStaffTurn({ round: 1, meta: { action: "property_check_result", reply_mode: "aix", check_pattern: "interior_photo" }, view: vr("property_check_result", "pulse") });
  eq([p.pressAix, p.secondAix, p.followup, p.checkPattern], ["property_check_result", null, false, "interior_photo"]);
});
it("返信→AIX は往復の番号で決まる（property_send 18%: 12往復で1〜3回）", () => {
  const hits = Array.from({ length: 12 }, (_, i) => decideSimStaffTurn({ round: i + 1, meta: { action: "property_send", reply_mode: "aix" }, view: vr("property_send") }).replyFirst).filter(Boolean).length;
  ok(hits >= 1 && hits <= 3, `hits=${hits}`);
});
it("表の中身: 返信→AIX の見積書 14%・組はピックアップ→オススメだけ・一言のカテゴリは3種", () => {
  eq(REPLY_THEN_AIX_RATE.estimate_sheet.rate, 0.14); eq(Object.keys(AIX_PAIR_RATE), ["property_send>property_recommendation"]);
  eq(Object.keys(FOLLOWUP_TEMPLATE_CATEGORY).sort(), Object.keys(AIX_FOLLOWUP_RATE).sort());
});
it("2つ目の材料: 今送ったピックアップの1件目（「お送りさせて頂きましたお部屋の中でも特に…」）", () => {
  const items = [{ id: 1, propertyName: "BRAVE新町", roomNo: "802" }, { id: 2, propertyName: "HandP平野", roomNo: null }] as unknown as SimPickupSource[];
  const m = secondAixMaterial({ kind: "pickups", items }, "property_recommendation");
  eq(m?.kind === "pickups" ? m.items.map((x) => x.id) : null, [1]);
  eq(secondAixMaterial({ kind: "pickups", items }, "estimate_sheet"), null);
});

console.log("\n■ ピッカー（simPickerFor・記録の形）");
it("申込へ: 「この物件で決めます。」→ 申込フォーマット（実送信 58/76）", () => eq(simPickerFor({ aixType: "application_push", turnText: "この物件で決めます。" })?.value, "format"));
it("申込へ: 「この物件審査通して欲しいです」→ 申込フォーマット", () => eq(simPickerFor({ aixType: "application_push", turnText: "この物件審査通して欲しいです" })?.value, "format"));
it("申込へ: 「少し考えてもいいですか？💦」→ 申込誘導（push）", () => eq(simPickerFor({ aixType: "application_push", turnText: "少し考えてもいいですか？💦" })?.value, "push"));
it("申込へ: 申込書を送った後の「免許証の写真送ります」→ 書類依頼・それ以外 → 申込確定", () => {
  const staff = ["【お申込者様記入欄】\n・入居希望日\n・氏名、フリガナ"];
  eq(simPickerFor({ aixType: "application_push", turnText: "免許証の写真送ります", recentStaffTexts: staff })?.value, "docs_request");
  eq(simPickerFor({ aixType: "application_push", turnText: "8月の末で大丈夫です！！ 入居日が！ よろしくお願いします。", recentStaffTexts: staff })?.value, "confirm");
});
it("物件ピックアップした: 送った後の「エリアこのままで家賃10〜11で2LDKで探せますか？」→ 条件広げまとめ", () => {
  eq(simPickerFor({ aixType: "property_send", turnText: "エリアこのままで家賃10〜11で2LDKで探せますか？", sentPropertyCount: 3 })?.value, "widen");
});
it("物件ピックアップした: 送った後の「ありがとうございます！」→ 新着まとめ・初めて → 初回まとめ", () => {
  eq(simPickerFor({ aixType: "property_send", turnText: "ありがとうございます！", sentPropertyCount: 3 })?.value, "new_arrival");
  eq(simPickerFor({ aixType: "property_send", turnText: "ありがとうございます！", sentPropertyCount: 0 })?.value, "normal");
});
it("物件ピックアップした: 物件なかった の後でも代替物件送り（実送信 3/344）にしない", () => {
  const v = simPickerFor({ aixType: "property_send", turnText: "お願いします😭🙇‍♂️", sentPropertyCount: 2, recentStaffTexts: ["エスライズ西本町につきまして募集状況確認させて頂きましたところ、現在募集終了しておりました"] })?.value;
  ok(v !== "alternative", String(v));
});
it("物件確認した: 「お部屋の写真ありますか？」→ 室内写真を確認した（pickerForScene のまま）", () => eq(simPickerFor({ aixType: "property_check_result", turnText: "お部屋の写真ありますか？" })?.value, "interior_photo"));
it("記録の形: 物件ピックアップ → send_mode の列・申込フォーマット → app_sub_mode の列＋子は picker_choices・見積書 → picker_choices", () => {
  eq(pickerLogFields("property_send", { field: "send_mode", value: "widen", label: "", reason: "" }), { check_pattern: null, send_mode: "widen", app_sub_mode: null, picker_choices: null });
  eq(pickerLogFields("application_push", { field: "app_sub_mode", value: "format", label: "", reason: "" }, { extraChoices: { living_type: "single", guarantor_kind: "emergency" } }),
    { check_pattern: null, send_mode: null, app_sub_mode: "format", picker_choices: { living_type: "single", guarantor_kind: "emergency" } });
  const est = pickerLogFields("estimate_sheet", { field: "estimate_count", value: "single", label: "", reason: "" });
  eq(est.picker_choices, { estimate_count: "single" });
});
it("記録の形はサーバーの整え（sanitizePickerChoices）で落ちない", () => {
  eq(sanitizePickerChoices("application_push", { living_type: "single", guarantor_kind: "emergency" }, { appSubMode: "format" }), { living_type: "single", guarantor_kind: "emergency" });
  eq(sanitizePickerChoices("estimate_sheet", { estimate_count: "single" }), { estimate_count: "single" });
  eq(sanitizePickerChoices("viewing_invite", { viewing_mode: "内覧日指定あり" }), { viewing_mode: "内覧日指定あり" });
});
it("AIX の生成に渡す欄: ピックアップ=send_mode・申込誘導=app_push_type simple・申込フォーマット=画面の固定文", () => {
  eq(pickerAixBody("property_send", { field: "send_mode", value: "new_arrival", label: "", reason: "" }).body, { send_mode: "new_arrival" });
  eq(pickerAixBody("application_push", { field: "app_sub_mode", value: "push", label: "", reason: "" }).body, { app_sub_mode: "push", app_push_type: "simple", vacancy_status: "vacant" });
  eq(pickerAixBody("application_push", { field: "app_sub_mode", value: "format", label: "", reason: "" }).screenOnly, "application_format");
  eq(pickerAixBody("property_recommendation", { field: "pickup_type", value: "新着1件", label: "", reason: "" }).body, { is_new_arrival: true });
});

console.log("\n■ 申込フォーマット（画面の AixModal の固定文をそのまま読む）");
it("AixModal.tsx から4つの欄を読める・緊急連絡先の単独は 申込者→緊急連絡先", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components", "AixModal.tsx"), "utf8");
  const sec = parseAppFormatSections(src);
  ok(sec, "読めない");
  const text = buildAppFormatText(sec!, { living: "single", guarantor: "emergency" });
  ok(text.startsWith("【お申込者様記入欄】")); ok(text.includes("【緊急連絡先欄】")); ok(!text.includes("【同居人記入欄】")); ok(!text.includes("【連帯保証人欄】"));
  ok(buildAppFormatText(sec!, { living: "shared", guarantor: "guarantor" }).includes("【同居人記入欄】"));
});
it("読めない本文 → null", () => eq(parseAppFormatSections("const X = 1;"), null));

console.log("\n■ AIX の後の一言（テンプレ）");
const T_EST = "アカウント名さんお世話になっております！！\nマンション名〇〇号室最大限割引しました初期費用の御見積書となります！！\nアカウント名さんお気に召されましたらお申込みしお部屋抑えさせて頂きます！！\nお手隙の際にご査収ください😌！！";
const T_REC = "お送りさせて頂きましたお部屋の中でも特に〇〇が築年数も新しく費用を抑える事ができ、アカウント名さんにかなりオススメ出来るお部屋となります！！\nアカウント名さんお気に召されたお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
const T_WAIT = "アカウント名さんお待たせ致しました！！\n〇月〇日ご入居の場合の御見積書となります！！";
it("使えないテンプレ: お待たせ・申込書本体・AI が生成・画像が要る", () => {
  ok(!followupTemplateUsable({ text: T_WAIT }));
  ok(!followupTemplateUsable({ text: "フォーマット 個人用\n【お申込者様記入欄】\n・入居希望日" }));
  ok(!followupTemplateUsable({ text: "AIが書類依頼メッセージを生成します" }));
  ok(!followupTemplateUsable({ text: T_EST, requires_image: true }));
  ok(followupTemplateUsable({ text: T_EST }));
});
it("バナーで一番選ばれたテンプレを選ぶ（見積書送る【申込誘導】13回）・お待たせのテンプレは選ばない", () => {
  const ts = [
    { id: "a04ebd3e", label: "【入居日指定】見積書送付", text: T_WAIT, category: "見積書送る【AIX】", sort_order: 0 },
    { id: "32a6ee3d", label: "【基本】見積書送付", text: "アカウント名さんお世話になっております！！\n〇〇マンション〇〇号室最大限割引しました初期費用の御見積書となります！！", category: "見積書送る【AIX】", sort_order: 1 },
    { id: "66de6ba7", label: "【申込誘導】", text: T_EST, category: "見積書送る【AIX】", sort_order: 2 },
  ];
  eq(pickFollowupTemplate(ts, { "66de6ba7": 13, a04ebd3e: 99 })?.id, "66de6ba7");
  eq(pickFollowupTemplate(ts, {})?.id, "32a6ee3d");
});
it("穴埋め（予備）: 見積書の一言 → 実送信と同じ形「きえさん…フェリスシエロ堺 301号室最大限割引しました…」", () => {
  const r = fillFollowupTemplate(T_EST, { customerName: "きえ", propertyLabel: "フェリスシエロ堺 301号室" });
  eq(r.text?.split("\n").slice(0, 2), ["きえさんお世話になっております！！", "フェリスシエロ堺 301号室最大限割引しました初期費用の御見積書となります！！"]);
});
it("穴埋め（予備）: 1件特にオススメ の〇〇に物件名", () => {
  ok(fillFollowupTemplate(T_REC, { customerName: "飛翔", propertyLabel: "HandP平野" }).text?.startsWith("お送りさせて頂きましたお部屋の中でも特にHandP平野が"));
});
it("穴埋め（予備）: 埋まらない伏せ字（◯月◯◯日退去）・お客様名が無い → 送らない", () => {
  eq(fillFollowupTemplate("〇〇が…◯月◯◯日退去の為◯月◯日以降ご内覧可能となります！！", { customerName: "m", propertyLabel: "BRAVE新町" }).text, null);
  eq(fillFollowupTemplate(T_EST, { customerName: "", propertyLabel: "X" }).text, null);
});
it("一言の物件名は材料から（号室は資料の文字のまま 0206）", () => {
  const est: SimAixMaterial = { kind: "estimate", recordId: 1, imageUrl: "u", propertyName: "ラグゼ難波", roomNo: "0206", initialCostYen: 1, discountYen: 0, savedText: null };
  eq(followupPropertyLabel(est), "ラグゼ難波 0206");
});

it("申込へ の一言は申込フォーマットの後だけ・見積書は選択を問わない", () => {
  eq(followupAllowed("application_push", "format").ok, true);
  eq(followupAllowed("application_push", "push").ok, false);
  eq(followupAllowed("estimate_sheet", null).ok, true);
});
it("お客様役の1往復の形（simRowShape）と実送信の割合の表は合計 1.0", () => {
  eq(simRowShape({ sent: "x", sentKind: "下書き" }), "reply_only");
  eq(simRowShape({ sent: "x", sentKind: "AIX estimate_sheet", followupText: "y" }), "aix_then_line");
  eq(simRowShape({ sent: "x", sentKind: "AIX estimate_sheet", replyFirstText: "r", followupText: "y" }), "reply_then_aix");
  eq(simRowShape({ sent: "x", sentKind: "AIX property_send", secondAixText: "z" }), "aix_aix");
  eq(simRowShape({ sent: null }), "none");
  ok(Math.abs(Object.values(REAL_SHAPE_RATE).reduce((a, b) => a + b, 0) - 1) < 0.011);
});

console.log("\n■ 送る画像（trim_image_url だけ）");
it("trim の無い送っていないピックアップを名前で返す（page_image_url があっても送らない）", () => {
  eq(pickupsWithoutSendImage([
    { property_name: "A", room_no: "101", trim_image_url: null },
    { property_name: "B", trim_image_url: "https://x/b.png" },
    { property_name: "C", trim_image_url: null, sent_at: "2026-09-27" },
    { property_name: "D", trim_image_url: null, status: "excluded" },
  ]), ["A 101"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
