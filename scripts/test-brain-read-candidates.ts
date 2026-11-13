// scripts/test-brain-read-candidates.ts — 案2: 一通の読みの候補（BRAIN_READ_CANDIDATES）と受け取られ方（BRAIN_OUR_SEND_UPTAKE）の配線と純関数のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-brain-read-candidates.ts
// 実物: 本番 11264（条件と一緒に物件→参考の物件を見積と決め打ち）・竹内さんの198通のお礼の番（物件の後・見積の後・約束の後）の形（名前は伏せた）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCandidatesOn, normalizeReadCandidates, chosenReading, readByFact, readCandidatesDigest, READ_CANDIDATES_FIELD, READ_CANDIDATES_RULES } from "../app/lib/brain-read-candidates";
import { OUR_SEND_UPTAKE_FIELD } from "../app/lib/our-send-uptake";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off", () => {
  assert.equal(readCandidatesOn({}), false);
  assert.equal(readCandidatesOn({ BRAIN_READ_CANDIDATES: "on" }), true);
});

t("off の時の brain-core は前と同じ（欄も決まりも off の側は空文字）", () => {
  const src = readFileSync(join(__dirname, "..", "app", "lib", "brain-core.ts"), "utf8");
  assert.ok(src.includes('{${BRAIN_OUR_SEND_UPTAKE_ON ? OUR_SEND_UPTAKE_FIELD + ", " : ""}${BRAIN_READ_CANDIDATES_ON ? READ_CANDIDATES_FIELD + ", " : ""}${BRAIN_NOW_LATER_ON ? NOW_VS_LATER_FIELD + ", " : ""}"action"'));
  // 欄は action より前（事実の欄）・受け取られ方 → 読みの候補 → 今と後 の順（竹内さんの確認の順番: 言われた事 → 読みの候補 → こちらの前の送信 → 今届けられる物）
  const i1 = src.indexOf("OUR_SEND_UPTAKE_FIELD + "), i2 = src.indexOf("READ_CANDIDATES_FIELD + "), i3 = src.indexOf("NOW_VS_LATER_FIELD + "), ia = src.indexOf('"action": "スタッフが次にすべき');
  assert.ok(i1 < i2 && i2 < i3 && i3 < ia);
});

t("欄・決まりに道を引っぱる言葉を入れない", () => {
  for (const s of [READ_CANDIDATES_FIELD, READ_CANDIDATES_RULES, OUR_SEND_UPTAKE_FIELD]) assert.doesNotMatch(s, /次の一手|押す|申込へ|内覧へ|誘導|背中/);
});

t("本番 11264 の形: 条件と一緒に物件→候補から『条件の参考』を事実で選ぶ", () => {
  const r = normalizeReadCandidates({ turn: "brought_property", options: ["空きを知りたい", "初期費用を知りたい", "条件の参考に送った"], chosen: 2, by: "同じ一通で条件を送り、直前のこちらの送信は条件の確認" });
  assert.equal(chosenReading(r), "条件の参考に送った");
  assert.ok(readByFact(r));
  assert.equal(readCandidatesDigest(r), "brought_property:3>2+事実");
});

t("お礼だけの番: 何への了承かを直前の送信で（見積の後）", () => {
  const r = normalizeReadCandidates({ turn: "ack_only", options: ["見積書への了承", "ピックアップの約束への了承"], chosen: 0, by: "直前のこちらの送信は御見積書" });
  assert.equal(chosenReading(r), "見積書への了承");
});

t("none の番は候補を持たない・壊れた答えは捨てる", () => {
  assert.deepEqual(normalizeReadCandidates({ turn: "none", options: ["x"], chosen: 0, by: "y" })?.options, []);
  assert.equal(normalizeReadCandidates({ turn: "zzz" }), null);
  assert.equal(normalizeReadCandidates(null), null);
  assert.equal(normalizeReadCandidates({ turn: "ack_only", options: ["a"], chosen: 5 })?.chosen, null);
});

console.log(`全部 ${n} 件 ok`);

