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
