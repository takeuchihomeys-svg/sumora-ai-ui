// scripts/test-latent-five.ts — 潜在の5段（latent-five）と下の種類（latent-subkinds）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-latent-five.ts
import assert from "node:assert/strict";
import { latentFiveOn, normalizeLatentFive, assertableStages, stagesFromLatentFour, LATENT_FIVE_FIELD, LATENT_FIVE_RULES, feelingStrengthCue, expectNextIfCue } from "../app/lib/latent-five";
import { subkindOf, LATENT_SUBKINDS, LATENT_TOP, latentSubkindsOn, latentRowCandidate } from "../app/lib/latent-subkinds";
import { LATENT_KINDS } from "../app/lib/compose-sentence-plan";
import { ANXIETY_TARGETS } from "../app/lib/customer-mindset";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off", () => {
  assert.equal(latentFiveOn({}), false);
  assert.equal(latentSubkindsOn({}), false);
  assert.equal(latentFiveOn({ LATENT_FIVE: "on" }), true);
});

t("上の種類は作業員10 の LATENT_KINDS と同じ・mindsetTarget は作業員21 の ANXIETY_TARGETS の名前", () => {
  assert.deepEqual([...LATENT_TOP], [...LATENT_KINDS]);
  for (const s of LATENT_SUBKINDS) assert.ok((ANXIETY_TARGETS as readonly string[]).includes(s.mindsetTarget), `${s.id} ${s.mindsetTarget}`);
  assert.equal(new Set(LATENT_SUBKINDS.map((s) => s.id)).size, LATENT_SUBKINDS.length);
});

t("欄・決まりに道を引っぱる言葉を入れない", () => {
  for (const s of [LATENT_FIVE_FIELD, LATENT_FIVE_RULES]) assert.doesNotMatch(s, /次の一手|押す|申込へ|内覧へ|誘導|背中/);
});

t("5段の通しの例（統括役の例: 2件目の初期費用・カード払い）", () => {
  const l = normalizeLatentFive({
    object: { property: "2件目", part: "初期費用", matter: "カード払いが使えるか", src: "customer_words" },
    concern: { text: "手元の現金が足りるか", src: "guess" },
    reason: { kind: "earlier_circumstance", ref: "earlier_words", quote: "今月は引っ越しで出費が多い", text: "今月は引っ越しで出費が多いと前に言った", guess: false },
    expect: { outcome: "answer_only", next_if: "カードで分割できればこの物件で申込", decided_by: "fact", text: "カードで分割できればこの物件で申込に進みたい", src: "guess" },
    feeling: { kind: "不安", strength: "mid", toward: "self", src: "customer_words" },
  });
  assert.ok(l);
  assert.deepEqual(assertableStages(l), ["object", "reason", "feeling"]); // 推測の段は文で言い切らない
  assert.equal(subkindOf({ part: { point: "初期費用のカード払い" } })?.id, "cost_payment"); // 細かい方（支払い方法）を先に当てる
  assert.equal(subkindOf({ part: { point: "初期費用の総額" } })?.id, "cost_initial_total");
  assert.equal(subkindOf({ part: { point: "支払い方法（分割）" } })?.id, "cost_payment");
});

t("下の種類の当て方: 部分を先に見る（したい事に内覧が出ても、部分が立地なら住み心地・周り）", () => {
  assert.equal(subkindOf({ part: { point: "立地" }, want: "内覧する前に駅から近い別の候補も見比べたい" })?.top, "住み心地・周り");
  assert.equal(subkindOf({ part: { point: "審査" }, feeling: { what: "ブラックで落ちるのでは" } })?.id, "screen_attribute");
});

t("今の欄（LatentFour）で読める段: 対象は型・気がかり/想定/気持ちは文だけ・理由は事情の語がある時だけ", () => {
  const c = stagesFromLatentFour({ trigger: { kind: "customer_words", text: "もう少し先の日はないでしょうか" }, part: { point: "内覧の日" }, feeling: { what: "都合が合わない", strength: "mid" }, want: "先にしたい" });
  assert.equal(c.object, "typed");
  assert.equal(c.concern, "text_only");
  assert.equal(c.reason, "missing");
});

t("壊れた答え・出所の無い段は推測に倒す", () => {
  assert.equal(normalizeLatentFive(null), null);
  const l = normalizeLatentFive({ concern: { text: "x" }, feeling: { kind: "zzz" } });
  assert.equal(l?.concern?.src, "guess");
  assert.equal(l?.feeling, null);
});

