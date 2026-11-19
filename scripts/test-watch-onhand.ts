// scripts/test-watch-onhand.ts — 設計図と注記の控え（compose-plan-watch）と、mm が手元にあった印（material-on-hand）のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-watch-onhand.ts
import assert from "node:assert/strict";
import { watchComposePlanOn, composePlanWatchOf, fingerprint } from "../app/lib/compose-plan-watch";
import { materialOnHandMode, markOnHand, onHandDigest } from "../app/lib/material-on-hand";
import { PLAN_KEYS } from "./lib/exam-plan-keys";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off（WATCH_COMPOSE_PLAN・MATERIAL_ON_HAND）", () => {
  assert.equal(watchComposePlanOn({}), false); assert.equal(watchComposePlanOn({ WATCH_COMPOSE_PLAN: "on" }), true);
  assert.equal(materialOnHandMode({}), "off"); assert.equal(materialOnHandMode({ MATERIAL_ON_HAND: "shadow" }), "shadow");
});

t("設計図の控え: 行ごとの役目・何を（40字まで）・注記の指紋と先頭200字・漏れの数・届いた数・下の欄の名前", () => {
  const note = "【✍️ 文の設計図】" + "あ".repeat(300);
  const w = composePlanWatchOf({ digest: "answer|worry", rows: [{ rank: "main", role: "answer", part: "い".repeat(80), how: "結論から", next: null, from: "material" }], planNote: note, contractNote: "【本質】", leaks: [{ key: "main_point", missing: ["x", "y"] }], delivery: { rate: "3/5", subRate: "6/10" }, subs: ["focus.kind", "fact.value"] });
  assert.equal(w.rows[0].part!.length, 40);
  assert.equal(w.note.plan!.head.length, 200); assert.equal(w.note.plan!.len, note.length); assert.equal(w.note.plan!.fp, fingerprint(note));
  assert.deepEqual(w.leaks, [{ key: "main_point", missing: 2 }]);
  assert.deepEqual(w.delivery, { rate: "3/5", subRate: "6/10" });
  assert.deepEqual(w.subs, ["focus.kind", "fact.value"]);
  assert.equal(composePlanWatchOf({}).note.plan, null);
  assert.notEqual(fingerprint("a"), fingerprint("b"));
});

t("実例 12548 の形: 床の色・空室は資料にあった＝手元にあった", () => {
  const materials = "【物件の資料】サンプル荘 201号室／現況: 空室／床の色: 白系のフローリング／入居可能日: 即入居";
  const r = markOnHand(["床の色", "空室状況"], materials, false);
  assert.deepEqual(r.map((x) => [x.item, x.onHand, x.where]), [["床の色", true, "material"], ["空室状況", true, "material"]]);
  assert.equal(onHandDigest(r), "2/2");
});

t("実例 12838 の形: 送れる候補があった＝手元にあった（pickup_ready）・無い物は無い", () => {
  const r = markOnHand(["送れる候補の物件", "管理会社の回答"], "【会話】…", true);
  assert.deepEqual(r.map((x) => [x.onHand, x.where]), [[true, "pickup_ready"], [false, null]]);
  assert.equal(markOnHand(["送れる候補の物件"], "", false)[0].onHand, false);
  assert.equal(onHandDigest([]), null);
});

t("答案に残す欄に delivery_check・material_on_hand・material_missing", () => {
  for (const k of ["delivery_check", "material_on_hand", "material_missing"]) assert.ok((PLAN_KEYS as readonly string[]).includes(k), k);
});
console.log(`\n${n} 件 ok`);
