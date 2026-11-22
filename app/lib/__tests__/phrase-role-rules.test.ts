// npx tsx app/lib/__tests__/phrase-role-rules.test.ts
//   2026-11-15 作業員I: 言い回しの表2版（竹内さんの LINE から）の部品。役目の決まった語・骨・版の切り替え・手本の書き手（記録）
import assert from "node:assert/strict";
import { ruleRoleOf, mainRoleOf, openerOf, keigoOf, strengthOf, formOf, selfNameOf } from "../phrase-role-rules";
import { phraseTables, composePhraseCatalogV2On, phraseTablesVersion } from "../compose-phrase-catalog-tables";
import * as V1 from "../compose-phrase-catalog-data";
import * as V2 from "../compose-phrase-catalog-data-v2";
import { endingsFor, lengthFor } from "../compose-phrase-catalog";
import { nearestRecordedWriter, writerBoostOf, exampleWriterRecordedOn } from "../example-writer-recorded";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("役目の決まった語（境目 B・E・F・H）", () => {
  assert.equal(ruleRoleOf("お世話になっております！！"), "greet");
  assert.equal(ruleRoleOf("かしこまりました😊！！"), "uke");
  assert.equal(ruleRoleOf("お送り頂きました物件の募集状況確認させて頂きます！！"), "promise");
  assert.equal(ruleRoleOf("ご条件に合ったお部屋ピックアップしてお送りさせて頂きます！！"), "keep");
  assert.equal(ruleRoleOf("ご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます😌！！"), "trust", "B: 全力でサポートは trust");
  assert.equal(ruleRoleOf("キャンセル料かかりませんので、一度お申込しお部屋抑えさせて頂きます！！"), "apply", "E: 壁と誘いが同じ文なら誘い");
  assert.equal(ruleRoleOf("何卒よろしくお願い致します！！"), "close");
  assert.equal(ruleRoleOf("ご内覧の際はお気軽にお申し付けください"), "viewing", "F: 何を付いていればその役目");
  assert.equal(ruleRoleOf("最大限割引しました初期費用の御見積書となります！！"), "estimate");
  assert.equal(ruleRoleOf("ブラック"), null, "言い切れない文は役目不明");
});
t("主の役目は決まった順", () => {
  assert.equal(mainRoleOf(["uke", "promise", "close"]), "promise");
  assert.equal(mainRoleOf(["uke", null, "close"]), "uke");
  assert.equal(mainRoleOf([null, null]), null);
});
t("骨（頭・敬語・強さ・形・名乗り）", () => {
  assert.equal(openerOf("かしこまりました！！"), "かしこまりました");
  assert.equal(openerOf("ご条件お送り頂きありがとうございます！！"), "〜頂きありがとうございます");
  assert.deepEqual(keigoOf("確認させて頂きます！！何卒よろしくお願い致します"), ["頂き", "致します", "させて頂きます", "何卒"]);
  const s = strengthOf("はい😊！！ よろしくお願い致します🙇！");
  assert.equal(s.bangPairs, 1); assert.equal(s.bangSingles, 1); assert.deepEqual(s.emojiOk, { "😊": 1 }); assert.equal(s.emojiOther, 1);
  const f = formOf("【〇〇 101号室】\n\n・家賃\n・管理費");
  assert.equal(f.lines, 3); assert.equal(f.blankLines, true); assert.equal(f.brackets, true); assert.equal(f.bullets, true);
  assert.equal(selfNameOf("お部屋探しを担当させて頂きます鈴木と申します！！"), "鈴木");
  assert.equal(selfNameOf("〇〇株式会社の竹内です。"), "竹内");
  assert.equal(selfNameOf("かしこまりました"), null);
});
t("表の版の切り替え（既定 off＝1版のまま・on で2版＋無い鍵は1版）", () => {
  assert.equal(composePhraseCatalogV2On({}), false);
  assert.deepEqual(phraseTables({}).PHRASE_ENDING_TABLE, V1.PHRASE_ENDING_TABLE);
  assert.match(phraseTablesVersion({}), /^phrase-catalog@/);
  const on = { COMPOSE_PHRASE_CATALOG_V2: "on" };
  assert.match(phraseTablesVersion(on), /^phrase-catalog-v2@/);
  const T = phraseTables(on);
  for (const k of Object.keys(V2.PHRASE_ENDING_TABLE)) assert.deepEqual(T.PHRASE_ENDING_TABLE[k], (V2.PHRASE_ENDING_TABLE as Record<string, unknown>)[k]);
  for (const k of Object.keys(V1.PHRASE_ENDING_TABLE)) assert.ok(T.PHRASE_ENDING_TABLE[k], `1版の鍵 ${k} が残る`);
  assert.deepEqual(endingsFor("question", "promise", {}), endingsFor("question", "promise"));
  const v2close = endingsFor(null, "close", on); assert.ok(v2close && v2close.n === V2.PHRASE_ENDING_TABLE["*|close"].n);
  assert.ok(lengthFor(null, "keep", on));
  // 主の役目に寄る行の表（行の並び・下の役目）は2版でも1版のまま（11/15 押さえ −1 の直し・q197）
  assert.deepEqual(T.PHRASE_ROWS_TABLE, V1.PHRASE_ROWS_TABLE); assert.deepEqual(T.PHRASE_SUB_TABLE, V1.PHRASE_SUB_TABLE);
  // 2版の表に本文・名前は入れない（札と骨と数だけ）: 長い日本語の文の塊が無い
  const raw = JSON.stringify([V2.PHRASE_ENDING_TABLE, V2.PHRASE_OPENER_TABLE, V2.PHRASE_KEIGO_TABLE]);
  assert.ok(!/[ぁ-んァ-ン一-龥]{25,}/.test(raw), "長い文の塊が無い");
  assert.ok(!/鈴木|〇〇さん/.test(raw));
});
t("手本の書き手（記録）: 既定 off・前後5分の sure の手打ちだけ・無ければ文の推定", () => {
  assert.equal(exampleWriterRecordedOn({}), true); // 2026-11-21 既定 on
  assert.equal(exampleWriterRecordedOn({ EXAMPLE_WRITER_RECORDED: "off" }), false);
  const ms = [
    { created_at: "2026-11-01T01:00:00Z", staff_writer: "employee", staff_writer_confidence: "likely" },
    { created_at: "2026-11-01T01:02:00Z", staff_writer: "takeuchi", staff_writer_confidence: "sure", is_aix_generated: true },
    { created_at: "2026-11-01T01:03:00Z", staff_writer: "takeuchi", staff_writer_confidence: "sure" },
    { created_at: "2026-11-01T01:20:00Z", staff_writer: "employee", staff_writer_confidence: "sure" },
  ];
  assert.equal(nearestRecordedWriter("2026-11-01T01:01:00Z", ms), "takeuchi");
  assert.equal(nearestRecordedWriter("2026-11-01T01:19:00Z", ms), "employee");
  assert.equal(nearestRecordedWriter("2026-11-01T01:40:00Z", ms), null);
  assert.equal(writerBoostOf("takeuchi", "", {}), 0.12);
  assert.equal(writerBoostOf("employee", "", {}), -0.12);
  assert.equal(writerBoostOf("takeuchi", "", { EXAMPLE_WRITER_BOOST: "off" }), 0);
});
import { askTopicsOf, answerMatchOf, answerSentencesOf, ruleRoleWithAsk } from "../phrase-role-rules";
t("答えの突き合わせ（問いの話題・最初の言い切り・出所）", () => {
  assert.deepEqual(askTopicsOf("初期費用いくらですか？\nよろしくお願いします"), ["初期費用"]);
  assert.deepEqual(askTopicsOf("よろしくお願いします"), []);
  assert.deepEqual(answerMatchOf("こちら床の色グレーとなります！！", "床の色白ですか？"), { topic: "設備", source: "material" });
  assert.equal(answerMatchOf("確認させて頂きます", "床の色白ですか？"), null);
  const a = answerSentencesOf(["かしこまりました！！", "お申込は9月末頃を目安にお申込頂く形となります！！", "何卒よろしくお願い致します！！"], "10月末入居希望だといつ頃申し込めばいいでしょうか？");
  assert.deepEqual([...a.keys()], [1]); assert.equal(a.get(1)!.source, "company_fact");
  assert.equal(answerSentencesOf(["こちら床の色グレーとなります！！"], "ありがとうございます").size, 0, "問いが無ければ答えにしない");
  assert.equal(ruleRoleWithAsk("かしこまりました！！", "いつですか？"), "uke");
});
console.log(`ALL PASS (${n})`);
