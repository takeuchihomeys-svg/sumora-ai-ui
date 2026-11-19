// scripts/test-our-send-uptake.ts — こちらの直前の送信の受け取られ方・刺さり（app/lib/our-send-uptake.ts・BRAIN_OUR_SEND_UPTAKE 既定 off）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-our-send-uptake.ts
// 実物: 竹内さんの198通の番の形（名前は YUMA に伏せた・文は短く切った）
import assert from "node:assert/strict";
import { ourSendUptakeOn, splitOurSend, readUptake, takeuchiRepairOf, normalizeOurSendUptake, ourSendUptakeDigest, OUR_SEND_UPTAKE_FIELD, OUR_SEND_UPTAKE_RULES, HOOK_TO_COMPOSE, HOOK_POINTS } from "../app/lib/our-send-uptake";
import { APPEAL_POINTS } from "../app/lib/compose-sentence-plan";
import { NEXT_DEST } from "../app/lib/next-move-types";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off", () => {
  assert.equal(ourSendUptakeOn({}), false);
  assert.equal(ourSendUptakeOn({ BRAIN_OUR_SEND_UPTAKE: "on" }), true);
});

t("こちらの送信を部分に分ける（物件・事実・誘い・約束・聞いた事）", () => {
  const p = splitOurSend("🌟エグゼ難波西Ⅱ 202号室\n洋室8.5帖と広く開放感抜群のお部屋となります！！\n現在礼金0円キャンペーン中の為初期費用を抑える事ができます！！\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！\nご入居の時期はいつ頃をお考えでしょうか？");
  assert.deepEqual(p.map((x) => x.kind), ["property", "fact", "fact", "invite", "question"]);
  assert.ok(p[1].points.includes("広さ・間取り"));
  assert.ok(p[2].points.includes("キャンペーン") && p[2].points.includes("初期費用"));
});

t("2つ聞いたのに1つだけ答えた＝残りは流した", () => {
  const p = splitOurSend("ご入居の時期はいつ頃をお考えでしょうか？\nペットは飼われていますか？");
  const u = readUptake(p, "ペットはいないです");
  assert.equal(u[1].uptake, "answered");
  // 1つ目は語が重ならないが、文で答えている番は answered に倒す（網は聞き漏らしを数えすぎない側）
  assert.ok(["answered", "passed"].includes(u[0].uptake));
});

t("説明済みの事をもう一度聞いた＝聞き返した（伝わっていない）", () => {
  const p = splitOurSend("お申込から10日程でご入居いただけます！！");
  const u = readUptake(p, "お申込からご入居までどれくらいですか？");
  assert.equal(u[0].uptake, "asked_again");
});

t("刺さり: 決めたい・かなり・刺さらない（理由の点）", () => {
  const p = splitOurSend("🌟シーズンフラッツ 608号室");
  assert.equal(readUptake(p, "608で申し込みしたいです")[0].hook?.degree, "decide");
  assert.equal(readUptake(p, "綺麗ですね！ここ！")[0].hook?.degree, "strong");
  const nh = readUptake(p, "肥後橋は上過ぎるかもです😭")[0].hook;
  assert.equal(nh?.kind, "not_hooked");
  assert.equal(nh?.reason, "駅・場所");
});

t("竹内さんの返し方: 流した問いを聞き直す／言い換える／先に進む", () => {
  const q = readUptake(splitOurSend("ご都合よろしいお日にちお聞かせ頂けますでしょうか？"), "了解です");
  assert.equal(takeuchiRepairOf(q.filter((x) => x.part.kind === "question"), ["明日ですが17:45〜18:45のみ空いております！！ご都合いかがでしょうか！！"]).kind, "ask_again");
  const f = readUptake(splitOurSend("お申込から10日程でご入居いただけます！！"), "お申込からご入居までどれくらいですか？");
  assert.equal(takeuchiRepairOf(f, ["お申込みからご入居までは10日程の目安となります！！"]).kind, "rephrase");
});

t("欄・決まりに次の一手・押す・誘導の言葉を入れない（道の前に置ける事実の欄）", () => {
  for (const s of [OUR_SEND_UPTAKE_FIELD, OUR_SEND_UPTAKE_RULES]) assert.doesNotMatch(s, /次の一手|押す|誘導|申込へ|内覧へ/);
});

t("ブレインの答えを整える（種類の外・6つ目以降は捨てる・刺さりは物件と提案だけ）", () => {
  const rows = normalizeOurSendUptake([
    { part: "8.5帖と広い", kind: "property", uptake: "answered", hook: "hooked", degree: "strong", point: "広さ・間取り", cue: "広いですね" },
    { part: "ご入居時期", kind: "question", uptake: "passed", hook: "hooked" },
    { part: "x", kind: "zzz", uptake: "answered" },
  ]);
  assert.equal(rows?.length, 2);
  assert.equal(rows?.[1].hook, null);
  assert.equal(ourSendUptakeDigest(rows), "p○刺s,q－");
  assert.equal(normalizeOurSendUptake("x"), null);
});

t("名前は作業員10 の APPEAL_POINTS・next-move-types と同じ", () => {
  for (const p of APPEAL_POINTS) assert.ok((HOOK_POINTS as readonly string[]).includes(p), p);
  for (const r of HOOK_TO_COMPOSE) assert.ok((NEXT_DEST as readonly string[]).includes(r.lead), r.lead);
});

console.log(`全部 ${n} 件 ok`);

// 2026-11-12: 部分の細かい語彙（作業員4 の our-part-types.ts と同じ名前）
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const U = require("../app/lib/our-send-uptake") as typeof import("../app/lib/our-send-uptake");
  const p = U.splitOurSend("🌟〈物件〉 502号室\nご入居の時期はいつ頃をお考えでしょうか？\n募集状況確認させて頂き確認出来次第ご連絡させて頂きます！！\n最大限割引した御見積書を作成しお送りさせて頂きます！！\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！");
  assert.deepEqual(p.map((x) => `${x.kind}:${x.sub}`), ["property:one_push", "question:move_in", "promise:check", "promise:estimate", "invite:viewing_door"]);
  console.log("ok 部分の細かい語彙（聞いた事＝条件のどれ・約束＝確認／見積・送った物件＝1件推し・誘い＝内覧）");
}
