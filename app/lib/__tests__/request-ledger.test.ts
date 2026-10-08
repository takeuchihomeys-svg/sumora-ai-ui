// 2026-10-08 連投の「やる事の一覧」（request-ledger.ts）。お客様の発言は実物（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/request-ledger.test.ts
import { splitRequests, buildRequestLedger, currentTurnRequests, buildRequestLedgerNote, uncoveredRequests, type LedgerMsg } from "../request-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 200))} to contain ${JSON.stringify(sub)}`); }
const T = "2026-10-05T10:00:00.000Z";
const topics = (b: string[]) => splitRequests(b, T).map((x) => x.topic);
const at = (min: number) => new Date(Date.parse(T) + min * 60_000).toISOString();

console.log("一覧（実物の連投）");
it("W51「かしこまりました。日時調整します。初期費用いくらになりますでしょつか？」→ 費用1件（了承・自分の行動は項目にしない）", () => eq(topics(["かしこまりました。\n日時調整します。\n初期費用いくらになりますでしょつか？"]), ["cost"]));
it("W23「カードブラックなので…厳しいかと💦」＋URL 3件 → 審査の懸念＋持ち込みの物件（2件）", () =>
  eq(topics(["カードブラックなので…厳しいかと💦", "https://www.homes.co.jp/chintai/room/a/", "https://www.homes.co.jp/chintai/room/b/", "https://www.homes.co.jp/chintai/room/c/"]), ["screening", "vacancy"]));
it("288d47「コンフォリアがいいと思うのですが見積もり出してもらえますか？ あと海外にいて収入証明がないのですが、しんさとおりますか？」→ 費用＋審査", () =>
  eq(topics(["コンフォリアがいいと思うのですが見積もり出してもらえますか？\nあと海外にいて収入証明がないのですが、しんさとおりますか？"]).sort(), ["cost", "screening"]));
it("969f01「ここと、」「ここの頭金おしえてほしいです」→ 費用1件", () => eq(topics(["ここと、", "ここの頭金おしえてほしいです"]), ["cost"]));
it("4a79a4 保証会社の質問＋広めの物件の依頼 → 契約条件＋探す", () =>
  eq(topics(["ありがとうございます！\nちなみにわたしが選んだ物件で、保証会社が被ってるところってどこか教えてもらうことは可能ですか？\nあと考えてたのが、結構広めな家が良くって、範囲を広げて恵美須町あたりならそういう物件あったりしますか？"]), ["contract", "pickup"]));
it("3d9b67 3物件の初期費用＋ほかの物件＋内見の日 → 費用・探す・内覧", () =>
  eq(topics(["シティハイツ〇〇、\nメゾン〇〇、\nサンコーハイツ、\n上記の初期費用も教えてほしいんです、お願いします。\n平野区加美駅付近以外で大阪市内で〇〇のような初期費用が抑えれる物件があったら教えてほしいです。\n間に合えば内見予定の9/9に行きたいです。"]), ["cost", "pickup", "viewing"]));
it("お礼・締めだけは項目なし", () => eq(topics(["ありがとうございます！", "よろしくお願いします🙇"]), []));
it("条件のフォーム・申込の書類は読まない", () => eq(topics(["①【ご入居の時期】⇒11月\n②【ご希望の家賃】⇒8万？"]), []));

console.log("状態（その後のこちらの送信）");
const conv = (rows: Array<[string, string, number, boolean?]>): LedgerMsg[] => rows.map(([sender, text, min, isAix]) => ({ sender, text, createdAt: at(min), isAix: !!isAix }));
it("W51: 下書きが日時だけ→費用は未対応／見積書の AIX で完了", () => {
  const c = conv([["customer", "かしこまりました。\n日時調整します。\n初期費用いくらになりますでしょつか？", 0], ["staff", "かしこまりました！！\nご内覧のご都合よろしいお日にちが決まり次第、ご連絡頂けますと幸いです！！", 5]]);
  eq(buildRequestLedger(c, Date.parse(at(10))).map((x) => x.status), ["open"]);
  const c2 = [...c, ...conv([["staff", "ゆいとさんお待たせ致しました！！\nカーサ〇〇 102号室最大限割引しました初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！", 120, true]])];
  const l = buildRequestLedger(c2, Date.parse(at(130)));
  eq(l.map((x) => x.status), ["done"]); eq(l[0].doneBy, "AIX");
});
it("約束の返信 → promised → AIX の結果で done", () => {
  const c = conv([["customer", "ここの頭金おしえてほしいです", 0], ["staff", "かしこまりました！！\n2部屋の最大限割引させていただいたお見積書お送りさせていただきます😊！！", 5]]);
  eq(buildRequestLedger(c, Date.parse(at(10)))[0].status, "promised");
  const c2 = [...c, ...conv([["staff", "最大限割引しました初期費用の御見積書となります！！", 60, true]])];
  eq(buildRequestLedger(c2, Date.parse(at(70)))[0].status, "done");
});
it("確認事項が複数（空き＋駐車場＋ペット）は1つずつ別の行・答えた物だけ完了", () => {
  const c = conv([["customer", "ここまだ空いてますか？\n駐車場ありますか？\nペット飼えますか？", 0], ["staff", "駐車場は敷地内に空き1台ございます！！\n募集状況とペットの可否は管理会社に確認させて頂きます！！", 5]]);
  const l = buildRequestLedger(c, Date.parse(at(10)));
  eq(l.map((x) => `${x.topic}:${x.status}`), ["vacancy:promised", "equipment:done", "equipment:promised"].map((s) => s) as never);
});
it("14日より前の束は一覧に入れない", () => {
  const c = conv([["customer", "初期費用いくらですか？", 0]]);
  eq(buildRequestLedger(c, Date.parse(at(15 * 24 * 60))).length, 0);
});

console.log("注記・出口の確かめ");
it("今の束が2件以上の時だけ一覧を出し、前の未対応も出す", () => {
  const c = conv([["customer", "初期費用いくらですか？", 0], ["staff", "かしこまりました！！", 5], ["customer", "カードブラックなので…厳しいかと💦\nここ駐車場ありますか？", 60]]);
  const n = buildRequestLedgerNote(buildRequestLedger(c, Date.parse(at(61))), currentTurnRequests(c));
  has(n, "依頼の一覧（今回の連投・2件"); has(n, "まだ答えていない確認事項"); has(n, "初期費用いくらですか");
});
it("1件だけ・前の未対応なし → 注記なし", () => {
  const c = conv([["customer", "初期費用いくらですか？", 0]]);
  eq(buildRequestLedgerNote(buildRequestLedger(c, Date.parse(at(1))), currentTurnRequests(c)), "");
});
it("REQUEST_LEDGER=off で注記なし", () => {
  const c = conv([["customer", "カードブラックなので厳しいかと\nここ駐車場ありますか？", 0]]);
  eq(buildRequestLedgerNote(buildRequestLedger(c, Date.parse(at(1))), currentTurnRequests(c), { env: { REQUEST_LEDGER: "off" } }), "");
});
it("出口: W51 の下書き（日時だけ）は費用が抜け／見積の約束が入れば抜けなし", () => {
  const cur = splitRequests(["かしこまりました。\n日時調整します。\n初期費用いくらになりますでしょつか？"], T);
  eq(uncoveredRequests(cur, "かしこまりました！！\nご内覧のご都合よろしいお日にちが決まり次第、ご連絡頂けますと幸いです！！").map((x) => x.topic), ["cost"]);
  eq(uncoveredRequests(cur, "かしこまりました！！\n最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！").length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
