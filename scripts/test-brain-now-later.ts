// scripts/test-brain-now-later.ts — 今の番と後の番を分ける欄（app/lib/brain-now-later.ts・BRAIN_NOW_LATER_FIRST 既定 off）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-brain-now-later.ts
// 実物: 本番の物差しの番（line_watch_turns 11154・11264・11447・12189・11408・12240・12306 の竹内さんの送信の形・名前は伏せた）と、
//       試験の実際の答案（compose-1105 の w10-seven-on3.jsonl の q022＝欄が無い答案）の形で確かめる。
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nowLaterFirstOn, normalizeNowVsLater, aixNowOf, nowLaterConflicts, nowLaterDigest, NOW_VS_LATER_FIELD, NOW_VS_LATER_RULES, NOW_LATER_AIX_PROVISO } from "../app/lib/brain-now-later";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off（on だけで有効）", () => {
  assert.equal(nowLaterFirstOn({}), false);
  assert.equal(nowLaterFirstOn({ BRAIN_NOW_LATER_FIRST: "shadow" }), false);
  assert.equal(nowLaterFirstOn({ BRAIN_NOW_LATER_FIRST: " ON " }), true);
});

t("off の時の brain-core の文は前と1文字も変わらない（off の側に元の文が残っている）", () => {
  const src = readFileSync(join(__dirname, "..", "app", "lib", "brain-core.ts"), "utf8");
  assert.ok(src.includes('${BRAIN_NOW_LATER_ON ? NOW_LATER_AIX_PROVISO : "この時は null にせず property_send を選ぶ"}'));
  assert.ok(src.includes('"この時の aix は property_send、reply_direction は「宣言したピックアップを実行して届ける」にする。"'));
  assert.ok(src.includes('${BRAIN_NOW_LATER_ON ? NOW_VS_LATER_FIELD + ", " : ""}"action": "スタッフが次にすべき'));
  // 欄は action より前（JSON の最初）
  assert.ok(src.indexOf("NOW_VS_LATER_FIELD + \", \"") < src.indexOf('"action": "スタッフが次にすべき'));
});

t("欄・決まりに道を引っぱる言葉（次の一手・押す・申込へ・気持ち）を入れない", () => {
  for (const s of [NOW_VS_LATER_FIELD, NOW_VS_LATER_RULES, NOW_LATER_AIX_PROVISO]) {
    assert.doesNotMatch(s, /次の一手|押す|申込へ|背中|気持ち|温度|中期/);
  }
});

t("本番 12189 の形（家賃の上限を下げた・送れる物件まだ）: promise → 今の番に押す AIX は無し・aix は後で果たす property_send のまま", () => {
  const nl = normalizeNowVsLater({ asked_now: ["家賃7万円以内に絞ってほしい"], our_open: "ピックアップしてお送りする約束", ready_now: [], this_turn: "promise" });
  assert.equal(aixNowOf(nl, "property_send"), null);
  assert.deepEqual(nowLaterConflicts(nl, { finalAix: "property_send", contractRoutes: ["promise"] }), []);
  assert.equal(nowLaterDigest(nl), "t=promise r=- o=1");
});

t("本番 11408 の形（確認の結果が手元にある）: deliver → 今押す AIX は結果", () => {
  const nl = normalizeNowVsLater({ asked_now: ["空いてますか"], our_open: "募集状況を確認する約束", ready_now: ["確認の結果"], this_turn: "deliver" });
  assert.equal(aixNowOf(nl, "property_check_result"), "property_check_result");
  assert.deepEqual(nowLaterConflicts(nl, { finalAix: "property_check_result", contractRoutes: ["aix"] }), []);
});