// ─── 2026-11-13 点検役の実例（本番の物差しの番・名前と物件名は伏せた）────────────────────────
t("12643（鍵交換）: なぜ＝前に言った初期費用5万以内（登録の条件）・想定＝外して5万に近づけば申込（スタッフの確認で決まる）", () => {
  const cust = "鍵交換代は必須ですか？ / 鍵交換しなくてもいいので";
  assert.match(expectNextIfCue(cust) ?? "", /しなくてもいいので/);
  assert.equal(subkindOf({ part: { point: "初期費用の鍵交換代" } })?.id, "cost_initial_total");
  const l = normalizeLatentFive({
    object: { property: null, part: "初期費用", matter: "鍵交換代を外せるか", src: "customer_words" },
    concern: { text: "初期費用が予算の5万を超える", src: "record" },
    reason: { kind: "condition_check", ref: "registered_conditions", quote: "初期費用5万以内", text: "前に言った初期費用5万以内に照らすと鍵交換代が重い", guess: false },
    expect: { outcome: "remove_and_resend", next_if: "鍵交換を外して5万に近づけば申込", decided_by: "staff_check", text: "鍵交換を外した額を出してほしい", src: "customer_words" },
    feeling: { kind: "期待", strength: "mid", toward: "property", src: "customer_words" },
  })!;
  assert.equal(l.reason?.kind, "condition_check");
  assert.equal(l.expect?.decided_by, "staff_check");
  assert.deepEqual(assertableStages(l), ["object", "concern", "reason", "expect", "feeling"]);
});

t("12196（場所の割に高い）: 不満は物件へ・弱め（ちょっと）・想定＝外して出し直し", () => {
  const cust = "〈物件〉が\n場所的にちょっと高いかと\n色々と紹介頂ける案件を\nお待ちしております。";
  assert.equal(feelingStrengthCue(cust), "weak");
  const l = normalizeLatentFive({
    object: { property: "〈物件〉", part: "家賃", matter: "場所の割に高い", src: "customer_words" },
    concern: { text: "場所に見合わない家賃", src: "customer_words" },
    reason: { kind: "condition_check", ref: "registered_conditions", quote: null, text: "希望の家賃の線と場所の相場に照らした", guess: false },
    expect: { outcome: "remove_and_resend", next_if: null, decided_by: "staff_check", text: "外して別の物件を紹介してほしい", src: "customer_words" },
    feeling: { kind: "不満", strength: "weak", toward: "property", src: "customer_words" },
  })!;
  assert.equal(l.feeling?.toward, "property");
  assert.equal(l.expect?.outcome, "remove_and_resend");
});

t("11865（おとり物件）: 疑問は掲載へ・感謝はこちらへ（向きを分ける）・なぜ＝掲載との食い違い", () => {
  const l = normalizeLatentFive({
    object: { property: null, part: "掲載の物件", matter: "ポータルの物件が本当に無いのか", src: "customer_words" },
    concern: { text: "掲載の物件を信じてよいか", src: "customer_words" },
    reason: { kind: "listing_gap", ref: "our_send", quote: "おとり物件てことですか", text: "こちらの確認の結果と掲載が食い違った", guess: false },
    expect: { outcome: "answer_only", next_if: null, decided_by: "fact", text: "掲載の仕組みを知りたい", src: "customer_words" },
    feeling: { kind: "不信・疑問", strength: "mid", toward: "listing", src: "customer_words" },
  })!;
  assert.equal(l.feeling?.toward, "listing");
  assert.equal(l.reason?.kind, "listing_gap");
});

t("出所（ref）が無い理由は推測の印が付き、文で言い切らない", () => {
  const l = normalizeLatentFive({ reason: { kind: "past_experience", text: "前に騒音で困った", ref: "zzz" } })!;
  assert.equal(l.reason?.guess, true);
  assert.deepEqual(assertableStages(l), []);
});

t("気持ちの強さの手がかり", () => {
  assert.equal(feelingStrengthCue("めっちゃいいですね！！！"), "strong");
  assert.equal(feelingStrengthCue("すいません💦"), "weak");
  assert.equal(feelingStrengthCue("ありがとうございます"), null);
});

