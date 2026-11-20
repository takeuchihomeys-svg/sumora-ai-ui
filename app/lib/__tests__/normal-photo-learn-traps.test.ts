/**
 * 通常モード画像→弱い所強化の再発防止（2026-11-15 竹内さん）
 *
 *   「この打ち合わせ何度もしているのでちゃんとできるようにする」
 *   「ここできるようになるよう細部の改善をおこなう」
 *
 * 過去に起きた失敗をソース上で固定する:
 *   ① photo_learn が opsPct だけだと、操作6割超で未読があっても課題に出ない
 *   ② findShots が時間順で 480px に埋まり、読める未学習が 0 件になる
 *   ③ shot_gaps_normal を束に載せないと統括が「通常から読め」と言えない
 *   ④ 弱い所の how が「録画を増やせ」だけだと、すでにある画像を読まない
 *
 * 実行: npx tsx --env-file=.env.local app/lib/__tests__/normal-photo-learn-traps.test.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + String(extra).slice(0, 300))); }
};

const root = join(__dirname, "..");
const supervisorSrc = readFileSync(join(root, "learn-supervisor.ts"), "utf8");
const brainSrc = readFileSync(join(root, "human-learn-brain.ts"), "utf8");
const shotServerSrc = readFileSync(join(root, "shot-learn-server.ts"), "utf8");
const doSrc = readFileSync(join(root, "..", "..", "scripts", "supervisor-do.ts"), "utf8");

console.log("■ ① 統括: 通常未学習があれば photo_learn（操作率だけでは切らない）");
{
  ok("shot_gaps_normal を材料に使う", /shot_gaps_normal/.test(supervisorSrc));
  ok("  弱い所＋未学習 → 通常の画像を読め", /通常モードの画像を読んで弱い所を強化する/.test(supervisorSrc));
  ok("  旧罠（opsPct だけ）への言及がある", /opsPct < 60/.test(supervisorSrc) && /shot_gaps_normal\.todo/.test(supervisorSrc));
  const r = superviseLearn({
    rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
    weak: [{ kind: "x", name: "required_time" }],
    mode_counts: { normal: 200 }, site_counts: { realpro: 200 },
    with_ops: 180, site: "all", shot_rows: 190,
    shot_gaps_normal: { total: 500, unlearnedBig: 50, unlearnedSmall: 100, learnedButEmpty: 0, learnedOk: 350, todo: 50 },
  });
  ok("  課題に photo_learn", (r.meeting.learning_tasks || []).some((t) => t.kind === "photo_learn"), r.meeting.learning_tasks);
  ok("  自己点検が photo_learn 欠落を見られる土台", /learningTasks/.test(supervisorSrc) && /photo_learn/.test(supervisorSrc));
  ok("  弱い所＋未学習なのに photo_learn 無しは矛盾", (r.self_check.issues || []).every((x) => !x.includes("把握できていない")), r.self_check);
}

console.log("\n■ ② 実行: 読める大きさをDBで先に絞る（時間順480px埋め防止）");
{
  ok("findShots が shot_w >= 800 をDBで絞る", /\.gte\("shot_w",\s*800\)/.test(shotServerSrc));
  ok("  4回目の罠のコメントがある", /4回目の罠/.test(shotServerSrc));
  ok("  photo_learn 実行は mode=normal", /mode:\s*"normal"/.test(doSrc));
}

console.log("\n■ ③ 束: shot_gaps_normal を統括に渡す");
{
  ok("human-learn-brain が shot_gaps_normal を作る", /shot_gaps_normal:/.test(brainSrc));
  ok("  通常だけ（自動モードを除外）", /m !== "aix" && m !== "auto"/.test(brainSrc) || /!== "aix"/.test(brainSrc) || /!isAutoMode\(/.test(brainSrc));
}

console.log("\n■ ④ 弱い所の how は『すでにある画像を読む』");
{
  ok("録画を増やす前に画像を読む", /録画を増やす前に、すでにある画像を読む/.test(supervisorSrc));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