// 2026-11-13: shadow（JSON の最後・記録だけ）と、選んだ読みの受け渡し（点検役 S3・実例 12362・12838・11865）
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const M = require("../app/lib/brain-read-candidates") as typeof import("../app/lib/brain-read-candidates");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const S = require("../app/lib/latent-subkinds") as typeof import("../app/lib/latent-subkinds");
  const src2 = readFileSync(join(__dirname, "..", "app", "lib", "brain-core.ts"), "utf8");
  assert.equal(M.readCandidatesMode({}), "off");
  assert.equal(M.readCandidatesMode({ BRAIN_READ_CANDIDATES: "shadow" }), "shadow");
  // shadow の欄は JSON の一番最後（action より後・判断の後の振り返り）
  assert.ok(src2.includes('${BRAIN_READ_CANDIDATES_SHADOW ? ", " + READ_CANDIDATES_FIELD_SHADOW : ""}}'));
  assert.ok(src2.indexOf("READ_CANDIDATES_FIELD_SHADOW : \"\"}}") > src2.indexOf('"action": "スタッフが次にすべき'));
  for (const s of [M.READ_CANDIDATES_FIELD_SHADOW, M.READ_CANDIDATES_RULES_SHADOW]) assert.doesNotMatch(s, /次の一手|押す|申込へ|内覧へ|誘導|背中/);

  // 12362: 「抑えられるところは送ってもらった間取りですか？」→ 抑える部屋の確かめ＝申込の手前 → 潜在の行は「先に取られる」
  const a = M.normalizeReadCandidatesFull({ turn: "short_unclear", options: ["間取りの確認だけ", "抑えられる部屋の確かめ＝申込の手前"], checks: [{ from: "our_last_send", fact: "送ったのは1LDKの202号室", supports: 1 }], chosen: 1, by: "抑えられるかを聞いている" });
  const ha = M.readingHandoff(a)!;
  assert.equal(ha.reading, "抑えられる部屋の確かめ＝申込の手前");
  assert.equal(ha.whyKind, "our_last_send");
  assert.equal(S.subkindOf({ trigger: { text: ha.latentText } })?.id, "taken_popular");

  // 12838: 送った物件（カウンターキッチン無し）の後に「できればカウンターキッチン」→ 送った物件にあと1点足りない
  const b = M.normalizeReadCandidatesFull({ turn: "short_unclear", options: ["新しい条件の追加", "送った物件にカウンターキッチンが無い＝あと1点"], checks: [{ from: "sent_property_point", fact: "送った物件の設備にカウンターキッチンが無い", supports: 1 }], chosen: 1, by: "送った直後の反応" });
  const hb = M.readingHandoff(b)!;
  assert.equal(hb.whyKind, "our_last_send");
  assert.match(hb.latentText, /あと1点/);
  assert.equal(S.subkindOf({ trigger: { text: hb.latentText } })?.id, "decide_gap_one_point");

  // 11865: 「おとり物件てことですか」→ 掲載への疑問（こちらの直前の送信＝掲載終了の確認結果で確かめる）
  const c = M.normalizeReadCandidatesFull({ turn: "short_unclear", options: ["こちらの対応への不満", "掲載の物件が本当に無いのかの疑問"], checks: [{ from: "our_last_send", fact: "ポータルの物件は掲載終了と伝えた", supports: 1 }], chosen: 1, by: "直前のこちらの送信への問い返し" });
  assert.equal(M.readingHandoff(c)?.reading, "掲載の物件が本当に無いのかの疑問");

  // 確かめる事実の取り先の外の値・番号の外は捨てる
  const d = M.normalizeReadCandidatesFull({ options: ["x", "y"], checks: [{ from: "zzz", fact: "a" }, { from: "open_promise", fact: "ピックアップの約束", supports: 9 }], chosen: 0 })!;
  assert.equal(d.checks.length, 1);
  assert.equal(d.checks[0].supports, null);
  assert.equal(M.readingHandoff(M.normalizeReadCandidatesFull({ options: ["x"], chosen: null })), null);
  console.log("ok shadow（JSON の最後・記録だけ）と選んだ読みの受け渡し（12362・12838・11865）");
}
