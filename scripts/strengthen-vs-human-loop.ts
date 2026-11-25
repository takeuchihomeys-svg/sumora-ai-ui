/**
 * 人間と比べて弱い所を画像学習＋テストで繰返し強化する一連（F60→F59→弱強化→F58）
 *
 *   npx tsx --env-file=.env.local scripts/strengthen-vs-human-loop.ts
 *   npx tsx --env-file=.env.local scripts/strengthen-vs-human-loop.ts --yes-cost
 *   npx tsx --env-file=.env.local scripts/strengthen-vs-human-loop.ts --yes-cost --rounds=2
 *
 * ★ 竹内さん「人間と比べて弱い部分徹底的に細かく改善／画像学習やテストを繰り返して強化」
 *   ① weak-find（横断）→ ② human-like-improve（間隔＋位置）→ ③ weak-strengthen（欄1つずつ）
 *   → ④ F58 テスト → ⑤ 再測。未達が残ればまた回す。
 *
 * ⚠ 拡張再読込→自動1回は人の手（P0）。このスクリプトは学習・束・テストまで。
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const yesCost = args.includes("--yes-cost");
const rounds = Math.min(3, Math.max(1, Number((args.find((a) => a.startsWith("--rounds=")) || "").replace("--rounds=", "")) || 1));
const STAMP = "memory/strengthen_vs_human_last.json";

function hr() {
  console.log("─".repeat(66));
}

function run(label: string, cmd: string, cmdArgs: string[]): { ok: boolean; code: number } {
  console.log(`\n▶ ${label}`);
  console.log(`  $ ${cmd} ${cmdArgs.join(" ")}`);
  // inherit: photo_learn の途中ログ（… n/total）を隠さず出す（pipe+最後25行だと長時間無音）
  const r = spawnSync(cmd, cmdArgs, {
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    stdio: "inherit",
  });
  const code = r.status ?? 1;
  return { ok: code === 0 || code === 2, code }; // 2 = 未達あり（測れた）
}

function main() {
  hr();
  console.log(`【人間比・強化ループ】yesCost=${yesCost} rounds=${rounds}`);
  hr();

  const history: Array<{ round: number; step: string; code: number }> = [];

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n══ 周回 ${round}/${rounds} ══`);

    let r = run("① 弱所横断 F60", "npx", ["tsx", "--env-file=.env.local", "scripts/weak-find.ts"]);
    history.push({ round, step: "weak-find", code: r.code });

    if (yesCost) {
      r = run(
        "② 人間らしさ改善 F59（gaps＋photo_learn）",
        "npx",
        ["tsx", "--env-file=.env.local", "scripts/human-like-improve.ts", "--yes-cost"],
      );
      history.push({ round, step: "human-like-improve", code: r.code });

      r = run(
        "③ 弱い欄を1つずつ強化",
        "npx",
        ["tsx", "--env-file=.env.local", "scripts/weak-strengthen.ts", "--yes-cost", "--rounds=1", "--site=realpro"],
      );
      history.push({ round, step: "weak-strengthen", code: r.code });
    } else {
      console.log("\n（--yes-cost なし → Vision は回さない。計画だけ）");
      run("②' human-like plan", "npx", ["tsx", "--env-file=.env.local", "scripts/human-like-improve.ts", "--plan-only"]);
    }

    r = run("④ F58 テスト関所", "npx", ["tsx", "scripts/ext-test-improve-loop.ts"]);
    history.push({ round, step: "F58", code: r.code });

    r = run("⑤ 再測 F60", "npx", ["tsx", "--env-file=.env.local", "scripts/weak-find.ts"]);
    history.push({ round, step: "weak-find-remeasure", code: r.code });
  }

  // 最終スタンプから次手
  let next = "拡張再読込（≥2.8.199）→束取得→自動1回→ scripts/strengthen-vs-human-loop.ts --yes-cost";
  let gaps: unknown[] = [];
  const wf = join(process.cwd(), "memory/weak_find_last.json");
  if (existsSync(wf)) {
    try {
      const s = JSON.parse(readFileSync(wf, "utf8"));
      gaps = s.gaps || [];
      if (s.next) next = s.next;
    } catch (_) { /* ignore */ }
  }

  mkdirSync(join(process.cwd(), "memory"), { recursive: true });
  const stamp = {
    at: new Date().toISOString(),
    yesCost,
    rounds,
    history,
    gaps_n: Array.isArray(gaps) ? gaps.length : null,
    gaps: gaps,
    next,
    human_step: "chrome://extensions 再読込≥2.8.199 → 束取得 → 自動1回 → 再測",
  };
  writeFileSync(join(process.cwd(), STAMP), JSON.stringify(stamp, null, 2));

  hr();
  console.log("■ 一連終了");
  console.log(`  スタンプ: ${STAMP}`);
  console.log(`  未達 gaps≈${stamp.gaps_n}`);
  console.log(`  次: ${next}`);
  console.log(`  人の手: ${stamp.human_step}`);
  hr();

  if ((stamp.gaps_n ?? 1) > 0) process.exitCode = 2;
}

main();
