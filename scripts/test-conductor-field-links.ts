// scripts/test-conductor-field-links.ts — 欄ごとの連携の表（app/lib/conductor-field-links.ts）のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-conductor-field-links.ts
// 落とす物: ①作られたのに誰も受け取らない欄 ②受け取る所があるのに作る所が無い欄 ③同じ物を2つの名前で持っている欄（読み替えの無い物）④道の前に置いてはいけない欄が前にある
//   ＋ meta の鍵がある欄は compose-sentence-plan の BRAIN_FIELD_ROUTE と食い違わない（plan なら受け取る所に compose・other なら compose を書かない）
// ③の既知の穴（直すまで残す・増えたら落ちる）: aix_first_sent（こちらの送信の読みの出所が exchange-ledger と2通目の自前の splitTurn・sentThisTurn の2つ）
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { FIELD_LINKS, RECEIVERS, RECEIVER_TO_LINK, K_TO_INFO_KEYS, NOT_YET_TO_AIX_SECOND, FIELD_REDECIDES, orphanFields, producerlessFields, duplicateConcepts, placeViolations } from "../app/lib/conductor-field-links";
import { CONDUCTOR_LINKS } from "../app/lib/conductor-linkage";
import { INFO_KEYS } from "../app/lib/info-fill-map";
import { BRAIN_FIELD_ROUTE } from "../app/lib/compose-sentence-plan";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const ROOT = resolve(__dirname, "..");
const KNOWN_DUP: string[] = ["aix_first_sent"];
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
t("K1〜K16 → INFO_KEYS の読み替えの表: 16種が全部あり、値は INFO_KEYS の中だけ（関係が無い種類は空）", () => {
  assert.deepEqual(Object.keys(K_TO_INFO_KEYS), Array.from({ length: 16 }, (_, i) => `K${i + 1}`));
  for (const [k, vs] of Object.entries(K_TO_INFO_KEYS)) for (const v of vs) assert.ok((INFO_KEYS as readonly string[]).includes(v), `${k} ${v}`);
  // INFO_KEYS の13項目のうち、どの K にもつながらない物（今は viewing_done だけ＝内覧が済んだかは K に無い）
  const used = new Set(Object.values(K_TO_INFO_KEYS).flat());
  assert.deepEqual(INFO_KEYS.filter((k) => !used.has(k)), ["viewing_done"]);
});
t("統括の単位の表（conductor-linkage）と突き合う: 受け取る所と作る所の統括の id は CONDUCTOR_LINKS にある", () => {
  const ids = new Set(CONDUCTOR_LINKS.map((l) => l.id));
  for (const [r, id] of Object.entries(RECEIVER_TO_LINK)) if (id) assert.ok(ids.has(id), `${r}→${id}`);
  for (const r of FIELD_LINKS) if (r.link) assert.ok(ids.has(r.link), `${r.field} ${r.link}`);
  // meta の鍵がある欄は全部、CONDUCTOR_LINKS のどれかの writes にある（統括の表の外の欄は無い・2026-11-12 作業員7 の a3dc2d2a で揃った後に落とす形に強めた）
  const writes = CONDUCTOR_LINKS.flatMap((l) => l.writes);
  const outside = FIELD_LINKS.filter((r) => r.metaKey && !writes.some((w) => w === `meta.${r.metaKey}`)).map((r) => r.field);
  assert.deepEqual(outside, [], `統括の表（conductor-linkage）の writes に無い欄: ${outside.join(",")}`);
  // AIX の2通目の欄は aix_second の統括に結ぶ
  for (const f of ["aix_first_sent", "aix_second_materials", "aix_second_brain_bundle", "aix_second_writer"]) assert.equal(FIELD_LINKS.find((x) => x.field === f)!.link, "aix_second", f);
});
t("AIX 1通目→2通目の欄がある（作業員25 の点検と名前を揃える）", () => {
  for (const f of ["aix_first_sent", "aix_second_materials", "aix_second_brain_bundle"]) { const r = FIELD_LINKS.find((x) => x.field === f); assert.ok(r && r.receivers.includes("aix_text"), f); }
  assert.ok(FIELD_LINKS.find((x) => x.field === "customer_mindset")!.receivers.includes("aix_text"), "決め手の残り（AIX_SECOND_LINK）");
  assert.match(FIELD_LINKS.find((x) => x.field === "aix_second_materials")!.note ?? "", /PROMISE_READ_UNIFIED で promise-read と同じ答え/);
  assert.ok(FIELD_LINKS.some((x) => x.field === "aix_second_writer"));
});
t("AIX の2通目にまだ届いていない欄は「未」の一覧にあり、表にある欄で、受け取り手に aix_text が無い", () => {
  assert.deepEqual(NOT_YET_TO_AIX_SECOND.map((x) => x.field), ["turn_aims", "next_move", "now_vs_later", "seven_read", "latent_read", "exchange_ledger", "judge_basis", "sentence_pattern_catalog"]);
  for (const x of NOT_YET_TO_AIX_SECOND) { const r = FIELD_LINKS.find((y) => y.field === x.field); assert.ok(r, x.field); assert.ok(!r!.receivers.includes("aix_text"), `${x.field} はもう届いている→一覧から外す`); }
});
t("欄の単位の決め直し: 2通目の訴求の判断が1通目の締めを決め直す所が載っている", () => {
  assert.ok(FIELD_REDECIDES.some((r) => /second-appeal-judge/.test(r.where) && /recommend-cta/.test(r.of)));
});
console.log(`\n${n} 件 ok`);
