// app/lib/__tests__/supervisor-link.test.ts
// 2026-11-14 竹内さん
//   「ちゃんと強化されていく仕組みとなっているか」
//   「これで弱い部分みつけたら統括の部分が録画したところから学習して最善の改善できるようになっているか」
//   「ちゃんとここの連携細かくできるようにする」
//
// ⚠ 見つけた穴（連携できていなかった）:
//   統括は `learning_tasks`（自分で決めた順番）を出していたが、
//   **実行する側（supervisor-do）が `actions` しか読んでいなかった**。
//   ＝判断と実行が繋がっていない（統括が決めても誰もやらない）。
//
// 直した事（このテストで固定する）:
//   ① supervisor-do が `meeting.learning_tasks` を読む
//   ② 課題の種類ごとに実行できる（fix_scene / fix_record は無料で実行・photo_learn は --yes-cost の時だけ）
//   ③ 人が必要な物（need_human）は「竹内さんにしかできない」として出す（勝手にやらない）
//   ④ 順番は統括が決めたまま（無料→有料）
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/supervisor-link.test.ts
import fs from "node:fs";
import path from "node:path";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");
const doSrc = fs.readFileSync(path.join(root, "scripts", "supervisor-do.ts"), "utf8");
const doCode = doSrc.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① 実行する側が『統括が決めた順番』を読む（これが無かった）");
{
  ok("fetchAdv が tasks を返す", /tasks: Task\[\]/.test(doCode));
  ok("  ⚠ meeting.learning_tasks を読む", /meeting\.learning_tasks/.test(doCode));
  ok("  課題の種類が文字列の物だけ通す", /typeof t\.kind === "string"/.test(doCode));
  ok("  一覧に出す（この順で進める）", /統括が決めた「次に学ぶ事」/.test(doSrc));
}

console.log("\n■ ② 種類ごとに実行できる（無料 / 有料 / 人）");
{
  ok("fix_scene を実行できる", /fix_scene:\s*\{/.test(doCode));
  ok("  cost: false（無料）", /fix_scene:\s*\{[\s\S]{0,200}?cost: false/.test(doCode));
  ok("fix_record も実行できる", /fix_record:\s*\{/.test(doCode));
  ok("  cost: false（無料）", /fix_record:\s*\{[\s\S]{0,200}?cost: false/.test(doCode));
  ok("photo_learn がある", /photo_learn:\s*\{/.test(doCode));
  ok("  ⚠ cost: true（お金がかかる）", /photo_learn:\s*\{[\s\S]{0,300}?cost: true/.test(doCode));
  ok("need_human は人がやる", /need_human:\s*\{/.test(doCode));
}

console.log("\n■ ③ 費用がかかる物は勝手に走らせない");
{
  ok("⚠ --yes-cost を付けた時だけ実行", /if \(r\.cost && !yesCost\)/.test(doCode));
  ok("  止めた理由を出す", /費用がかかるので止めました/.test(doSrc));
  ok("  枚数の上限を必ず付ける", /Math\.min\(60,\s*Number\(t\?\.limit\)\s*\|\|\s*20\)/.test(doCode));
  ok("  実行の入口は --run=task:N", /runArg\.startsWith\("task:"\)/.test(doCode));
}

console.log("\n■ ④ 人が必要な物は勝手にやらない");
{
  ok("need_human は「竹内さんにしかできません」", /竹内さんにしかできません/.test(doSrc));
  ok("  実行を続けない（continue）", /need_human"\)\s*\{[^}]*continue;/.test(doCode) || /t\.kind === "need_human"/.test(doCode));
}

console.log("\n■ ⑤ 統括が決める順番（無料→有料）が実行側と一致する");
{
  const base = {
    rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
    weak: [], mode_counts: { normal: 200 }, site_counts: { realpro: 200 }, with_ops: 30,
    site: "all", shot_rows: 190,
  };
  const r = superviseLearn({ ...base, stopped_scene: "検索を押す", scene_missing: 1, scene_missing_names: "次のページへ" });
  const tasks = r.meeting.learning_tasks || [];
  ok("課題が出る", tasks.length >= 2, tasks.map((t) => t.kind));
  ok("  ⚠ 先頭は無料（fix_scene）", tasks[0]?.kind === "fix_scene", tasks.map((t) => t.kind));
  ok("  有料（photo_learn）は最後", tasks[tasks.length - 1]?.kind === "photo_learn", tasks.map((t) => t.kind));
  // 実行側が全種類を扱えるか
  for (const t of tasks) {
    ok(`  実行側が ${t.kind} を扱える`, new RegExp(`${t.kind}:\\s*\\{`).test(doCode));
  }
}

console.log("\n■ ⑥ 実行した結果を確かめる手順が書いてある");
{
  ok("supervisor-talk で取り直す案内がある", /supervisor-talk\.ts/.test(doSrc));
  ok("  ⚠ 「効いたか」は数字で見る（決めつけない）", /判断」を取り直して確かめます/.test(doSrc));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
