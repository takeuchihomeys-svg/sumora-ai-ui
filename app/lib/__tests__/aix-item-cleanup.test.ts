// 2026-09-27 竹内「その方向でおねがい」: AIX要対応の片付け（返信の本文で済み・お客様が止まったらブレインが取り下げ）
// 本文は本番の実送信そのまま（scripts/audit-aix-item-cleanup.ts で読んだ物）。
// 実行: npx tsx app/lib/__tests__/aix-item-cleanup.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { staffTextFulfillsAixItem, brainPausedCustomer } from "../aix-item-cleanup";
import { buildAixActionList, type AixActionItemRow } from "../aix-action-text";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const done = (action: string, text: string) => staffTextFulfillsAixItem({ action }, text).done;
function expectDone(action: string, text: string) { if (!done(action, text)) throw new Error(`済みのはずが済みでない: [${action}]「${text.slice(0, 50)}」`); }
function expectNot(action: string, text: string) { if (done(action, text)) throw new Error(`済みにしてはいけない: [${action}]「${text.slice(0, 50)}」`); }

console.log("■ 1. 返信の本文で済み（AIX要対応の押さなかった番の実送信）");
it("物件確認した: 契約済みの報告（𝓡 9/26）", () => expectDone("property_check_result", "エグゼ難波西Ⅱの募集状況確認させていただきましたが、既にご契約が決まったお部屋となります！！ 他お気に召されましたお部屋のご案内可否も確認させていただきます！！ お気軽にお知らせください"));
it("物件確認した: 入居可能日の回答（未桜 9/18）", () => expectDone("property_check_result", "はい！！ 最短で11月中旬から下旬でのご入居可能となります！！ 退去予定のお部屋となりますのでお気に召されましたらお申込みさせていただきます😊！！ お手隙の際にご確認下さい！！"));
it("物件確認した: 条件の回答（紗季 9/23）", () => expectDone("property_check_result", "アモーレ本町ウエスト管理会社に確認させていただきましたが、洋室にはエアコンの設置ができないお部屋とのことです！！"));
it("確認します: 専任の報告（S 9/24）", () => expectDone("acknowledge_check", "お部屋お送りいただきありがとうございます😊！！ お送りいただきました IBC Residence Westは専任のお部屋となっており弊社でご紹介出来ないお部屋となります。"));
it("確認します: 手打ちの「確認させていただきます」（𝑛𝑎 9/22）", () => expectDone("acknowledge_check", "Hinaさん 本日はお時間頂きありがとうございました！！ 花園の駐車場の件、管理会社に確認させていただきます！！ 空き状況確認出来次第ご連絡させていただきます😊！！"));
it("見積書送る: 手送り（𝑛𝑎 9/21）", () => expectDone("estimate_sheet", "Hinaさん 2件とも最大限割引しました初期費用の御見積書となります😊！！ お手隙の際にご査収ください！！"));
it("待ち合わせ場所: 場所つきの案内（まりあ 9/20）", () => expectDone("meeting_place", "明日16:00にRISING Maison 本町橋 現地エントランスお待ち合わせで何卒よろしくお願い致します😌！！ 住所: 大阪府大阪市中央区本町橋8-1"));
it("待ち合わせ場所: 電話の時刻を受けた（yasuki 9/14）", () => expectDone("meeting_place", "かしこまりました！！ 17:30からお電話お待ちしております！！"));
it("待ち合わせ場所: 当日の時刻の確認（yasuki 9/15）", () => expectDone("meeting_place", "yasukiさんお世話になっております！！ 本日11:00.よりお部屋ご案内させて頂きます！ 本日は何卒よろしくお願い致します！！"));
it("内覧日調整: 候補の日時を本文で出した（隼斗 9/25）", () => expectDone("viewing_invite", "かしこまりました！！ 9/28日（月曜）、9/29日（火曜）どちらも18:00からご案内可能ですがご都合いかがでしょうか！！"));
it("内覧日調整: お客様の日にちを受けた（🐥 9/13）", () => expectDone("viewing_invite", "かしこまりました！！ 18日こちらのお部屋もご案内させて頂きます😊！！ 何卒よろしくお願い致します！！"));
it("申込へ: 申込完了（Aoi 9/13）", () => expectDone("application_push", "かしこまりました！！ 1008号室お申込完了させて頂きます！！"));
it("申込へ: 並行して審査（愛乃 9/12）", () => expectDone("application_push", "かしこまりました！！ 並行して審査かけさせて頂きます😌！！"));

