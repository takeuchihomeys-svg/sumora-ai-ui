/**
 * 写真学習の「3つの罠」を固定するテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「通常モードの録画でもちゃんと学習できるように 足りない部分強化できるように
 *     通常モードと自動モード繰りかえしていくようにして学習する」
 *
 * ★ 実測で踏んだ罠（すべて「気づきにくい」物）
 *   ① `findShotsToLearn` が `shot_w` を返していなかった
 *      → 呼ぶ側が `0px×186` と表示し、「読める大きさだけ読む」判定もできなかった。
 *   ② `generated_at` 列が存在しないのに insert していた
 *      → `Could not find the 'generated_at' column` で**束が作れなかった**（学習は成功なのに反映されない）。
 *   ③ 大きい順に `limit` 件取ると、**学習済みが枠を埋めて未学習が1件も入らない**
 *      → 未学習が742枚あるのに「読む物がありません」と表示された。
 *
 * 実行: npx tsx app/lib/__tests__/shot-learn-traps.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

const src = readFileSync(join(__dirname, "../shot-learn-server.ts"), "utf8");
const route = readFileSync(join(__dirname, "../../api/human-learn-profile/route.ts"), "utf8");

console.log("■ ① shot_w を返す（大きさが分かる）");
{
  ok("戻り値の型に shot_w がある", /shot_w: number \}>/.test(src) || /shot_w:\s*number/.test(src));
  ok("SELECT に shot_w がある", /select\("id, shot_key, site, mode, shot_w/.test(src));
  ok("map で shot_w を渡す", /shot_w: Number\(r\.shot_w\)/.test(src));
  ok("返す時に shot_w を入れる", /shot_w: r\.shot_w/.test(src));
}

console.log("\n■ ② 読めない大きさを読まない・同じ画面は1枚");
{
  ok("480px 未満を除く", /shot_w >= 800/.test(src));
  ok("大きい順に並べる", /sort\(\(a, b\) => b\.shot_w - a\.shot_w\)/.test(src));
  ok("同じ画面は1枚（seen）", /const seen = new Map<string, number>\(\)/.test(src));
}

console.log("\n■ ③ 未学習だけをDBで絞る（学習済みが枠を埋めない）");
{
  ok("⚠ shot_learn IS NULL で絞る", /\.is\("shot_learn", null\)/.test(src));
  ok("多めに取る（limit の4倍）", /\(opt\.limit \?\? 200\) \* 4/.test(src));
  ok("実測の失敗（742枚あるのに0件）を残している", /742|読む物がありません/.test(src));
}

console.log("\n■ ④ generated_at を送らない（束が作れる）");
{
  const ins = (source: string) => {
    const i = source.indexOf("human_learn_profile\").insert");
    return i < 0 ? "" : source.slice(i, i + 400);
  };
  const a = ins(src);
  const b = ins(route);
  ok("学習側で generated_at を送っていない", a.length > 0 && !/generated_at:/.test(a), a.slice(0, 200));
  ok("API側でも generated_at を送っていない", b.length > 0 && !/generated_at:/.test(b), b.slice(0, 200));
  ok("存在しない列の説明を残している", /generated_at.*列は\*\*存在しない\*\*/.test(src) || /generated_at.*存在しない/.test(src));
  ok("created_at は自動で入ると書いてある", /created_at.*自動/.test(src));
}

console.log("\n■ ⑤ 束の作り直しが自動で走る");
{
  ok("学習の後に作り直す", /out\.saved > 0 && !opt\.noRefresh/.test(src));
  ok("--no-refresh で止められる", /noRefresh/.test(src));
  ok("作り直したかを返す", /out\.refreshed/.test(src));
}

console.log("\n■ ⑥ 3つの罠をコメントで残している");
{
  ok("shot_w を返していなかったと書いてある", /shot_w を\*\*返していなかった\*\*/.test(src) || /shot_w.*返していなかった/.test(src));
  ok("学習済みが枠を埋めると書いてある", /学習済み.*枠を埋め/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
