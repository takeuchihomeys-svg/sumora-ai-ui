// scripts/test-conductor-field-links.ts — 欄ごとの連携の表（app/lib/conductor-field-links.ts）のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-conductor-field-links.ts
// 落とす物: ①作られたのに誰も受け取らない欄 ②受け取る所があるのに作る所が無い欄 ③同じ物を2つの名前で持っている欄（読み替えの無い物）④道の前に置いてはいけない欄が前にある
//   ＋ meta の鍵がある欄は compose-sentence-plan の BRAIN_FIELD_ROUTE と食い違わない（plan なら受け取る所に compose・other なら compose を書かない）
// 今わかっている③（直すまでの既知の穴・増えたら落ちる）: customer_part.info（INFO_KINDS_16 と INFO_KEYS の読み替えが無い）
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { FIELD_LINKS, RECEIVERS, orphanFields, producerlessFields, duplicateConcepts, placeViolations } from "../app/lib/conductor-field-links";
import { BRAIN_FIELD_ROUTE } from "../app/lib/compose-sentence-plan";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const ROOT = resolve(__dirname, "..");
const KNOWN_DUP = ["customer_part.info"];
const HERE = ["main", "feat/judge-basis-purpose-1112", "feat/our-send-uptake-1112", "w1-exh-1112"]; // このブランチに入っている物

t("統括役の指示の欄が全部ある", () => {
  for (const f of ["now_vs_later", "read_candidates", "our_send_uptake", "info_fill", "exchange_ledger", "customer_part", "our_part", "check_order", "conductor_allocation", "judge_basis", "seven_read", "latent_read", "next_move", "send_combo", "time_facts", "company_fact_proactive", "customer_mindset", "conductor_brief"]) assert.ok(FIELD_LINKS.some((r) => r.field === f), f);
  assert.equal(new Set(FIELD_LINKS.map((r) => r.field)).size, FIELD_LINKS.length);
  for (const r of FIELD_LINKS) { for (const x of r.receivers) assert.ok((RECEIVERS as readonly string[]).includes(x), `${r.field} ${x}`); assert.ok(r.switch && r.vocab && r.owner && r.where, r.field); }
});
t("① 作られたのに誰も受け取らない欄が無い", () => assert.deepEqual(orphanFields(), []));
t("② 受け取る所があるのに作る所が無い欄が無い", () => assert.deepEqual(producerlessFields(), []));
t("③ 同じ物を2つの名前で持つ欄は読み替えがある（既知の穴だけ残る）", () => {
  const d = duplicateConcepts().flatMap((x) => x.noBridge).sort();
  assert.deepEqual(d, [...KNOWN_DUP].sort(), JSON.stringify(duplicateConcepts()));
  // 読む深さ: judge_basis.depth と brain_depth は同じ物で、読み替えの関数がある
  assert.ok(FIELD_LINKS.filter((r) => r.concept === "読む深さ").every((r) => r.bridge === "conductor-allocation.normDepth"));
});
t("④ 道を引っぱる欄（次の一手・優先・目的・押す強さ）は道の前・材料に無い", () => assert.deepEqual(placeViolations(), []));
t("語彙ファイルはこのブランチにある物は在る（他のブランチの物は main に入った順に強める）", () => {
  for (const r of FIELD_LINKS) {
    if (!HERE.some((h) => r.where.startsWith(h))) continue;
    const file = r.vocab.split("（")[0].split("・")[0].trim();
    assert.ok(existsSync(resolve(ROOT, file)), `${r.field} ${file}`);
  }
});
t("meta の鍵がある欄は BRAIN_FIELD_ROUTE と食い違わない（plan ⇔ 受け取る所に compose）", () => {
  for (const r of FIELD_LINKS) {
    if (!r.metaKey || !HERE.some((h) => r.where.startsWith(h))) continue;
    const route = BRAIN_FIELD_ROUTE[r.metaKey];
    assert.ok(route, `BRAIN_FIELD_ROUTE に ${r.metaKey} が無い`);
    assert.equal(route === "plan", r.receivers.includes("compose"), `${r.metaKey}: BRAIN_FIELD_ROUTE=${route}・受け取る所=${r.receivers.join(",")}`);
  }
});
console.log(`\n${n} 件 ok`);