console.log("■ 1'. 押した番の実送信（済みにしたら誤り＝押すべき AIX を消す）");
it("物件確認した: 空いている報告の後に資料を送った（YUYA 9/22）", () => expectNot("property_check_result", "YUYAさん お世話になっております！！ 大変な時期にご連絡失礼いたしました。 Renatus新大阪 306号室、407号室にお申し込みが入り現在205号室の1部屋のみ募集中となります！！"));
it("物件確認した: 確認の約束だけ（楓馬 9/13）", () => expectNot("property_check_result", "楓馬さんお世話になっております！！ お送り頂きました物件の募集状況確認させて頂きます！！ 確認出来次第ご連絡させて頂きます！！"));
it("見積書送る: 見積書の約束だけ（H 9/16）", () => expectNot("estimate_sheet", "かしこまりました！！ ジーメゾン石津町東プリシエの最大限割引させていただいたお見積書お送りさせていただきます😌！！"));
it("待ち合わせ場所: 明日の時刻だけ→1分後に AIX で場所（🧸🤎 7/23）", () => expectNot("meeting_place", "かしこまりました！！ 明日15:00よりご案内させて頂きます😊！！ 3件の管理費値下げ交渉も並行して進めておりますので、結果が出次第ご連絡させて頂きます！！ 何卒よろしくお願い致します😌！！"));
it("待ち合わせ場所: 場所は追ってご連絡（𝒻ₗₒ𝓌ₑᵣ 9/18）", () => expectNot("meeting_place", "かしこまりました！！ 9/24日13:00からはよろしくお願いいたします😊！！ 芝犬の飼育可能か含め待ち合わせ場所追ってご連絡させていただきます！！"));
it("内覧日調整: 日時の無い「ご案内可能です」（H!tom!.M 8/18）", () => expectNot("viewing_invite", "昨日お送りいただいた グランエクラ大今里南Ⅱ 501号室 プリムール新深江1104号室 ソレイユ吹田102号室 の3部屋ご案内可能です😊！！"));
it("内覧日調整: その日は出来ない＋別の日を尋ねる（r 9/11）", () => expectNot("viewing_invite", "13日は終日予定が入っておりますのでご案内出来ないお日にちとなります！！ 上記日程以外ですと、月曜日以降でご都合よろしいお日にちはございますでしょうか😊！！"));
it("内覧日調整: 日にちの無い「ご都合よろしいお日にちに」（愛乃 9/6）", () => expectNot("viewing_invite", "はい！！愛乃さんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！"));
it("内覧日調整: 条件付き「内覧開始しましたら」（𝚂𝚊𝚗𝚊 8/11）", () => expectNot("viewing_invite", "M’s Ring Grande 春日出北は建設中で10/1日よりご入居可能なお部屋となりますので、内覧開始しましたらお部屋ご案内させて頂きます！！"));
it("申込へ: 「審査かけさせて頂きます」の後に申込の書式（♥︎ 9/4）", () => expectNot("application_push", "かしこまりました！！ 審査かけさせて頂きます😌！！ 保証会社が被っていますと同時に審査をかける事ができない形となります！！"));
it("申込へ: 「2番手でお申込みさせて頂きます」の後に申込の書式（西岡 7/13）", () => expectNot("application_push", "かしこまりました！！ アーバン西九条201号室、2番手でお申込みさせて頂きます！！"));
it("申込へ: 「お申込させて頂きます」の後に申込の書式（Aoi 9/12）", () => expectNot("application_push", "かしこまりました！！お申込させて頂きます！！"));
it("申込へ: 条件付き「お送り頂けましたらお申込み完了」（和樹 9/26）", () => expectNot("application_push", "お送りいただきありがとうございます！！ 村越さんの身分証明書表裏のお写真もお送りいただけましたらお申込み完了させていただきます！！"));
it("物件ピックアップ: 手打ちの物件の説明の後に AIX（ﾓﾓｶ 9/23）＝本文では済みにしない", () => expectNot("property_send", "お送りさせて頂きましたお部屋の中でも特にRiora塚本II 302が敷金礼金無しで費用を抑える事ができ、独立洗面台も備わったモモカさんにかなりオススメ出来るお部屋となります！！"));
it("物件オススメ: 本文では済みにしない", () => expectNot("property_recommendation", "新着でかなりオススメ出来るお部屋が募集に出ました！！ お手隙の際にご査収ください😌！！"));
it("画像だけの送信は見ない", () => expectNot("estimate_sheet", "[画像]"));

