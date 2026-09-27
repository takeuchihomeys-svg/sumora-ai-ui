// 2026-09-27: お客様の発言から物件確認のタスク（line_tasks property_check）を作る線（app/lib/property-check-task.ts）
//   決まり: 物件確認はお客様から依頼があった時だけ（memory feedback_property_check_on_request・判定は customerRequestedPropertyCheck）。
//   お客様の発言は scripts/audit-property-check-task.ts（本番120日）で次にスタッフが何を送ったかと並べて読んだ実物（名前は伏せた）。
// 実行: npx tsx app/lib/__tests__/property-check-task.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { detectTaskTypeByKeywords, decideAutoTask, isViewingWishOnlyTurn, isEstimateAskForOurRoomTurn } from "../property-check-task";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

type M = { sender: string; text: string };
const hist = (...m: M[]) => m;
// こちらが見積書を送った後（YUMA のお客様役 9/27・内覧の希望だけ）
const AFTER_ESTIMATE: M[] = [
  { sender: "staff", text: "【エステムコート大阪WEST 406号室】\n\n初期費用さらに\n🌟124,050円割引させて頂き\n初期費用：137,980円" },
];

console.log("\n■ 語の一覧（候補）は旧と同じ");
it("内覧・見学・物件確認・空室確認の語は物件確認の候補／物件を探しての語は物件出し／自分で送る予告は何も作らない", () => {
  eq(detectTaskTypeByKeywords("内覧したいです"), "property_check");
  eq(detectTaskTypeByKeywords("空室確認お願いします"), "property_check");
  eq(detectTaskTypeByKeywords("この物件確認してください"), "property_check");
  eq(detectTaskTypeByKeywords("他にも物件探してほしいです"), "property_send");
  eq(detectTaskTypeByKeywords("何件か気になる物件送ってもいいですか？"), null);
  eq(detectTaskTypeByKeywords("ありがとうございます"), null);
});

console.log("\n■ 物件確認はお客様からの依頼の時だけ（customerRequestedPropertyCheck と同じ判定）");
it("見積書の後の「内覧もお願いしたいです」だけ（物件を指していない）→ 作らない（次は AIX【内覧へ】の場面）", () => {
  const text = "見積もりありがとうございます！内容を確認して、内覧もお願いしたいです。今週の土曜か日曜で可能でしょうか？";
  eq(decideAutoTask(text, [...AFTER_ESTIMATE, { sender: "customer", text }]), null);
});
it("「内覧したいです」だけ（9b9b81ba 9/14・次は内覧へ）→ 作らない", () => {
  eq(decideAutoTask("内覧したいです", hist({ sender: "staff", text: "お送りさせて頂きました！" }, { sender: "customer", text: "内覧したいです" })), null);
});
it("持ち込みの画像と同じ連投の「こちらの物件も内覧したいですー」→ 作る（持ち込み物件）", () => {
  const text = "こちらの物件も内覧したいですー";
  eq(decideAutoTask(text, hist({ sender: "customer", text: "[画像]" }, { sender: "customer", text })), "property_check");
});

