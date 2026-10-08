// 2026-10-08 9巡目（竹内さん「段1を YUMA のテストだけで切り替えられるように」）: 学習ルールの見直しの重ね（rules-overlay.ts）の回帰テスト。
//   実行: npx tsx app/lib/__tests__/rules-overlay.test.ts
import {
  buildR9Overlay, applyRulesOverlay, overlayExtraLimit, parseRulesR9Flag, resolveTestRulesOverlay,
  runInRulesOverlayScope, runWithRulesOverlay, setRulesOverlay, currentRulesOverlay,
} from "../rules-overlay";
import { RULES_REVIEW_R9 } from "../rules-review-r9";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

async function main() {
  // 旗
  t("旗: off/on/stage2 だけ読む", parseRulesR9Flag("on") === "on" && parseRulesR9Flag("stage2") === "stage2" && parseRulesR9Flag("off") === "off" && parseRulesR9Flag("x") === null && parseRulesR9Flag(true) === null);
  t("旗: off は重ねなし（今の DB のまま）", buildR9Overlay("off") === null);

  // 一覧から作る
  const s1 = buildR9Overlay("on")!;
  const s2 = buildR9Overlay("stage2")!;
  const st1 = RULES_REVIEW_R9.filter((d) => (d.stage ?? 1) === 1);
  const st2 = RULES_REVIEW_R9.filter((d) => d.stage === 2);
  t("段1: 段1の無効を全部含み、段2の無効を含まない", st1.filter((d) => d.verdict === "retire").every((d) => s1.retireKeys.has(d.key)) && st2.every((d) => d.verdict !== "retire" || !s1.retireKeys.has(d.key)));
  t("段1: 無効 239・書き換え 61（10/08 の一覧）", s1.retireKeys.size === 239 && Object.keys(s1.textOverrides).length === 61);
  t("段2: 段1＋段2の無効（239＋137）", s2.retireKeys.size === 239 + 137 && Object.keys(s2.textOverrides).length === 61);
  t("ask（竹内さんに聞く）は入れない", RULES_REVIEW_R9.filter((d) => d.verdict === "ask").every((d) => !s2.retireKeys.has(d.key) && !(d.key in s2.textOverrides)));
  t("書き換えの文は一覧の newText そのまま", st1.filter((d) => d.verdict === "edit").every((d) => s1.textOverrides[d.key] === d.newText));
  t("多めに読む本数＝無効の本数", overlayExtraLimit(s1) === 239 && overlayExtraLimit(null) === 0);

  // 当てる（純関数）
  const ov = { label: "t", retireKeys: new Set(["B", "D"]), textOverrides: { C: "新しいC" } };
  const rows = ["A", "B", "C", "D", "E", "F"].map((k) => ({ rule_key: k, rule_text: `旧${k}` }));
  t("当てる: 無効を外し書き換えを差し替える", JSON.stringify(applyRulesOverlay(rows, ov).map((r) => r.rule_text)) === JSON.stringify(["旧A", "新しいC", "旧E", "旧F"]));
  t("当てる: 上限で切る＝SQL で外した後の先頭 N 件と同じ（空いた枠に次が入る）", JSON.stringify(applyRulesOverlay(rows, ov, 3).map((r) => r.rule_key)) === JSON.stringify(["A", "C", "E"]));
  t("当てる: 重ねなしは並び・件数そのまま", applyRulesOverlay(rows, null).length === 6 && applyRulesOverlay(rows, null, 2).length === 2);
  t("当てる: rule_key の無い行は残す", applyRulesOverlay([{ rule_text: "x" }], ov).length === 1);
  t("当てる: 元の行を書き換えない", rows[2].rule_text === "旧C");

  // テストの会話・本番でない環境だけ
  t("決め: テストの会話でない時は重ねなし", resolveTestRulesOverlay("on", false, {}) === null);
  t("決め: 本番の環境（VERCEL_ENV あり）は重ねなし", resolveTestRulesOverlay("on", true, { VERCEL_ENV: "production" }) === null);
  t("決め: テストの会話・手元・on → 段1", resolveTestRulesOverlay("on", true, {})?.label === "r9-on");
  t("決め: off → null", resolveTestRulesOverlay("off", true, {}) === null);

  // 箱（AsyncLocalStorage）
  t("箱: 外では null・set しても何もしない", (() => { setRulesOverlay(s1); return currentRulesOverlay() === null; })());
  const seen = await runInRulesOverlayScope(async () => {
    const before = currentRulesOverlay();
    setRulesOverlay(s1);
    await new Promise((r) => setTimeout(r, 5));
    const after = await Promise.all([1, 2].map(async () => { await new Promise((r) => setTimeout(r, 1)); return currentRulesOverlay()?.label; }));
    return { before, after };
  });
  t("箱: 開けた直後は null・置いた後は await を越えて見える", seen.before === null && seen.after.every((x) => x === "r9-on"));
  t("箱: 閉じた後に外へ漏れない", currentRulesOverlay() === null);
  const par = await Promise.all([
    runWithRulesOverlay(s1, async () => { await new Promise((r) => setTimeout(r, 10)); return currentRulesOverlay()?.label; }),
    runWithRulesOverlay(null, async () => { await new Promise((r) => setTimeout(r, 5)); return currentRulesOverlay()?.label ?? "none"; }),
    runWithRulesOverlay(s2, async () => currentRulesOverlay()?.label),
  ]);
  t("箱: 同時に走る3つが混ざらない（off/on/stage2）", JSON.stringify(par) === JSON.stringify(["r9-on", "none", "r9-stage2"]));

  console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
}
main();
