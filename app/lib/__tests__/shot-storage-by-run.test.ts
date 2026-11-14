// app/lib/__tests__/shot-storage-by-run.test.ts
// 2026-11-14 竹内さん
//   「写真は１つ録画ごとに保管しておく」
//   「録画ごとというのと通常モードか自動モードどちらでの保存かの保管もわかるようにする」
//
//   ⚠ 旧は `日付/端末-時刻.jpg` だったので、**どの録画（1回の検索）の・どのモードの**写真か
//     分からなかった（実測: 既存1000枚が全部「旧・不明」）。
//   → `日付/モード/run_<run_id>/端末-時刻.jpg` に変えた。
//     ・モード（normal / staff / aix / ai / brain_*）がフォルダで分かる
//     ・録画（run_<run_id>）がフォルダで分かる
//     ・古い写真は消さない（読める・「旧・不明」として区別）
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/shot-storage-by-run.test.ts
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");
const route = fs.readFileSync(path.join(root, "app", "api", "human-motion", "route.ts"), "utf8");
const routeCode = route.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
const listSrc = fs.readFileSync(path.join(root, "scripts", "shots-by-run.ts"), "utf8");

console.log("■ ① 保管の形（日付/モード/録画/ファイル）");
{
  ok("モードのフォルダを作る", /const modeFolder = /.test(routeCode) && /row\.mode/.test(routeCode));
  ok("  ⚠ モードが無ければ unknown", /if \(!m\) return "unknown"/.test(routeCode));
  ok("  ⚠ フォルダ名に使える形だけ（記号を消す）", /replace\(\/\[\^a-z0-9_\]\/g, ""\)/.test(routeCode));
  ok("録画のフォルダを作る（run_）", /run_".*runId|run_\$\{runId\}/.test(routeCode) || /`\$\{base\}\/run_\$\{runId\}/.test(routeCode));
  ok("  ⚠ shot_meta の中の run_id も見る（拡張はそこに入れる）", /shot_meta/.test(routeCode) && /\.run_id/.test(routeCode));
  ok("  ⚠ run_id が無い時も置ける（今まで通り）", /: `\$\{base\}\/\$\{row\.install_id/.test(routeCode));
  ok("日付のフォルダは残す", /const day = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(routeCode));
}

console.log("\n■ ② 古い写真を消さない・区別する");
{
  ok("⚠ 削除していない（move/remove が無い）", !/\.remove\(|\.move\(/.test(routeCode));
  ok("一覧が『旧・不明』を出す", /旧・不明/.test(listSrc));
  ok("  『録画不明』も出す", /録画不明/.test(listSrc));
  ok("  ⚠ 推測でモードを決めない（不明と書く）", /\(旧・不明\)/.test(listSrc));
}

console.log("\n■ ③ 一覧の道具（録画ごと×モードで見られる）");
{
  ok("モードのフォルダをたどる", /list\(day,\s*\{\s*limit/.test(listSrc));
  ok("  録画のフォルダをたどる", /list\(`\$\{day\}\/\$\{mode\}\/\$\{sname\}`/.test(listSrc));
  ok("  録画ごとに枚数・容量・時刻を出す", /n: list\.length/.test(listSrc) && /bytes:/.test(listSrc));
  ok("  ⚠ 読むだけ（削除しない）", !/\.remove\(|\.move\(|\.upload\(/.test(listSrc));
  ok("  モードの日本語の名前がある", /normal: "通常"/.test(listSrc) && /aix: "自動（AIX）"/.test(listSrc));
  ok("  --mode= で絞れる", /wantMode/.test(listSrc));
}

console.log("\n■ ④ どのモードで撮れたかがDBにも入る（フォルダだけに頼らない）");
{
  ok("mode は表の列にある（拡張が送っている）", /mode: job\.mode \|\| null/.test(fs.readFileSync(path.join(root, "chrome-extension", "background.js"), "utf8")));
  ok("  サーバーも mode を受ける", /const modeRaw = /.test(routeCode) && /mode,\s*$|\bmode,$/m.test(routeCode));
  ok("  ⚠ staff/normal 以外も通す（自動モードが「不明」になっていた）", !/body\.mode === "staff" \? "staff"/.test(routeCode));
  ok("  ⚠ 分からない時は null（勝手に normal と決めない）", /const mode = modeRaw \|\| null/.test(routeCode));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