console.log("\n■ 内覧の希望だけでは作らない（2026-09-27 竹内「内覧したいといわれたら内覧日調整となる／AIXの内覧調整」）");
it("YUMA 9/27: 見積書の後の「こちらのお部屋、ぜひ内覧したい…日程はいつ頃空いていますか？」→ 作らない（御礼の「見積もり」・枠の「空いて」は依頼に数えない）", () => {
  const text = "見積もりありがとうございます！思ったより安くて嬉しいです😊 こちらのお部屋、ぜひ内覧したいのですが日程はいつ頃空いていますか？";
  const h = hist({ sender: "customer", text: "エステムコート大阪WESTの初期費用っていくらくらいになりますか？" }, ...AFTER_ESTIMATE, { sender: "customer", text });
  eq(isViewingWishOnlyTurn(h), true);
  eq(decideAutoTask(text, h), null);
});
it("5045ccd6 6/06: 募集中と答えたお部屋の内覧の日の変更＋「こちらの物件も内覧したいですー」（画像なし）→ 作らない", () => {
  const h = hist(
    { sender: "customer", text: "こちらまだ空いてますか？" },
    { sender: "staff", text: "お世話になっております！！ エステイトE森ノ宮の201号室ですが、現在もまだ募集中です！！ 6月末退居予定のお部屋となりますので、7月1日以降のご内覧が可能となります！！" },
    { sender: "customer", text: "お世話になっております！ 本日の内覧なのですが16時からに変更していただきたいですm(_ _)m" },
    { sender: "customer", text: "こちらの物件も内覧したいですー" },
  );
  eq(decideAutoTask("こちらの物件も内覧したいですー", h), null);
});
it("b0314a3d 8/23: こちらが送ったお部屋に「ここも内覧したいそうです！」→ 作らない", () => {
  const h = hist(
    { sender: "staff", text: "お待たせいたしました！！ 本日ご内覧可能な洋室広めのオススメできるお部屋フォレ長堀南605号室の1部屋となります！！ （室内イメージ） https://example.com/x" },
    { sender: "customer", text: "駅近はもうないですよね？😭" },
    { sender: "customer", text: "ここも内覧したいそうです！" },
  );
  eq(decideAutoTask("ここも内覧したいそうです！", h), null);
});
it("内覧の希望と一緒に空きを聞いた（2c434b28「空室あれば内覧」）→ 内覧の希望だけではない／こちらが送ったお部屋への「初期費用しりたい」（ad97cd40）→ 作らない（見積書送るの場面）", () => {
  eq(isViewingWishOnlyTurn(hist({ sender: "customer", text: "空室あるか確認お願いできますか？🙇‍♀️ 空室あれば内覧したいと思ってます！" })), false);
  const h = hist({ sender: "staff", text: "🌟アービングNeo岸里玉出 302号室 新着でかなり条件のいいお部屋となります！！ https://example.com/a" },
    { sender: "customer", text: "こちら初期費用しりたいです！ 駐車場ありますか？" }, { sender: "customer", text: "あした18時から内覧お願いしたいです" });
  eq(isViewingWishOnlyTurn(h), false);
  eq(decideAutoTask("あした18時から内覧お願いしたいです", h), null);
});
it("「まだ空いてますか」は枠でなく募集の質問 → 内覧の希望だけに数えない", () => {
  eq(isViewingWishOnlyTurn(hist({ sender: "customer", text: "この部屋まだ空いてますか？内覧したいです" })), false);
});
it("お客様が物件の URL を送って空きと内覧を聞いた（110b3053 9/02）→ 作る", () => {
  const text = "ここはいくらになりますか内覧は可能ですか？ 【賃貸マンション】 南海高野線 我孫子前駅 徒歩9分 https://www.homes.co.jp/chintai/room/xxxx/";
  eq(decideAutoTask(text, hist({ sender: "customer", text })), "property_check");
});
it("空室の確認の依頼（2c434b28 9/09「空室あるか確認お願いできますか？ 空室あれば内覧したい」・物件の画像の後）→ 作る", () => {
  const text = "空室あるか確認お願いできますか？🙇‍♀️ 空室あれば内覧したいと思ってます！";
  eq(decideAutoTask(text, hist({ sender: "customer", text: "[画像]" }, { sender: "customer", text })), "property_check");
});
it("物件出しの候補はそのまま（物件確認の判定は通さない）", () => {
  eq(decideAutoTask("他にも物件探してほしいです", hist({ sender: "customer", text: "他にも物件探してほしいです" })), "property_send");
});
it("直前の会話が読めない時は語だけ（旧の動き）。ただし内覧の希望だけの文は作らない", () => {
  eq(decideAutoTask("空室確認お願いします", []), "property_check");
  eq(decideAutoTask("内覧したいです", []), null);
  eq(decideAutoTask("内覧したいです", null), null);
});

