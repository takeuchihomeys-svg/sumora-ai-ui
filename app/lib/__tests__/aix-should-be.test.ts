// 「本来の AIX」の当てはめ（app/lib/aix-should-be.ts）と見張りの採点 v8（line-watch-judge.applyAixMapping）
// 実行: npx tsx app/lib/__tests__/aix-should-be.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 材料は竹内さんの AIX の送信・手打ちの実物を伏せた物（scripts/audit-aix-should-be.ts で読んだ・2026-10-23）
import { shouldBeAixOf, shouldBeButtons, watchAixMappingEnabled } from "../aix-should-be";
import { judgeTurn, staffWindowOf, type StaffWindow } from "../line-watch-judge";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }
const key = (t: string, mode: "hand" | "aix" = "hand") => shouldBeAixOf(t, { mode })?.key ?? null;

console.log("当てはめ（竹内さんの AIX の送信）");
it("募集中＋御見積書の同封 → 物件確認した/物件あった（見積は同じ文の他の中身）", () => {
  const s = shouldBeAixOf("お待たせ致しました！！\n〇〇 〇〇号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！", { mode: "aix" });
  eq(s?.key, "property_check_result/available");
});
it("募集に出ていない → 物件なかった", () => eq(key("お送り頂きました物件につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！", "aix"), "property_check_result/unavailable"));
it("その部屋だけ募集中 → 別の部屋について確認した", () => eq(key("管理会社に確認させて頂きましたところ、現在102号室のみ募集中となり他のお部屋は募集されていない形となります！！", "aix"), "property_check_result/other_room_check"));
it("御見積書の金額 → 見積書送る", () => eq(key("【物件名】\n初期費用さらに\n🌟33,000円割引させて頂き\n初期費用：165,050円\nスモラなら一般的な不動産業者より134,520円節約出来ます！！", "aix"), "estimate_sheet/single"));
it("オススメポイントの1件（御見積書の同封つき）→ 物件オススメ（見積ではない）", () => eq(key("🌟〇〇 302号室\n（オススメポイント）\n・家賃53,000円・管理費6,000円\n・敷金礼金なし\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！", "aix"), "property_recommendation/新規ピックアップ"));
it("候補日 → 内覧日調整、確定と待ち合わせ → 待ち合わせ", () => {
  eq(key("お部屋のご内覧日ですが\n直近ですと\n7/25（土）14:00〜17:00\n7/27（月）13:00〜16:00\nご案内可能です！！\nご都合よろしいお日にちお決まりになりましたらお気軽にご連絡ください😌！！", "aix"), "viewing_invite/通常");
  eq(key("8/4 15:15に〇〇 現地エントランスお待ち合わせで何卒よろしくお願い致します😊！！", "aix"), "meeting_place");
});
it("申込フォーマット・書類のお願い・条件ヒアリング", () => {
  eq(key("【お申込者様記入欄】\n・入居希望日\n・氏名、フリガナ\n・生年月日", "aix"), "application_push/format");
  eq(key("ご入力いただきありがとうございます！！\n・本人確認書類（表面・裏面）\nお送りいただき次第お申込み完了させて頂きます！！", "aix"), "application_push/docs_request");
  eq(shouldBeAixOf("（〇〇さんご希望のお部屋探しご条件）\n①ご入居時期\n②ご希望家賃\n③ご希望間取り", { mode: "aix" })?.button, "condition_hearing");
});
it("物件の束（N件募集中でしたのでお送り）は物件ピックアップした（確認の結果ではない）", () => eq(shouldBeAixOf("お待たせ致しました！！ 南堀江周辺のエリア全域からオススメできるお部屋が4件募集中でしたのでお送りさせていただきました！！", { mode: "aix" })?.button, "property_send"));

console.log("当てはめ（手打ち）");
it("約束だけ（確認させて頂きます）は当てない＝返信", () => eq(key("かしこまりました！！ 管理会社に礼金の交渉と代表に仲介手数料の減額が可能か交渉させていただきます！！"), null));
it("確認の結果の報告（代理契約）→ 代理契約について", () => eq(key("〇〇に代理契約可能か確認させて頂きましたところ\n代理契約可能となります😊！！"), "property_check_result/mgmt_proxy"));
it("室内イメージの URL → 室内写真を確認した", () => eq(key("かしこまりました！！ 2部屋の室内イメージ添付させていただきます！！ https://example.com/a"), "property_check_result/interior_photo"));
it("はじめましての挨拶で物件を探す約束は全力サポートにしない", () => eq(key("はじめまして😊！！お部屋探しを担当させて頂きます〇〇と申します！！ 〇〇周辺全域からお部屋をピックアップしてお送りさせて頂きます😌！！ ご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます！！"), null));
it("ただの了承は当てない", () => eq(key("かしこまりました！！ 何卒よろしくお願い致します！！"), null));
it("shouldBeButtons は主と同じ文の他の中身のボタン", () => eq(shouldBeButtons(shouldBeAixOf("お待たせ致しました！！ 〇〇号室現在募集中となります！！ 最大限割引しました御見積書同封させて頂きました！！", { mode: "aix" })).sort(), ["estimate_sheet", "property_check_result"]));
it("スイッチ: 既定 on・off で止まる", () => { eq(watchAixMappingEnabled({}), true); eq(watchAixMappingEnabled({ LINE_WATCH_AIX_MAPPING: "off" }), false); });

