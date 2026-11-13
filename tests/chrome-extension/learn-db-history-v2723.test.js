// 実行: node tests/chrome-extension/learn-db-history-v2723.test.js
// 2026-11-13 竹内さん「これ学習したところはデータベースに保管されるようになっているのか
//   データベースを学習面でも強化していくようにする形とする」
//
//   ① 保管できたかを**返す**（旧は失敗しても黙って捨てていた）
//   ② **入れてから**古い物を消す（旧は消してから入れるので、失敗すると前の束も消えた）
//   ③ **履歴を残す**（何を学んだかの推移を見られる・100件まで）
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); }
}

const prof = read("app/api/human-learn-profile/route.ts");
const cron = read("app/api/cron/human-learn-brain/route.ts");

console.log("■ ① 保管できたかを返す（黙って捨てない）");
{
  ok("saved_to_db を返す", /saved_to_db: \(fresh as unknown as Record<string, unknown>\)\.saved_to_db === true/.test(prof));
  ok("保存できたかの印を持つ（saved）", /let saved = false;/.test(prof) && /saved = true;/.test(prof));
  ok("失敗したら理由を持つ（save_error）", /let saveError: string \| null = null;/.test(prof) && /save_error:/.test(prof));
  ok("  コンソールにも残す", /束を残せません/.test(prof));
  ok("insert の error を見る（旧は見ていなかった）", /if \(ins\.error\) \{/.test(prof));
}

console.log("\n■ ② 入れてから消す（失敗しても前の束が残る）");
{
  const seg = prof.slice(prof.indexOf("// DB にも残す"), prof.indexOf("return bundle;") + 20);
  const insPos = seg.indexOf(".insert(");
  const delPos = seg.indexOf(".delete()");
  ok("insert が先（消すのが後）", insPos > 0 && delPos > insPos, { insPos, delPos });
  ok("  ⚠ 旧の「消してから入れる」になっていない", !/delete\(\)[\s\S]{0,200}insert\(/.test(seg));
  ok("  消すのは「入れた1秒より前」だけ（今入れた物は残す）", /Date\.now\(\) - 1000/.test(prof));
}

console.log("\n■ ③ 履歴を残す（学習の推移を見られる）");
{
  ok("?history=1 で履歴を返す", /history.*=== "1"/.test(prof) || /get\("history"\) === "1"/.test(prof));
  ok("  新しい順・上限つき（1〜100）", /order\("created_at", \{ ascending: false \}\)/.test(prof) && /Math\.min\(Math\.max\(Number\(req\.nextUrl\.searchParams\.get\("limit"\) \?\? 20\) \|\| 20, 1\), 100\)/.test(prof));
  ok("  何件から学んだか・いつを返す", /source_rows: x\.source_rows/.test(prof) && /created_at: x\.created_at/.test(prof));
  ok("  学んだ中身（lines）も返す", /lines: x\.lines \?\? \[\]/.test(prof));
  ok("cron も履歴を消さない（直近100件を残す）", /range\(100, 200\)/.test(cron));
  ok("  cron も「入れてから消す」", (() => {
    const i = cron.indexOf("const { error: insErr } = await supabase.from(\"human_learn_profile\").insert(");
    const d = cron.indexOf(".delete().in(\"id\", ids)");
    return i > 0 && d > i;
  })());
}

console.log("\n■ ④ 表が無いDBでも止まらない（今まで通り）");
{
  ok("profile は 200 で返す", /missing \? 200 : 500/.test(prof));
  ok("cron は table_missing を返す", /table_missing: tableMissing/.test(cron));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