t("concern が空でも行が立つ（点検役の 12362・12548・12265・使う事実の口つき）", () => {
  // 12362: 抑えられる部屋は送った間取りか → 先に取られる・他の号室の申込状況
  const a = latentRowCandidate({ concernText: null, customerText: "〈物件〉のお部屋は抑えられるところは送ってもらった間取りですか？" });
  assert.equal(a?.sub.id, "taken_popular");
  assert.equal(a?.sub.factSource, "other_rooms_status");
  // 12548: 白フローリングはあるか → あと1点が合わない・代わりの物件
  const b = latentRowCandidate({ concernText: "", customerText: "〈物件〉がいい印象です。(白フローリングってありますか？)" });
  assert.equal(b?.sub.id, "decide_gap_one_point");
  assert.equal(b?.sub.factSource, "alternatives");
  // 12265: 同棲で長く住む → 長く住む安心・構造（お客様の言葉に無く、こちらの送信から）
  const c = latentRowCandidate({ concernText: null, customerText: "承知致しました。ありがとうございます！", ourSendText: "同棲で長く住むってなると騒音面や建物の構造含めて推せる。新耐震基準の建物で構造しっかりしてる" });
  assert.equal(c?.sub.id, "living_long_term");
  assert.equal(c?.from, "our_send");
  assert.equal(c?.sub.factSource, "structure");
  // 気持ちの読みから: 先に取られる
  assert.equal(latentRowCandidate({ customerText: "はい", mindsetTarget: "先に取られる" })?.sub.id, "taken_popular");
  assert.equal(latentRowCandidate({ customerText: "はい" }), null);
});

console.log(`全部 ${n} 件 ok`);

// 2026-11-13: ブレインへの配線（LATENT_FIVE）と書き手（文の統括の潜在の行）への届き
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const C = require("../app/lib/compose-sentence-plan") as typeof import("../app/lib/compose-sentence-plan");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "app", "lib", "brain-core.ts"), "utf8");
  // 欄は JSON の最後（判断の後の振り返り・q022 で道が動いた教訓）
  assert.ok(src.includes('${BRAIN_LATENT_FIVE_ON ? ", " + LATENT_FIVE_FIELD : ""}}'));
  assert.ok(src.indexOf('BRAIN_LATENT_FIVE_ON ? ", " + LATENT_FIVE_FIELD') > src.indexOf('"action": "スタッフが次にすべき'));
  assert.equal(C.BRAIN_FIELD_ROUTE.latent_five, "plan");
  assert.equal(C.BRAIN_FIELD_ROUTE.latent_five_sub, "plan");
  // 12643 の形の meta → 潜在の行（なぜ・想定・気持ちを言い切れる段だけ）
  const meta12643 = {
    latent_five: {
      object: { property: null, part: "初期費用", matter: "鍵交換代を外せるか", src: "customer_words" },
      concern: { text: "初期費用が予算の5万を超える", src: "record" },
      reason: { kind: "condition_check", ref: "registered_conditions", quote: "初期費用5万以内", text: "前に言った初期費用5万以内に照らすと鍵交換代が重い", guess: false },
      expect: { outcome: "remove_and_resend", next_if: "鍵交換を外して5万に近づけば申込", decided_by: "staff_check", text: "鍵交換を外した額を出してほしい", src: "customer_words" },
      feeling: { kind: "期待", strength: "mid", toward: "property", src: "customer_words" },
    },
    latent_five_sub: { id: "cost_initial_total", top: "費用", factSource: null, phraseKind: "最大限割引の御見積で総額を見せる", from: "concern" },
  };
  const s1 = C.readSevenFields(meta12643);
  assert.equal(s1.src.latentCover, "latent_five");
  assert.equal(s1.latentCover?.kind, "費用");
  assert.match(s1.latentCover?.how ?? "", /なぜ: 前に言った初期費用5万以内/);
  assert.match(s1.latentCover?.how ?? "", /想定: 鍵交換を外した額/);
  // 12362 の形（concern が空・下の種類から）: 使う事実の口が届く
  const meta12362 = { latent_five: { object: { property: "〈物件〉", part: "抑えられる部屋", matter: "送った間取りか", src: "customer_words" }, feeling: { kind: "念押し", strength: "mid", toward: "property", src: "customer_words" } }, latent_five_sub: { id: "taken_popular", top: "先に取られる", factSource: "other_rooms_status", phraseKind: "1部屋のみ・申込で抑えられる線を言う", from: "customer_words" } };
  const s2 = C.readSevenFields(meta12362);
  assert.equal(s2.latentCover?.kind, "先に取られる");
  assert.equal(s2.latentCover?.fact, "他の号室の申込状況");
  // 推測しか無い段は使わない（行を立てない）
  assert.equal(C.latentFiveCover({ latent_five: { concern: { text: "x", src: "guess" } } }), null);
  // 試験の正解の欄（takeuchi_fields）は上書きしない
  const s3 = C.readSevenFields({ ...meta12643, takeuchi_fields: { latent_cover: { kind: "審査", what: "正解の欄" } } });
  assert.equal(s3.latentCover?.kind, "審査");
  console.log("ok ブレインへの配線（JSON の最後）と書き手への届き（12643・12362・推測は使わない・正解の欄は上書きしない）");
}
