/**
 * 廃止された手順（1つずつ外す）が通常の手順に残っていないか（B）・古い決まりの食い違い（D）・骨組みが決まりの id を指すか（C）
 * 2026-11-26 竹内さん「改善の際に手順書のずれを確認して細かく改善する仕組みを強く」
 * npx tsx app/lib/__tests__/playbook-retired-phrases.test.ts
 */
import { AUTO_RULES } from "../auto-procedure-rules";
import {
  PLAYBOOK_EXTRA_GUIDES,
  PLAYBOOK_FLOW_SERIES,
  PLAYBOOK_LIST_AD_SORT_STEPS,
  PLAYBOOK_SEARCH_GRASP_STEPS,
  PLAYBOOK_AREA_CONFIRM_STEPS,
  PLAYBOOK_COND_GUIDE_STEPS,
} from "../action-playbook";
import { retiredPhraseIssues, driftFlags, cmpVer } from "../playbook-retired";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// B: 本物の決まり・骨組みに、保険と断らない「1つずつ外す」が残っていない
{
  const items: { where: string; text: string }[] = [];
  for (const r of AUTO_RULES) items.push({ where: "決まり " + r.id, text: r.text });
  for (const g of PLAYBOOK_EXTRA_GUIDES) g.steps.forEach((s, i) => items.push({ where: "場面なし " + g.id + " ①" + (i + 1), text: s }));
  for (const p of PLAYBOOK_FLOW_SERIES) items.push({ where: "一連 " + p.id, text: p.label });
  const sets: Array<[string, ReadonlyArray<string>]> = [
    ["一覧", PLAYBOOK_LIST_AD_SORT_STEPS],
    ["検索", PLAYBOOK_SEARCH_GRASP_STEPS],
    ["所在地", PLAYBOOK_AREA_CONFIRM_STEPS],
    ["条件", PLAYBOOK_COND_GUIDE_STEPS],
  ];
  for (const [name, steps] of sets) steps.forEach((s, i) => items.push({ where: name + " ①" + (i + 1), text: s }));
  const issues = retiredPhraseIssues(items);
  assert(issues.length === 0, "廃止された手順が通常の手順に残っている:\n" + issues.join("\n"));
  console.log("  ✓ B: 決まり " + AUTO_RULES.length + "・骨組み " + items.length + " 件に、保険と断らない1つずつ外すは無い");
}

// B の試験そのものが効くか（古い文は落ちる・保険と断れば通る・貼り足しの断りは落ちる）
{
  const old = "箱を開ける → 1つずつカーソルで外す → 確定 → 次の箱";
  assert(retiredPhraseIssues([{ where: "x", text: old }]).length === 1, "古い文は1件で落ちる");
  const ok = "最後の保険（リセットが押せない時だけ）で外す時は、箱を開ける → 1つずつカーソルで外す → 確定";
  assert(retiredPhraseIssues([{ where: "x", text: ok }]).length === 0, "保険と断れば通る");
  const neg = "1つずつ外さない・箱ごとに開けて外す手は使わない";
  assert(retiredPhraseIssues([{ where: "x", text: neg }]).length === 0, "否定の文は通る");
  const prefix = "【リセットで空と確かめられた回は…。以下は、リセットが押せない・空にならない時の代わりの手順】外しは同時に1つだけ";
  assert(retiredPhraseIssues([{ where: "x", text: prefix }]).some((s) => /後付けの断り/.test(s)), "貼り足しの断りは落ちる");
  console.log("  ✓ B: 試験の自己点検（古い文・保険・否定・貼り足し）");
}

// D: 新しい決まり（リセット 2.8.305）より古い外しの決まりで、リセットに触れない物が無い
{
  const flags = driftFlags(AUTO_RULES);
  assert(flags.length === 0, "食い違いの疑い:\n" + flags.join("\n"));
  const oldStyle = [{ id: "old_clear", scene: "clear", since: "2.8.147", text: "前のお客さんの間取りは箱を開ける → 1つずつカーソルで外す" }];
  assert(driftFlags(oldStyle).length === 1, "リセットに触れない古い外しは出る（自己点検）");
  const fresh = [{ id: "new_clear", scene: "clear", since: "2.8.147", text: "リセットで空にする。保険で1つずつ外す" }];
  assert(driftFlags(fresh).length === 0, "リセットに触れていれば出ない（自己点検）");
  console.log("  ✓ D: 古い外しの食い違い 0 件（自己点検 2 件も通る）");
}

// C: 骨組みが指す決まりの id は、実在する決まりだけ
{
  const ids = new Set(AUTO_RULES.map((r) => r.id));
  for (const g of PLAYBOOK_EXTRA_GUIDES) {
    for (const rid of g.rules) assert(ids.has(rid), "骨組み " + g.id + " が存在しない決まりを指す: " + rid);
  }
  const clear = PLAYBOOK_EXTRA_GUIDES.find((g) => g.id === "clear")!;
  assert(!clear.rules.includes("clear_one_by_one") && !clear.rules.includes("clear_per_panel"), "clear の骨組みに1つずつ外しの決まりを載せない");
  console.log("  ✓ C: 骨組みの決まり参照はすべて実在");
}

// 版の大小
assert(cmpVer("2.8.147", "2.8.305") < 0 && cmpVer("2.8.305", "2.8.305") === 0 && cmpVer("2.10.0", "2.9.9") > 0, "cmpVer");
console.log("playbook-retired-phrases.test OK");
