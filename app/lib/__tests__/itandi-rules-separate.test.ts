/**
 * ITANDI の手順書をリアプロと混ぜない仕組みの試験（2026-11-27 竹内さん「itandiはちゃんとリアプロとわけてつくる」
 * 「いまもitandiのデータもともとのあるのちゃんと活用する」「リアプロと混ざらないようにちゃんと整理して仕組みつくっておく」）
 *   1. ITANDI の決まりは ITANDI だけの一覧（id がリアプロの決まりと重ならない・文にリアプロの手が無い）
 *   2. 決まりの目印（marker）が本物の ITANDI の拡張コードにある（無ければ止まる）
 *   3. 目印が消えた／リアプロの id と重なった時は、点検が必ず止める（checkItandiRulesInCode）
 *   4. 決まりの版は サイトごと（ITANDI の版 ≠ リアプロの版・未指定はリアプロ）
 *   5. ITANDI の押す順番（itandi_flow）は site_flow.itandi だけから作る（リアプロの site_flow は読まない）
 *   6. 束の next は「次のページ送り」と言わない（押す順番の数として出す）
 *   7. ITANDI の手順書の抜けは、古い「決まりは まだ作っていない」文を出さない
 * 実行: npx tsx app/lib/__tests__/itandi-rules-separate.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTO_RULES, autoRulesVersion } from "../auto-procedure-rules";
import { ITANDI_AUTO_RULES, checkItandiRulesInCode, itandiRulesVersion, rulesVersionFor } from "../auto-itandi-rules";
import { buildPlaybook, checkPlaybook } from "../action-playbook";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail === undefined ? "" : "\n      " + JSON.stringify(detail))); }
}

const ROOT = process.cwd();
const readExt = (f: string) => fs.readFileSync(path.join(ROOT, "chrome-extension", f), "utf8");
const REAL_FILES = { itandiPage: readExt("itandi-page-script.js"), itandiBulk: readExt("itandi-bulk-dl.js") };
const REALPRO_HAND = /印刷用PDF|並べ替え|高→低|span\.sort_detail|幅160|ペット|page-script/;

console.log("■ 1. ITANDI の決まりは ITANDI だけの一覧");
{
  const ids = ITANDI_AUTO_RULES.map((r) => r.id);
  ok("ITANDI の決まりが1件以上ある", ids.length > 0, ids.length);
  ok("ITANDI の決まりの id が重ならない", new Set(ids).size === ids.length, ids);
  const realproIds = new Set(AUTO_RULES.map((r) => r.id));
  ok("ITANDI の決まりの id がリアプロの決まりと重ならない", ids.every((id) => !realproIds.has(id)), ids.filter((id) => realproIds.has(id)));
  const badText = ITANDI_AUTO_RULES.filter((r) => REALPRO_HAND.test(r.text)).map((r) => r.id);
  ok("ITANDI の決まりの文にリアプロの手（並べ替え・PDF・幅160・ペット）が無い", badText.length === 0, badText);
  ok("ITANDI の決まりは拡張の ITANDI のファイルだけを見る", ITANDI_AUTO_RULES.every((r) => r.file === "itandi-page-script.js" || r.file === "itandi-bulk-dl.js"));
}

console.log("■ 2. 目印が本物の ITANDI の拡張コードにある");
{
  const issues = checkItandiRulesInCode(REAL_FILES);
  ok("実物の ITANDI の拡張で目印の食い違いは無い", issues.length === 0, issues);
}

console.log("■ 3. 目印が消えた・id が混ざった時は止まる");
{
  const gone = checkItandiRulesInCode({ itandiPage: "", itandiBulk: "" });
  ok("目印が無い（ファイルが空）と止まる", gone.some((m) => /目印が .* に無い/.test(m)), gone);
  const mixed = checkItandiRulesInCode(REAL_FILES, [{ ...ITANDI_AUTO_RULES[0], id: AUTO_RULES[0].id }]);
  ok("リアプロの id と重なると止まる（混ざり）", mixed.some((m) => /混ざり/.test(m)), mixed);
  const noReason = checkItandiRulesInCode(REAL_FILES, [{ ...ITANDI_AUTO_RULES[0], verify_reason: "" }]);
  ok("確かめる段が無い理由が空だと止まる", noReason.some((m) => /理由/.test(m)), noReason);
}

console.log("■ 4. 決まりの版はサイトごと");
{
  ok("ITANDI の版 ≠ リアプロの版", itandiRulesVersion() !== autoRulesVersion());
  ok("rulesVersionFor('itandi') は ITANDI の版", rulesVersionFor("itandi") === itandiRulesVersion());
  ok("rulesVersionFor('realpro') はリアプロの版", rulesVersionFor("realpro") === autoRulesVersion());
  ok("rulesVersionFor(未指定) はリアプロの版（従来どおり）", rulesVersionFor(undefined) === autoRulesVersion());
  const pbIt = buildPlaybook({ points: {}, opens: {}, scene_flows: [] } as never, "itandi");
  ok("itandi の手順書の rules_v は ITANDI の版", pbIt.rules_v === itandiRulesVersion());
  const pbRp = buildPlaybook({ points: {}, opens: {}, scene_flows: [] } as never, "realpro");
  ok("realpro の手順書の rules_v はリアプロの版", pbRp.rules_v === autoRulesVersion());
}

console.log("■ 5. ITANDI の押す順番は site_flow.itandi だけから");
{
  const bundle = {
    points: {}, opens: {}, scene_flows: [], generated_at: new Date().toISOString(),
    site_flow: {
      realpro: [{ n: 9, from: "所在地｜a", to: "沿線｜b" }],
      itandi: [{ n: 2, from: "左のリスト検索｜button.x", to: "左の路線・駅で絞り込み｜div.y" }],
    },
  } as never;
  const it = buildPlaybook(bundle, "itandi");
  ok("itandi の押す順番は itandi のキーの分だけ（realpro の 9 を読まない）", it.itandi_flow.length === 1 && it.itandi_flow[0].n === 2, it.itandi_flow);
  ok("押す順番の名前は ｜ より前（表記の揺れを減らす）", it.itandi_flow[0]?.from === "左のリスト検索" && it.itandi_flow[0]?.to === "左の路線・駅で絞り込み", it.itandi_flow);
  const rp = buildPlaybook(bundle, "realpro");
  ok("realpro の手順書には itandi の押す順番を入れない", rp.itandi_flow.length === 0, rp.itandi_flow);
  const onlyRp = buildPlaybook({ points: {}, opens: {}, scene_flows: [], site_flow: { realpro: [{ n: 9, from: "x", to: "y" }] } } as never, "itandi");
  ok("itandi で itandi の流れが無い時は realpro の流れで埋めない", onlyRp.itandi_flow.length === 0, onlyRp.itandi_flow);
  ok("itandi の押す順番が無い時は gaps に出す", onlyRp.gaps.some((g) => /ITANDI の押す順番（site_flow.itandi）がまだ無い/.test(g)), onlyRp.gaps);
}

console.log("■ 6. 束の next は『次のページ』と言わない");
{
  const pb = buildPlaybook({ points: {}, opens: {}, scene_flows: [], next: { "a｜b": { n: 2, next: "c｜d", total: 2 } } } as never, "itandi");
  ok("束の next の件数は next_n に入る", pb.next_n === 1, pb.next_n);
  ok("『次のページへ：束の next』という古い文を出さない", !pb.gaps.some((g) => /次のページへ：束の next/.test(g)), pb.gaps);
  ok("次のページ送りは場面 next で判定し、押す順番とは言い分ける", pb.gaps.some((g) => /次のページ送り（場面 next）はまだ学んでいない（束の next は押す順番の1件/.test(g)), pb.gaps);
}

console.log("■ 7. ITANDI の抜けは決まりの一覧に合わせる（古い文を出さない）");
{
  const pb = buildPlaybook({ points: {}, opens: {}, scene_flows: [] } as never, "itandi");
  ok("『itandi の決まりはまだ作っていない』を出さない", !pb.gaps.some((g) => /まだ作っていない/.test(g)), pb.gaps);
  ok("ITANDI の決まりは確かめられない抜けとして1つ出る", pb.gaps.some((g) => /itandi の自動の決まり \d+件は、点検の段がまだ保存されず確かめられない/.test(g)), pb.gaps);
  const issues = checkPlaybook(pb, Date.now());
  ok("点検は ITANDI の決まりを通す（決まりが空だと止まる）", !issues.some((i) => /自動の決まりが手順書に入っていない|自動の決まりの版が古い/.test(i)), issues);
  ok("ITANDI の手順書の決まりは ITANDI の一覧と同じ数", pb.rules.length === ITANDI_AUTO_RULES.length, pb.rules.length);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} itandi-rules-separate: ${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
