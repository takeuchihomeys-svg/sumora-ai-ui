// npx tsx app/lib/__tests__/promise-due-text.test.ts
// 2026-11-23 作業員L（found_gap）: 行動台帳の約束の期日を読む文（dueText）。本番の番の形を伏せて使う（名前は〇〇）
import assert from "node:assert/strict";
import { promiseDueTextOf, promiseDueFromText, promisePeriodDeadlineMs, ledgerPromiseDueTextEnabled, DUE_TEXT_MAX } from "../promise-due-text";

const said = Date.parse("2026-11-18T01:45:00Z"); // JST 11/18 10:45
const day = (ms: number) => new Date(ms - 1 + 9 * 36e5).toISOString().slice(0, 10); // 期日は その日の JST 24時
assert.equal(ledgerPromiseDueTextEnabled({}), false);
assert.equal(ledgerPromiseDueTextEnabled({ LEDGER_PROMISE_DUE_TEXT: "on" }), true);

// e4bb495d の形: 型に当たった文は「お探しさせて頂きます」だけだが、同じ通に「12月17日に…ピックアップしお送り」がある → 12/17
const e4 = "〇〇さん、はじめまして😊！！\nお部屋探しを担当させて頂きます〇〇と申します！！\n審査のご不安についても、独立系の保証会社を中心にお部屋をお探しさせて頂きます😌！！\nお部屋を抑えられるのはお申込みから1ヶ月となりますので、2月のご入居でしたら12月17日頃から本格的にお部屋探しを進めて参ります！！\n12月17日に〇〇周辺から10万以内・広めの1LDKのお部屋をピックアップしお送りさせて頂きます！！\n何卒よろしくお願い致します！！";
const t4 = promiseDueTextOf(e4, "pickup_declared")!;
assert.ok(t4.includes("12月17日に") && t4.includes("お探しさせて頂きます"));
assert.ok(!t4.includes("よろしくお願い")); // 約束の言葉の無い文は入れない
assert.deepEqual([day(promiseDueFromText(t4, said).ms), promiseDueFromText(t4, said).by], ["2026-12-17", "words"]);

// ac34b364 の形: 同じ文の頭の「12月中旬ごろになりましたら」を落とさない → 12/20
const ac = "〇〇さん お世話になっております！！\nかしこまりました！！\n1月末ごろのお引越しに向け12月中旬ごろになりましたら本格的にお部屋探し再開させていただきます！！";
const tac = promiseDueTextOf(ac, "pickup_declared")!;
assert.ok(tac.startsWith("1月末ごろ"));
assert.deepEqual([day(promiseDueFromText(tac, Date.parse("2026-11-18T09:12:00Z")).ms), promiseDueFromText(tac, Date.parse("2026-11-18T09:12:00Z")).by], ["2026-12-20", "period"]);

// 期日の言葉が無い約束は今と同じ 72時間
const plain = "かしこまりました！！\nご条件に合ったお部屋ピックアップしてお送りさせて頂きます！！";
assert.deepEqual(promiseDueFromText(promiseDueTextOf(plain, "pickup_declared")!, said), { ms: said + 72 * 36e5, by: "default72h" });
// 「本日中に」が約束の文にあればその日
assert.equal(day(promiseDueFromText(promiseDueTextOf("本日中に〇〇周辺全域からお部屋をピックアップしてお送りさせて頂きます！！", "pickup_declared")!, said).ms), "2026-11-18");
// 確認の約束: 確認の文と「確認出来次第ご連絡」の文を両方・入居の日付だけの文は入れない
const ck = "ご入居は1月30日のご予定ですね！！\nお送り頂いた物件、募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！";
const tck = promiseDueTextOf(ck, "confirmation_promised")!;
assert.ok(!tck.includes("1月30日"));
assert.equal(promiseDueFromText(tck, said).by, "default72h");
// 過去形の報告の文は入れない
assert.equal(promiseDueTextOf("募集状況確認させて頂きました！！現在募集中となります！！", "confirmation_promised"), null);
// 見積
assert.ok(promiseDueTextOf("明日までに最大限割引した御見積書を作成しお送りさせて頂きます！！", "estimate_declared")!.includes("明日"));
assert.equal(promiseDueTextOf("ありがとうございます", "pickup_declared"), null);
assert.equal(promiseDueTextOf("確認させて頂きます", "other_kind"), null);
// 長さ: 300字まで（文の途中の80字で切らない）
const long = Array.from({ length: 6 }, (_, i) => `${i + 1}件目の〇〇周辺の条件でお部屋をピックアップしてお送りさせて頂きます、駅徒歩10分以内・家賃8万円以内・2階以上・バストイレ別の物件を中心にお探しします！！`).join("\n");
assert.equal(promiseDueTextOf(long, "pickup_declared")!.length, DUE_TEXT_MAX);
// 時期の言葉: 来年・上旬・末
assert.equal(day(promisePeriodDeadlineMs("1月末までにお送りさせて頂きます", said)!), "2027-01-31");
assert.equal(day(promisePeriodDeadlineMs("12月初旬にピックアップさせて頂きます", said)!), "2026-12-10");
assert.equal(promisePeriodDeadlineMs("ピックアップさせて頂きます", said), null);
// 入居・引越しの時期は期日でない（8739fa57 の形: 「12月初旬のご入居に間に合うよう…至急ピックアップ」は 72時間のまま）
assert.equal(promisePeriodDeadlineMs("12月初旬のご入居に間に合うよう、〇〇周辺全域から2DKのお部屋を至急ピックアップしてお送りさせて頂きます", said), null);
assert.equal(promisePeriodDeadlineMs("1月末ごろのお引越しに向けピックアップさせて頂きます", said), null);
assert.equal(promiseDueFromText(promiseDueTextOf("12月初旬のご入居に間に合うよう、〇〇周辺全域から2DKのお部屋を至急ピックアップしてお送りさせて頂きます！！", "pickup_declared")!, said).by, "default72h");
console.log("promise-due-text: ok");

// 台帳の口: 既定 off は dueText を書かない／on で約束の行に足す（sentence は変えない）
import { classifyStaffTextForLedger } from "../action-ledger";
{
  delete process.env.LEDGER_PROMISE_DUE_TEXT;
  const off = classifyStaffTextForLedger(e4, new Date(said).toISOString());
  assert.equal(off?.kind, "pickup_declared");
  assert.equal(off?.detail.dueText, undefined);
  process.env.LEDGER_PROMISE_DUE_TEXT = "on";
  const on = classifyStaffTextForLedger(e4, new Date(said).toISOString());
  assert.equal(on?.detail.sentence, off?.detail.sentence);
  assert.ok(String(on?.detail.dueText).includes("12月17日に"));
  assert.equal(classifyStaffTextForLedger("ありがとうございます！！", null)?.detail.dueText ?? null, null);
  delete process.env.LEDGER_PROMISE_DUE_TEXT;
}
console.log("promise-due-text ledger: ok");