console.log("見張りの採点 v8（本来の AIX）");
const t0 = Date.parse("2026-10-20T05:00:00.000Z");
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
const win = (texts: string[], presses: StaffWindow["presses"] = [], aixTexts: string[] = []): Pick<StaffWindow, "closed" | "texts" | "presses" | "aixMessages" | "aixMessagesBurst" | "aixTexts"> =>
  ({ closed: true, texts: texts.map((t) => ({ at: at(5), text: t, burst: true })), presses, aixMessages: aixTexts.length, aixMessagesBurst: aixTexts.length, aixTexts: aixTexts.map((t) => ({ at: at(5), text: t, burst: true })) });
const HAND_VIEW = "かしこまりました😊！！ 弊社直近ですと 本日18:00〜18:30 明日 12:00〜16:00 ご案内可能です！！ 〇〇さんご都合如何でしょうか😌！！";
it("AI は内覧日調整・スタッフは手打ちで候補日 → same（same_via_mapping・元は different）", () => {
  const j = judgeTurn({ draft: null, brainAction: "viewing_invite", brainReplyMode: "aix", hasBrain: true, window: win([HAND_VIEW]), aixMapping: true });
  eq([j.verdict, j.detail.reason, j.detail.raw_verdict, j.detail.raw_reason, j.detail.should_be?.via, j.detail.aix_verdict], ["same", "same_via_mapping", "different", "aix_but_text", "hand", "not_pressed"]);
});
it("当てはめ off（スイッチ off）は今まで通り", () => {
  const j = judgeTurn({ draft: null, brainAction: "viewing_invite", brainReplyMode: "aix", hasBrain: true, window: win([HAND_VIEW]) });
  eq([j.verdict, j.detail.reason, j.detail.should_be ?? null], ["different", "aix_but_text", null]);
});
it("本来の AIX がブレインと違う → 判定は変えない（should_be.match=false を残す）", () => {
  const j = judgeTurn({ draft: null, brainAction: "estimate_sheet", brainReplyMode: "aix", hasBrain: true, window: win([HAND_VIEW]), aixMapping: true });
  eq([j.verdict, j.detail.reason, j.detail.should_be?.match], ["different", "aix_but_text", false]);
});
it("押し間違い: 別の AIX を押したが AIX の文の中身はブレインの AIX → same（via mis_press）・aix_verdict は other のまま", () => {
  const sent = "お送り頂きましたお部屋の募集状況確認させて頂きましたところ、〇〇号室は現在募集中のお部屋となります！！";
  const j = judgeTurn({ draft: null, brainAction: "property_check_result", brainReplyMode: "aix", hasBrain: true, window: win([], [{ aix_type: "property_send", check_pattern: null, at: at(5), burst: true }], [sent]), aixMapping: true });
  eq([j.verdict, j.detail.reason, j.detail.raw_reason, j.detail.should_be?.via, j.detail.aix_verdict], ["same", "same_via_mapping", "aix_other", "mis_press", "other"]);
});
it("押した AIX を自分の文が裏付ける（物件の束の中の室内イメージ）→ 押し間違いにしない（変えない）", () => {
  const pick = "〇〇さんお世話になっております！！ 家賃13万円まで上げて頂いたので、御堂筋線梅田〜大国町周辺全域から1LDK〜2LDKで〇〇さんにオススメできるお部屋ピックアップさせて頂きました😊！！";
  const j = judgeTurn({ draft: null, brainAction: "property_check_result", brainReplyMode: "aix", hasBrain: true, window: win([], [{ aix_type: "property_send", check_pattern: null, at: at(5), burst: true }], [pick, "（室内イメージ）\n（URL）"]), aixMapping: true });
  eq([j.verdict, j.detail.reason], ["different", "aix_other"]);
});
it("押し間違いの根拠に手打ちの文は使わない（費用を押して手打ちで内覧の誘い）", () => {
  const est = "【物件名】 初期費用さらに 🌟134,875円割引させて頂き 初期費用：170,480円 スモラなら一般的な不動産業者より316,145円節約出来ます！！";
  const j = judgeTurn({ draft: null, brainAction: "viewing_invite", brainReplyMode: "aix", hasBrain: true, window: win([HAND_VIEW], [{ aix_type: "estimate_sheet", check_pattern: null, at: at(5), burst: true }], [est]), aixMapping: true });
  eq([j.verdict, j.detail.reason], ["different", "aix_other"]);
});
it("同じ文に添えた弱い中身（also）では一致にしない", () => {
  const t = "お待たせ致しました！！管理会社様に確認させて頂きましたところ、〇〇号室は現在募集中となります！！ 新着でご希望のお部屋が出次第すぐにお送りさせて頂きます！！";
  const j = judgeTurn({ draft: null, brainAction: "zenryoku_support", brainReplyMode: "aix", hasBrain: true, window: win([t]), aixMapping: true });
  eq(j.detail.reason === "same_via_mapping", false);
});
it("AI は返信の番は当てはめない", () => {
  const j = judgeTurn({ draft: "かしこまりました！！", brainAction: "", brainReplyMode: "auto_reply", hasBrain: true, window: win([HAND_VIEW]), aixMapping: true });
  eq(j.detail.reason === "same_via_mapping", false);
});
it("staffWindowOf は AIX の文の本文を aixTexts に残す", () => {
  const w = staffWindowOf({ customerTurnAt: at(0), nowMs: t0 + 3 * 86_400_000, msgs: [{ sender: "customer", created_at: at(0), text: "空いてますか" }, { sender: "staff", created_at: at(5), text: "現在募集中となります！！", is_aix_generated: true }] });
  eq([w.aixMessages, w.aixTexts?.[0]?.text, w.aixTexts?.[0]?.burst], [1, "現在募集中となります！！", true]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
