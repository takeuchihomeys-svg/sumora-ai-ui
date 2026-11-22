// npx tsx scripts/lib/__tests__/writer-field-metrics.test.ts
// 2026-11-23 作業員L（台帳 #466）: 欄ごとの下書きに入ったかの見方（本番の値と下書きをそのまま・名前は伏せた）と数の名前
import assert from "node:assert/strict";
import { inDraftOf, skipReason, tokensFor, metricRowsOf } from "../writer-field-metrics";

// focus: 方向の種類で見る
assert.equal(inDraftOf("focus", "relation＝短い了承。受けて関係を続ける番", "はい！！ 何卒よろしくお願い致します！！"), true);
assert.equal(inDraftOf("focus", "promise_make＝初回の条件の提示は、探して送る約束が竹内さんの形", "ご希望のお部屋をピックアップしてお送りさせて頂きます！！"), true);
assert.equal(inDraftOf("focus", "promise_make＝初回の条件の提示は、探して送る約束が竹内さんの形", "かしこまりました！！"), false);
assert.equal(inDraftOf("focus", "appeal＝推す", "何でも"), null);
// our_side: 「なし」は数えない・時間の語は探さない・引用の中身で見る
assert.equal(skipReason("our_side", "・開いている約束: なし"), "値なし");
assert.ok(!tokensFor("our_side", "・開いている約束: 他の約束「お送り頂き次第、プレミアフェニックス501号室お申込みし審査かけさせて頂きます！」（23時間前・結果はまだ送っていない）").includes("23時"));
assert.equal(inDraftOf("our_side", "・開いている約束: 他の約束「1DKも含めさせて頂き、阪急京都線付近・家賃管理費込み5〜6万円」（0分前）", "かしこまりました！！ 1DKも含めさせて頂き、阪急京都線付近・家賃管理費込み5〜6万円"), true);
// asks: 挨拶だけは要件にしない・英数字の語で見る
assert.equal(inDraftOf("asks", "かしこまりました", "はい！！"), null);
assert.equal(inDraftOf("asks", "申し訳ございませんが、宜しくお願い致します。", "全然大丈夫です！！"), null);
assert.equal(inDraftOf("asks", "1DKでも探していただけますでしょうか", "かしこまりました！！ 1DKも含めさせて頂き"), true);
// 数の名前
const rows = metricRowsOf({ fields: [{ key: "focus", val: 7, writerOk: 7, inDraftN: 4, inDraft: 3 }, { key: "near", val: 0, writerOk: 0, inDraftN: 0, inDraft: 0 }], brief: { open: { n: 10, used: 7 } }, hours: 24 });
assert.deepEqual(rows.map((r) => `${r.metric}=${r.value}/${r.n}`), ["writer_link:field:focus:delivered=100/7", "writer_link:field:focus:in_draft=75/4", "writer_link:brief:open:in_draft=70/10"]);
console.log("writer-field-metrics: ok");
// 2026-11-23 追記: 挨拶の言い回しだけの要件・約束の種類の言い直し
assert.equal(inDraftOf("asks", "引き続き宜しくお願いします", "かしこまりました！！"), null);
assert.equal(inDraftOf("asks", "こちらこそありがとうございました。引き続きよろしくお願いしま", "はい😊！！"), null);
assert.equal(inDraftOf("our_side", "・開いている約束: 確認の約束「管理会社本日お休みでしたので翌営業日に空き状況確認させていただきます！」（5時間前・結果はまだ送っていない）", "はい！！ 確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します！！"), true);
assert.equal(inDraftOf("our_side", "・開いている約束: 探すの約束「本日中に物件お送りさせて頂きます😊！」（6分前・結果はまだ送っていない）", "物件ピックアップ出来次第お送りさせて頂きます！！"), true);
assert.equal(inDraftOf("our_side", "・開いている約束: 見積の約束「御見積書も併せてお送りさせていただき」（21時間前）", "ピックアップ出来次第お送りさせて頂きます！！"), false);
console.log("writer-field-metrics-2: ok");
