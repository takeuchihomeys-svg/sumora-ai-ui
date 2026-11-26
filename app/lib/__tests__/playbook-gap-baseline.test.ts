/**
 * 手順書の抜け（gaps）を「増えたら止める」仕組みの試験（2026-11-27 竹内さん「抜けのない仕組み」）。
 *   1. 文の型（gapKey）: 件数・（…）の中身・数字の違いで誤報を出さない
 *   2. diffGaps: 基準に無い新しい抜けだけを added に出す（直った物は removed）
 *   3. 確かめ方の無い決まりは、理由つきの例外（RULES_CODE_ONLY）に必ず入っている
 *      （新しい決まりを足した時に確かめ方も理由も無ければ、ここで止まる）
 *   4. 例外の一覧に古い物（消えた決まり・確かめ方が後から付いた決まり）が残っていない
 *   5. 基準ファイル（memory/playbook_gaps_baseline.json）が読めて、サイトごとの形をしている
 * 実行: npx tsx app/lib/__tests__/playbook-gap-baseline.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTO_RULES, RULES_CODE_ONLY } from "../auto-procedure-rules";
import { buildPlaybook } from "../action-playbook";
import { gapKey, diffGaps, type GapBaseline } from "../playbook-gap-baseline";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail === undefined ? "" : "\n      " + JSON.stringify(detail))); }
}

console.log("■ 1. 文の型（件数・（…）の中身を外す）");
{
  ok("件数だけ違う抜けは同じ型", gapKey("開く欄 18件は推測のまま") === gapKey("開く欄 3件は推測のまま"), [gapKey("開く欄 18件は推測のまま"), gapKey("開く欄 3件は推測のまま")]);
  ok("（…）の中の欄名が違っても同じ型", gapKey("所在地：押す位置の票が3回未満の手 2件（所在地絞り込みを開く）") === gapKey("所在地：押す位置の票が3回未満の手 1件（別の手）"), gapKey("所在地：押す位置の票が3回未満の手 2件（所在地絞り込みを開く）"));
  ok("別の抜け（場面が違う）は別の型", gapKey("条件：押す位置を学んでいない手 3件") !== gapKey("所在地：押す位置を学んでいない手 3件"));
}

console.log("■ 2. diffGaps（基準に無い新しい抜けだけを増えたと出す）");
{
  const base = ["開く欄 #件は推測のまま", "まだ学んでいない場面：所在地絞り込み"];
  const cur = ["開く欄 20件は推測のまま", "まだ学んでいない場面：所在地絞り込み", "新しい抜け 1件（テスト）"];
  const d = diffGaps(cur, base);
  ok("基準どおりの抜けは kept に数える（件数の違いでは増えない）", d.kept === 2, d);
  ok("基準に無い抜けだけ added に出る", d.added.length === 1 && d.added[0].startsWith("新しい抜け"), d.added);
  const d2 = diffGaps([], base);
  ok("消えた抜けは removed に出る（直った合図）", d2.removed.length === 2 && d2.added.length === 0, d2);
  const d3 = diffGaps(["同じ抜け 1件", "同じ抜け 2件"], ["同じ抜け #件"]);
  ok("同じ型が2回出ても added に重複しない（件数の差）", d3.added.length === 0 && d3.kept === 1, d3);
}

console.log("■ 3. 確かめ方の無い決まりは理由つきの例外に入っている");
{
  const noVerify = AUTO_RULES.filter((r) => !r.verify).map((r) => r.id);
  const unexplained = noVerify.filter((id) => !RULES_CODE_ONLY[id]);
  ok(`確かめ方が無く理由も無い決まりが0件（対象 ${noVerify.length}件）`, unexplained.length === 0, unexplained);
  const emptyReason = Object.entries(RULES_CODE_ONLY).filter(([, why]) => String(why ?? "").trim().length < 10).map(([id]) => id);
  ok("例外の理由がどれも一言以上ある", emptyReason.length === 0, emptyReason);
}

console.log("■ 4. 例外の一覧に古い物が無い");
{
  const ids = new Set(AUTO_RULES.map((r) => r.id));
  const gone = Object.keys(RULES_CODE_ONLY).filter((id) => !ids.has(id));
  ok("例外の決まりが今の一覧に存在する（消えた決まりを残さない）", gone.length === 0, gone);
  const nowVerified = Object.keys(RULES_CODE_ONLY).filter((id) => AUTO_RULES.find((r) => r.id === id)?.verify);
  ok("例外の決まりに確かめ方（verify）が後から付いたら例外を外す", nowVerified.length === 0, nowVerified);
}

console.log("■ 5. 手順書の抜け一覧に、理由つきの例外が『確かめる印が無い』として出ない");
{
  const pb = buildPlaybook({} as never, "realpro");
  const leak = (pb.gaps ?? []).filter((g) => g.includes("点検記録で確かめる印が無い"));
  ok("realpro の抜け一覧に確かめる印の抜けが出ない（例外は理由つき）", leak.length === 0, leak);
}

console.log("■ 6. 基準ファイル（memory/playbook_gaps_baseline.json）");
{
  const f = path.join(process.cwd(), "memory", "playbook_gaps_baseline.json");
  let base: GapBaseline | null = null;
  try { base = JSON.parse(fs.readFileSync(f, "utf8")) as GapBaseline; } catch { base = null; }
  ok("基準ファイルが読める", !!base, f);
  ok("サイトごとに配列（realpro・itandi）", !!base && Array.isArray(base.sites?.realpro) && Array.isArray(base.sites?.itandi), base);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
