// scripts/test-priority-table.ts — 場面×状態ごとの優先度の表（PRIORITY_TABLE 既定 off）のテスト（LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-priority-table.ts
// 実例5番（前＝今のブレインの下書き・後＝表の行。名前と物件名は伏せた）: 12548・12362・11865・12196・12643
import assert from "node:assert/strict";
import { PRIORITY_ROWS, priorityRowFor, priorityDigest, whyOrderLine, priorityTableOn } from "../app/lib/priority-table";
import { PRIORITY_KINDS, DEPTH_KINDS } from "../app/lib/judge-basis-types";
import { CHECK_ORDER_TYPES } from "../app/lib/check-order";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off（shadow・on で有効）", () => {
  assert.equal(priorityTableOn({}), false);
  assert.equal(priorityTableOn({ PRIORITY_TABLE: "shadow" }), true);
});

t("どの行も6つの欄となぜの札を持ち、名前は1か所の語彙（Priority・BasisDepth・型 id）", () => {
  const types = new Set(CHECK_ORDER_TYPES.map((x) => x.id));
  for (const r of PRIORITY_ROWS) {
    assert.ok(types.has(r.type), r.type);
    assert.ok((PRIORITY_KINDS as readonly string[]).includes(r.first.need), r.first.need);
    assert.ok((DEPTH_KINDS as readonly string[]).includes(r.checks.depth));
    assert.ok(r.first.why.length > 10 && r.order.main && r.checks.steps.length && r.nowLater.length && r.combo && r.tags.length, r.state);
    // 確かめる段は道より前の段だけ（route・focus・aim・roles を持たない）
    for (const s of r.checks.steps) assert.ok(!["route", "focus", "aim", "roles"].includes(s), `${r.state} ${s}`);
  }
});

// 実例5番: 前（今のブレインの下書きの形）と後（表の行）
t("12548（4つの問い）: 前＝入居日が先で、空き・色は確認の約束に倒れた／後＝物件の中身の問いが先・答えの出所で分け・白基調の別物件は AIX", () => {
  const before = { first: "入居日", deferredToPromise: ["白フローリング", "603以外の空室"] };
  const r = priorityRowFor("T2_question_fact", "問いが複数")!;
  assert.match(r.order.main, /空いている部屋・色/);
  assert.notEqual(before.first, "空いている部屋・色");
  assert.ok(r.nowLater.find((p) => p.part.includes("空いている"))?.thisTurn === "answer");
  assert.equal(r.combo, "reply_then_aix_quick");
});

t("12362（抑えられる部屋）: 前＝202の答えだけ／後＝同じ通で他の号室は2番手以降・202も取られる可能性まで", () => {
  const r = priorityRowFor("T12_hooked_comparing_taken")!;
  assert.ok(r.order.subs.some((s) => /2番手/.test(s)) && r.order.subs.some((s) => /取られ|申込が入る/.test(s)));
});

t("11865（おとり物件か）: 前＝約束が先・答えが後／後＝答えが先・約束は後の通（reply_reply）", () => {
  const r = priorityRowFor("T2_question_fact", "こちらの送信への問い返し")!;
  assert.equal(r.first.need, "answer");
  assert.equal(r.combo, "reply_reply");
  assert.ok(r.order.deferred.some((d) => /ピックアップ/.test(d.what)));
});

t("12196（外す）: 前＝言っていない条件（白基調・リフォーム済み）を足した／後＝やらない事に入れる", () => {
  const r = priorityRowFor("T1_conditions_first")!;
  assert.ok(r.avoid.no_touch.some((x) => /言っていない条件/.test(x)));
});

t("12643（鍵交換）: 言える部分（必須か）を答え、外せるかは確かめる約束（両にらみにしない）", () => {
  const r = priorityRowFor("T8_cost")!;
  assert.deepEqual(r.nowLater.map((p) => p.thisTurn), ["answer", "promise"]);
});

t("記録の印と why_order の1行", () => {
  const r = priorityRowFor("T2_question_fact", "問いが複数")!;
  assert.equal(priorityDigest(r), "first=answer|combo=reply_then_aix_quick|defer=1|depth=deep");
  assert.match(whyOrderLine(r) ?? "", /^先に: /);
  assert.equal(priorityRowFor("T99"), null);
  assert.equal(priorityDigest(null), null);
});

console.log(`全部 ${n} 件 ok`);