t("本番 11154 の形（割引の問い・物件まだ）: answer なのに依頼が全部 aix なら食い違いの印（決め直さない・ログだけ）", () => {
  const nl = normalizeNowVsLater({ asked_now: ["割引してもらえますか"], our_open: null, ready_now: ["なし"], this_turn: "answer" });
  assert.deepEqual(nl?.ready_now, []);
  assert.deepEqual(nowLaterConflicts(nl, { finalAix: "condition_hearing", contractRoutes: ["aix"] }), ["reply_turn_but_contract_all_aix"]);
  assert.equal(aixNowOf(nl, "condition_hearing"), null);
});

t("本番 11447・11264 の形（物件が届いた・確認まだ）: promise で約束の道が無いと印", () => {
  const nl = normalizeNowVsLater({ asked_now: ["この物件空いてますか"], our_open: null, ready_now: [], this_turn: "promise" });
  assert.deepEqual(nowLaterConflicts(nl, { finalAix: "estimate_sheet", contractRoutes: ["aix"] }), ["reply_turn_but_contract_all_aix", "promise_turn_without_promise_route"]);
});

t("deliver なのに届ける物が無い・AIX が無いは印", () => {
  const nl = normalizeNowVsLater({ asked_now: ["お礼・了承"], ready_now: [], this_turn: "deliver" });
  assert.deepEqual(nowLaterConflicts(nl, { finalAix: null }), ["deliver_without_aix", "deliver_without_ready"]);
});

t("欄が無い・壊れた答案（今の答案の形）は undefined＝数えない", () => {
  assert.equal(normalizeNowVsLater(null), null);
  assert.equal(normalizeNowVsLater("x"), null);
  assert.equal(normalizeNowVsLater({ this_turn: "go" }), null);
  assert.equal(aixNowOf(null, "property_send"), undefined);
  const real = join(__dirname, "..", "..", "compose-1105", "scripts", "brain-exam", "results", "w10-seven-on3.jsonl");
  if (existsSync(real)) {
    const row = JSON.parse(readFileSync(real, "utf8").split("\n").find((l) => l.trim()) ?? "{}") as { brain?: Record<string, unknown> };
    assert.equal(normalizeNowVsLater(row.brain?.now_vs_later), null);
    assert.equal(aixNowOf(normalizeNowVsLater(row.brain?.now_vs_later), String(row.brain?.action ?? "")), undefined);
    console.log("   （実際の答案 q022 で確かめた）");
  }
});

t("長さ・件数を切る", () => {
  const nl = normalizeNowVsLater({ asked_now: ["a".repeat(80), "b", "c", "d"], our_open: "x".repeat(100), ready_now: ["送れる物件", "御見積書", "確認の結果", "送れる物件"], this_turn: "ANSWER" });
  assert.equal(nl?.asked_now.length, 3);
  assert.equal(nl?.asked_now[0].length, 40);
  assert.equal(nl?.our_open?.length, 60);
  assert.equal(nl?.ready_now.length, 3);
  assert.equal(nl?.this_turn, "answer");
});

console.log(`全部 ${n} 件 ok`);

// 2026-11-13: q065 の外れ（会社の事実で答えられる問いの番に aix=property_send）の直し
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const M = require("../app/lib/brain-now-later") as typeof import("../app/lib/brain-now-later");
  assert.match(M.NOW_VS_LATER_RULES, /answer・ack の時は、今の番は返信で、aix は null/);
  assert.match(M.NOW_VS_LATER_RULES, /「物件により異なる」で約束にしない/);
  assert.doesNotMatch(M.NOW_VS_LATER_RULES, /answer・promise・ack の時は[^。]*書いてよい/);
  assert.match(M.NOW_LATER_AIX_PROVISO, /答えられる問いなら this_turn は answer で aix は null/);
  for (const s of [M.NOW_VS_LATER_RULES, M.NOW_LATER_AIX_PROVISO]) assert.doesNotMatch(s, /次の一手|押す|申込へ|背中|気持ち|温度|中期/);
  console.log("ok q065 の直し: 問いの番は aix を null・一般的な目安は会社の事実で答える");
}
