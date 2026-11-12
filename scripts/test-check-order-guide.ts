// scripts/test-check-order-guide.ts — 確かめる順番の材料（CHECK_ORDER_GUIDE 既定 off）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-check-order-guide.ts
// 実物: 本番の物差しの番（12189 条件の言い直し・11264 条件と物件・11408 結果が手元・12240 初回）と、竹内さんの198通のお礼の番・11/12 の通しの手本（名前・物件名は伏せた）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkOrderGuideOn, checkOrderGuideFor, preBrainCues, CHECK_STEP_GUIDE, GUIDE_WHY, GUIDE_FORBIDDEN_RE } from "../app/lib/check-order-guide";
import { CHECK_ORDER_TYPES, type CheckOrderCues } from "../app/lib/check-order";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off", () => {
  assert.equal(checkOrderGuideOn({}), false);
  assert.equal(checkOrderGuideOn({ CHECK_ORDER_GUIDE: "on" }), true);
});

t("全部の型に理由があり、渡す文に返信か AIX か・次の一手・申込・内覧・押すの言葉が無い", () => {
  for (const ty of CHECK_ORDER_TYPES) {
    assert.ok(GUIDE_WHY[ty.id], `理由が無い ${ty.id}`);
    assert.doesNotMatch(GUIDE_WHY[ty.id].why + GUIDE_WHY[ty.id].label, GUIDE_FORBIDDEN_RE, ty.id);
  }
  for (const v of Object.values(CHECK_STEP_GUIDE)) if (v) assert.doesNotMatch(v, GUIDE_FORBIDDEN_RE, v);
  // 全部の型を作ってみて、文に道の言葉が入らない
  const all: CheckOrderCues[] = [
    { conditionStated: true }, { hasQuestion: true, staffOnly: false }, { hasQuestion: true, staffOnly: true }, { customerSentProperty: true },
    { ackOnly: true }, { considering: true }, { hasQuestion: true, topic: "viewing" }, { hasQuestion: true, topic: "cost" }, { applySignal: true },
    { resultReady: true }, { firstContact: true }, { hooked: true, takenWorry: true },
  ];
  const seen = new Set<string>();
  for (const c of all) { const g = checkOrderGuideFor(c); assert.ok(g, JSON.stringify(c)); seen.add(g.type); assert.doesNotMatch(g.text, GUIDE_FORBIDDEN_RE, g.text); }
  assert.equal(seen.size, CHECK_ORDER_TYPES.length);
});

t("渡す段は道より前だけ（route・focus・aim・roles を渡さない）・最後は今と後を分ける段", () => {
  for (const c of [{ ackOnly: true }, { hooked: true, takenWorry: true }, { applySignal: true }] as CheckOrderCues[]) {
    const g = checkOrderGuideFor(c)!;
    for (const s of g.steps) assert.ok(!["route", "focus", "aim", "roles"].includes(s), `${g.type} ${s}`);
    assert.equal(g.steps[g.steps.length - 1], "now_vs_later");
  }
});

t("約束の後の『はい』（お礼・了承だけ）: まず言われた事 → 読みの候補 → こちらの開いている約束で何への了承か", () => {
  const cues = preBrainCues({ scene: "ack", customerText: "はい！お願いします！", pickupPromisedUnfulfilled: true, pickupReady: false });
  const g = checkOrderGuideFor(cues)!;
  assert.equal(g.type, "T5_ack_hypothesis");
  assert.deepEqual(g.steps.slice(0, 3), ["read_ask", "hypothesize", "our_last_send"]);
  assert.match(g.text, /開いている約束が複数ならどれへの了承か/);
});

t("本番 12189 の形（条件の言い直し）: 条件の型", () => {
  const g = checkOrderGuideFor(preBrainCues({ scene: "conditions", customerText: "家賃7万円以内でお願いします", pickupPromisedUnfulfilled: true }))!;
  assert.equal(g.type, "T1_conditions_first");
});

t("本番 11264 の形（条件と一緒に物件）: 物件が届いた型で読みの候補の段がある", () => {
  const g = checkOrderGuideFor(preBrainCues({ scene: "property_share", customerText: "こちらの物件のような条件でお願いします https://suumo.jp/x", hasImageOrUrl: true }))!;
  assert.equal(g.type, "T4_property_shared");
  assert.ok(g.steps.includes("hypothesize"));
});

t("本番 11408 の形（ピックアップの約束が開いていて送れる物件が揃った）: 結果が手元の型", () => {
  assert.equal(checkOrderGuideFor(preBrainCues({ scene: "other", customerText: "その後どうですか？", pickupPromisedUnfulfilled: true, pickupReady: true }))!.type, "T10_result_ready");
});

t("11/12 の通しの手本（刺さっている×取られる不安）: T12", () => {
  const g = checkOrderGuideFor(preBrainCues({ scene: "considering", customerText: "〇〇マンションの502号室かなり気に入っています！けど他にもっと合う部屋があるかも。でも取られるのが不安です" }))!;
  assert.equal(g.type, "T12_hooked_comparing_taken");
  assert.doesNotMatch(g.text, GUIDE_FORBIDDEN_RE);
});

t("brain-core の配線: off の時は何も足さない（材料の1行は on の時だけ・meta は記録だけ）", () => {
  const src = readFileSync(join(__dirname, "..", "app", "lib", "brain-core.ts"), "utf8");
  assert.ok(src.includes("if (checkOrderGuideOn() && !isPostApplyStatus(convStatus)) {"));
  assert.ok(src.includes("check_order_guide: checkOrderGuideRec ?? undefined,"));
  // 静的な system（キャッシュ）には入れない＝STATIC_BRAIN_SYSTEM の中に名前が出ない
  const st = src.indexOf("export const STATIC_BRAIN_SYSTEM"), en = src.indexOf("export type BrainSystemBlock");
  assert.ok(!src.slice(st, en).includes("checkOrderGuide"));
});

console.log(`全部 ${n} 件 ok`);
