// 2026-11-15 作業員H: /api/human-learn-profile の守り（HUMAN_LEARN_PROFILE_GUARD・既定 off）を、11/15 01:40:43〜55Z の束の形で確かめる。DB も LLM も使わない。
//   その時の形（Vercel・Supabase のログ）: 12秒に関数の呼び出し 約130回・DB へ GET 452件（版だけの確認も束の全体を読む）・PATCH 302件（全部 同じ1行 id=1556 の read_count）
// 実行: npx tsx app/lib/__tests__/human-learn-profile-guard.test.ts
import { readFileSync } from "node:fs";
import { learnProfileGuardOn, shouldTouchRead, coalesce, cacheHeaders, inflightCount, READ_MARK_MIN_GAP_MS } from "../human-learn-profile-guard";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

(async () => {
  ok("既定 on（=off で戻す）", learnProfileGuardOn({}) === true && learnProfileGuardOn({ HUMAN_LEARN_PROFILE_GUARD: "off" }) === false);
  // ① 同じ時に重なった同じ読み（130回）→ DB の読みは1回
  let dbReads = 0;
  const read = () => new Promise<{ id: number }>((res) => { dbReads++; setTimeout(() => res({ id: 1556 }), 30); });
  const all = await Promise.all(Array.from({ length: 130 }, () => coalesce("row:realpro:light", true, read)));
  ok("重なった130回の同じ読み → DB の読みは1回・全部同じ答え", dbReads === 1 && all.every((x) => x.id === 1556), `reads=${dbReads}`);
  ok("終わったらまとめを外す（次の呼び出しは新しく読む）", inflightCount() === 0);
  dbReads = 0;
  await Promise.all(Array.from({ length: 5 }, () => coalesce("row:realpro:light", false, read)));
  ok("off の時はまとめない（今まで通り 1回ずつ）", dbReads === 5);
  // ③ 束の作り直し（1回 約15秒）が重なっても1本
  let builds = 0;
  const build = () => new Promise<string>((res) => { builds++; setTimeout(() => res("bundle"), 50); });
  await Promise.all(Array.from({ length: 40 }, () => coalesce("build:realpro", true, build)));
  ok("束の作り直しが40回重なっても1本", builds === 1);
  // ② 読んだ印: 前の印から10分たっていなければ書かない（同じ1行への書き込みの取り合いを作らない）
  const now = Date.parse("2026-11-15T01:40:50Z");
  let marks = 0, readAt: string | null = "2026-11-15T01:40:43Z";
  for (let i = 0; i < 302; i++) if (shouldTouchRead(readAt, now)) { marks++; readAt = new Date(now).toISOString(); }
  ok("01:40 の形（302回の読んだ印）→ 0回（7秒前に印あり）", marks === 0);
  ok("10分たっていれば1回だけ書く", shouldTouchRead("2026-11-15T01:30:00Z", now) && !shouldTouchRead(new Date(now - READ_MARK_MIN_GAP_MS + 1000).toISOString(), now) && shouldTouchRead(null, now));
  ok("CDN の短いキャッシュの見出し（同じ時に来た同じ要求を CDN が1つにまとめる）", /s-maxage=30/.test(cacheHeaders("light")["Cache-Control"]) && /s-maxage=60/.test(cacheHeaders("bundle")["Cache-Control"]));
  {
    const route = readFileSync("app/api/human-learn-profile/route.ts", "utf8");
    ok("配線: 軽い確認は版だけ読む（束の全体を読まない）", /generated_at:bundle->>generated_at/.test(route));
    ok("配線: 読んだ印は守りの時は応答の後で・10分に1回", /shouldTouchRead\(row\.read_at/.test(route) && /after\(async \(\) => \{\s*try \{ await supabase\.from\("human_learn_profile"\)\.update/.test(route));
    ok("配線: 作り直しは1本にまとめる・作ってから5分は作らない", /coalesce\(`build:\$\{scope\}`/.test(route) && /builtRecently/.test(route));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
