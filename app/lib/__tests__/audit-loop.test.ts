// app/lib/__tests__/audit-loop.test.ts
// 2026-11-14 竹内さん「ちゃんと強化されていく仕組みとなっているか」
//
//   強化の輪（6つ）が**閉じているか**を1回で見られるようにする（`scripts/audit-loop.ts`）。
//   ① 記録（録画が操作を拾う）→ ② 材料（欄・順番）→ ③ 判断（場面の手順）
//   → ④ 決定（次に学ぶ事）→ ⑤ 実行（決定を実行できる）→ ⑥ 確認（数字で見る）
//
//   ⚠ 輪のどこかが切れていると「強化されているつもり」になる（今日それを3回踏んだ）:
//     ・RLS で保存できていなかった（⑥が切れ）
//     ・learning_tasks を実行する側が読んでいなかった（⑤が切れ）
//     ・見落としていた材料（field_order）があった（②が半分切れ）
//   → **1つのコマンドで全部見える**形にする（目で追わなくてよい）。
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/audit-loop.test.ts
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");
const src = fs.readFileSync(path.join(root, "scripts", "audit-loop.ts"), "utf8");

console.log("■ ① 6つの輪を全部見る");
{
  ok("① 記録（録画）", /add\(1,\s*"記録（録画）"/.test(src));
  ok("② 材料（欄・順番）", /add\(2,\s*"材料（欄・順番）"/.test(src));
  ok("③ 判断（場面の手順）", /add\(3,\s*"判断（場面の手順）"/.test(src));
  ok("④ 決定（次に学ぶ事）", /add\(4,\s*"決定（次に学ぶ事）"/.test(src));
  ok("⑤ 実行（決定→実行）", /add\(5,\s*"実行（決定→実行）"/.test(src));
  ok("⑥ 確認（数字で見る）", /add\(6,\s*"確認（数字で見る）"/.test(src));
}

console.log("\n■ ② 切れている所に『次にやる事』を出す（原因を書く）");
{
  ok("ng の時に next を出す", /if \(r\.next && r\.mark !== "ok"\)/.test(src));
  ok("  seen0 を名指しする", /seen0/.test(src));
  ok("  img/body の割合を見る", /img\/body が/.test(src));
  ok("  RLS・投げっぱなしを疑う文言がある", /RLS・投げっぱなし/.test(src));
}

console.log("\n■ ③ 判定の決まり（誤って ok にしない）");
{
  ok("⚠ 本物の操作が0件なら ng", /withRealOps\.length === 0\) add\(1, "記録（録画）", "ng"/.test(src.replace(/\n\s+/g, " ")));
  ok("⚠ seen0 が残っていたら ok にしない（warn）", /diagSeen0 > 0\) add\(1, "記録（録画）", "warn"/.test(src.replace(/\n\s+/g, " ")));
  ok("⚠ img/body が5割以上なら warn（ok にしない）", /junkPct >= 50 \? "warn"/.test(src));
  ok("⚠ 判断が保存されていなければ warn（ok にしない）", /if \(!savedOk\) add\(6, "確認（数字で見る）", "warn"/.test(src.replace(/\n\s+/g, " ")));
  ok("⚠ 実行の種類が4未満なら ng", /handles\.length < 4\) add\(5, "実行（決定→実行）", "ng"/.test(src.replace(/\n\s+/g, " ")));
}

console.log("\n■ ④ 輪が全部繋がった時だけ『全部繋がっています』と言う");
{
  ok("ng があれば『輪を止めています』", /if \(ng\) console\.log\("\\n❌ が輪を止めています/.test(src));
  ok("warn だけなら『時間が要る物』と言う", /warn\) console\.log\("\\n輪は繋がっています/.test(src));
  ok("全部 ok の時だけ『全部繋がっています』", /else console\.log\("\\n輪は全部繋がっています。/.test(src));
}

console.log("\n■ ⑤ 読むだけ（DBに書かない・サイトを触らない）");
{
  ok("insert / update / delete をしない", !/\.insert\(|\.update\(|\.delete\(/.test(src));
  ok("サイトを触らない（fetch は自分のAPIだけ）", /AUDIT_BASE/.test(src) && !/realnetpro|itandibb/.test(src));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