console.log("\n■ こちらが送ったお部屋への費用・見積もりの依頼では作らない（2026-09-27 竹内「初期費用しりたいはAIXの初期費用おくるから見積書おくってる」）");
const OUR_ROOM: M = { sender: "staff", text: "🌟アービングNeo岸里玉出 302号室 新着でかなり条件のいいお部屋となります！！ https://example.com/a" };
it("ad97cd40 9/22: こちらが URL で送ったお部屋に「こちら初期費用しりたいです！」→ 見積書の場面（作らない）", () => {
  eq(isEstimateAskForOurRoomTurn(hist(OUR_ROOM, { sender: "customer", text: "こちら初期費用しりたいです！" })), true);
});
it("こちらが送ったお部屋に「このお部屋いくらですか？」「見積もりお願いします」→ 作らない", () => {
  const t1 = "このお部屋の初期費用いくらですか？";
  eq(decideAutoTask(t1, hist(OUR_ROOM, { sender: "customer", text: t1 })), null);
  eq(isEstimateAskForOurRoomTurn(hist(OUR_ROOM, { sender: "customer", text: "こちらの物件の見積もりお願いしたいです！" })), true);
});
it("お客様が持ち込んだ物件（画像）の費用の質問 → 今まで通り作る（まず募集状況の確認）", () => {
  const t = "この物件の初期費用しりたいです";
  const h = hist(OUR_ROOM, { sender: "customer", text: "[画像]" }, { sender: "customer", text: t });
  eq(isEstimateAskForOurRoomTurn(h), false);
  // 語の一覧の候補（「初期費用確認」）に当たる文でも、持ち込みなら今まで通り作る
  const t2 = "この物件の初期費用確認お願いしたいです";
  eq(decideAutoTask(t2, hist(OUR_ROOM, { sender: "customer", text: "[画像]" }, { sender: "customer", text: t2 })), "property_check");
});
it("前の番でお客様が画像を送り、こちらは「確認させて頂きます」だけ → 持ち込み物件のまま（作る側）", () => {
  const h = hist({ sender: "customer", text: "[画像]" }, { sender: "staff", text: "〇〇さん 202号室確認させて頂きます！！" }, { sender: "customer", text: "このお部屋の初期費用も知りたいです" });
  eq(isEstimateAskForOurRoomTurn(h), false);
});
it("持ち込み物件でも、こちらが募集中と答えた後の費用の依頼 → 結果を伝えたお部屋（作らない）", () => {
  const h = hist({ sender: "customer", text: "[画像]" }, { sender: "staff", text: "確認させて頂きましたところ202号室現在募集中となります！！" }, { sender: "customer", text: "このお部屋の初期費用も知りたいです" });
  eq(isEstimateAskForOurRoomTurn(h), true);
});
it("費用と一緒に空き・別のお部屋を聞いた → 作る側（物件確認した＋同封／物件出しの場面）", () => {
  eq(isEstimateAskForOurRoomTurn(hist(OUR_ROOM, { sender: "customer", text: "このお部屋まだ空いてますか？初期費用いくらですか？" })), false);
  eq(isEstimateAskForOurRoomTurn(hist(OUR_ROOM, { sender: "customer", text: "このお部屋の初期費用知りたいです。他の物件も探してほしいです" })), false);
});
it("お部屋の出所が無い（何も送っていない）→ 当てない", () => {
  eq(isEstimateAskForOurRoomTurn(hist({ sender: "staff", text: "よろしくお願いします！！" }, { sender: "customer", text: "このお部屋の初期費用しりたいです" })), false);
});
it("見積書へのお礼（「見積もりありがとうございます」）は依頼に数えない", () => {
  eq(isEstimateAskForOurRoomTurn(hist(OUR_ROOM, { sender: "customer", text: "見積もりありがとうございます！" })), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