console.log("■ 2. ブレインの取り下げ（brainPausedCustomer）");
it("補いの AIX＋保留（m◡̈⃝e「確認してまたご連絡」）→ 取り下げ", () => {
  const r = brainPausedCustomer({ action: "property_send", decision_source: "signal:property_send", hesitancy_pattern: "callback", customer_intent: "chat" });
  if (!r.paused) throw new Error("取り下げのはず");
});
it("補いの AIX＋否定（あっぴ「パスでお願いします」）→ 取り下げ", () => {
  if (!brainPausedCustomer({ action: "property_recommendation", decision_source: "signal:property_recommendation", hesitancy_pattern: null, customer_intent: "negative" }).paused) throw new Error("取り下げのはず");
});
it("場面の信号＋保留（🐥「インフルで内覧厳しい」）→ 取り下げ", () => {
  if (!brainPausedCustomer({ action: "viewing_invite", decision_source: "signal:scene_S4_date_alt", hesitancy_pattern: "callback", customer_intent: "consultation" }).paused) throw new Error("取り下げのはず");
});
it("ブレイン自身が AIX を選んだ保留（慶次「他にあれば送っておいて」llm）→ 取り下げない", () => {
  if (brainPausedCustomer({ action: "property_send", decision_source: "llm", hesitancy_pattern: "waiting", customer_intent: "desire" }).paused) throw new Error("取り下げてはいけない");
});
it("未履行のピックアップ宣言（signal:pending_pickup）→ 取り下げない", () => {
  if (brainPausedCustomer({ action: "property_send", decision_source: "signal:pending_pickup", hesitancy_pattern: "thinking" }).paused) throw new Error("取り下げてはいけない");
});
it("締めの後のお礼（rule:closed_ack_wait）→ 取り下げない（竹内さんの決まり）", () => {
  if (brainPausedCustomer({ action: "property_send", decision_source: "rule:closed_ack_wait", hesitancy_pattern: "thinking" }).paused) throw new Error("取り下げてはいけない");
});
it("補いの AIX でも保留・否定でない（はる 申込の書式を送ってきた）→ 取り下げない", () => {
  if (brainPausedCustomer({ action: "application_push", decision_source: "signal:application_push", hesitancy_pattern: null, customer_intent: "decision" }).paused) throw new Error("取り下げてはいけない");
});
it("初回の条件受領・cached は見ない", () => {
  if (brainPausedCustomer({ action: "", first_contact_pickup: "property_send", decision_source: "signal:property_send", hesitancy_pattern: "thinking" }).paused) throw new Error("初回");
  if (brainPausedCustomer({ action: "property_send", source: "cached", decision_source: "signal:property_send", hesitancy_pattern: "thinking" }).paused) throw new Error("cached");
});

console.log("■ 3. グループの一覧（返信で済んだ物は ✅ に「（返信で済み）」）");
it("一覧: done_by=staff_text は（返信で済み）・AIX は今まで通り", () => {
  const NOW = Date.UTC(2026, 8, 27, 5, 30);
  const row = (o: Partial<AixActionItemRow>): AixActionItemRow => ({ id: "x", conversation_id: "c", customer_name: "あ", action: "property_check_result", check_pattern: null, status: "done", done_aix_type: null, done_at: "2026-09-27T04:00:00Z", created_at: "2026-09-27T01:00:00Z", ...o });
  const text = buildAixActionList([row({ customer_name: "𝓡", done_by: "staff_text" }), row({ customer_name: "Aoi", action: "estimate_sheet", done_aix_type: "estimate_sheet", done_by: "aix" })], NOW) ?? "";
  if (!text.includes("✅𝓡さん → AIX【物件確認した（募集状況）】（返信で済み）")) throw new Error(text);
  if (!text.includes("✅Aoiさん → AIX【見積書送る】") || text.includes("Aoiさん → AIX【見積書送る】（返信で済み）")) throw new Error(text);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(" - " + f)); process.exit(1); }
