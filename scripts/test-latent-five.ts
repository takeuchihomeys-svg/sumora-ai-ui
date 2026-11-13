// scripts/test-latent-five.ts — 潜在の5段（latent-five）と下の種類（latent-subkinds）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-latent-five.ts
import assert from "node:assert/strict";
import { latentFiveOn, normalizeLatentFive, assertableStages, stagesFromLatentFour, LATENT_FIVE_FIELD, LATENT_FIVE_RULES } from "../app/lib/latent-five";
import { subkindOf, LATENT_SUBKINDS, LATENT_TOP, latentSubkindsOn } from "../app/lib/latent-subkinds";
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
    reason: { text: "今月は引っ越しで出費が多いと前に言った", src: "earlier_words" },
    expect: { text: "カードで分割できればこの物件で申込に進みたい", src: "guess" },
    feeling: { kind: "不安", strength: "mid", src: "customer_words" },
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

console.log(`全部 ${n} 件 ok`);
