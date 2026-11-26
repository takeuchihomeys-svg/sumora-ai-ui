// 2026-11-15 作業員H: /api/human-learn-profile の守り（HUMAN_LEARN_PROFILE_GUARD・既定 off）を、11/15 01:40:43〜55Z の束の形で確かめる。DB も LLM も使わない。
//   その時の形（Vercel・Supabase のログ）: 12秒に関数の呼び出し 約130回・DB へ GET 452件（版だけの確認も束の全体を読む）・PATCH 302件（全部 同じ1行 id=1556 の read_count）
// 実行: npx tsx app/lib/__tests__/human-learn-profile-guard.test.ts
import { readFileSync } from "node:fs";
import { learnProfileGuardOn, shouldTouchRead, shouldPreserveLongCronBundle, coalesce, cacheHeaders, inflightCount, READ_MARK_MIN_GAP_MS, holdDaytimeRebuild, buildInAfter, learnBuildAfterOn, buildLeaseKey, laneNextWait, LANE_WAIT_MAX_MS } from "../human-learn-profile-guard";

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
    ok("配線（2026-11-20）: 営業時間の古い束は作り直さない（holdDaytimeRebuild）", /holdDaytimeRebuild\(\{ hour: jstHourNow\(\), minute: [^,]+, hasBundle: !!row, forceFresh \}\)/.test(route) && /!daytimeHold/.test(route));
    ok("配線（2026-11-20）: 手動の refresh は全列 select(\"*\") をやめ、自動と同じ列の一覧（SELECT）で読む", !/\.select\("\*"\)/.test(route) && /selectDroppingMissing\(\s*SELECT\.split/.test(route));
    ok("配線（2026-11-20/27）: needs_auto は自動の記録だけを DB で絞って見る（brain_staff / ai も isAutoMode で見る）", /\.or\("mode\.ilike\.\*aix\*,mode\.ilike\.\*auto\*,mode\.ilike\.\*brain\*,mode\.eq\.ai"\)/.test(route) && /isAutoMode\(a\.mode\)/.test(route) && !/\.limit\(40\)/.test(route));
  }
  {
    const nowMs = Date.parse("2026-11-27T01:00:00Z");
    const longCron = {
      createdAt: "2026-11-26T13:20:00Z", // 11h40m 前（22:20 JST cron）
      sourceFrom: "2026-10-27T13:20:00Z", // 30日 span
      sourceTo: "2026-11-26T13:20:00Z",
      forceFresh: false,
      nowMs,
      env: {},
    };
    ok("30日 cron 束は 12時間以内なら 3日 buildNow で上書きしない", shouldPreserveLongCronBundle(longCron) === true);
    ok("12時間超なら再生成を許す", shouldPreserveLongCronBundle({ ...longCron, createdAt: "2026-11-26T12:00:00Z" }) === false);
    ok("3日束は対象外（従来どおり 30分で更新）", shouldPreserveLongCronBundle({ ...longCron, sourceFrom: "2026-11-23T13:20:00Z" }) === false);
    ok("fresh=1 なら強制更新を許す", shouldPreserveLongCronBundle({ ...longCron, forceFresh: true }) === false);
  }
  {
    // 2026-11-20 昼の保留の判定（純関数）: 営業時間（JST 9〜22時）・束がある・?fresh=1 でない・HUMAN_LEARN_DAYTIME_REBUILD=on でない
    const base = { hasBundle: true, forceFresh: false, env: {} as Record<string, string> };
    ok("昼（10時）・束あり・普通の要求 → 作り直さない", holdDaytimeRebuild({ ...base, hour: 10 }) === true);
    ok("夜（23時）→ 作り直す（22:20 の cron 後の挙動は今まで通り）", holdDaytimeRebuild({ ...base, hour: 23 }) === false);
    ok("朝（8時）→ 作り直す", holdDaytimeRebuild({ ...base, hour: 8 }) === false);
    ok("束が1件も無い → 昼でも作る（拡張が何も無いで止まらない）", holdDaytimeRebuild({ ...base, hour: 10, hasBundle: false }) === false);
    ok("?fresh=1 は強制 → 昼でも作る", holdDaytimeRebuild({ ...base, hour: 10, forceFresh: true }) === false);
    ok("戻す HUMAN_LEARN_DAYTIME_REBUILD=on → 昼も作る（旧の動き）", holdDaytimeRebuild({ ...base, hour: 10, env: { HUMAN_LEARN_DAYTIME_REBUILD: "on" } }) === false);
    ok("境界: 9時ちょうどは昼（保留）・22時ちょうどは止めの中（11/25 夜から 22:30 まで）", holdDaytimeRebuild({ ...base, hour: 9 }) === true && holdDaytimeRebuild({ ...base, hour: 22 }) === true);
    ok("22:10 は止めの中", holdDaytimeRebuild({ ...base, hour: 22, minute: 10 }) === true);
    ok("22:30 は作る", holdDaytimeRebuild({ ...base, hour: 22, minute: 30 }) === false);
    ok("HUMAN_LEARN_HOLD_UNTIL=22:00 で前の動き", holdDaytimeRebuild({ ...base, hour: 22, minute: 10, env: { HUMAN_LEARN_HOLD_UNTIL: "22:00" } }) === false);
  }
  {
    // 2026-11-21 作業員G: 11/20 22時台の時間切れ（作り直しの要求が 60秒で切れた）→ 古い束がある時は応答の後で作り直す
    ok("LEARN_BUILD_AFTER は既定 on", learnBuildAfterOn({}) === true && learnBuildAfterOn({ LEARN_BUILD_AFTER: "off" }) === false);
    ok("古い束あり・普通の要求 → 応答の後で作る", buildInAfter({ hasBundle: true, forceFresh: false, env: {} }) === true);
    ok("束が無い → その場で作る（空で返さない）", buildInAfter({ hasBundle: false, forceFresh: false, env: {} }) === false);
    ok("?fresh=1 → その場で作る（cron・手動は作った束を受け取る）", buildInAfter({ hasBundle: true, forceFresh: true, env: {} }) === false);
    ok("LEARN_BUILD_AFTER=off → 今まで通りその場で作る", buildInAfter({ hasBundle: true, forceFresh: false, env: { LEARN_BUILD_AFTER: "off" } }) === false);
    const src = readFileSync("app/api/human-learn-profile/route.ts", "utf8");
    ok("route: 作り直しを after へ回す道がある", src.includes("buildInAfter({ hasBundle: !!row, forceFresh })") && src.includes("human-learn-profile:build-after"));
    ok("route: maxDuration 300", src.includes("export const maxDuration = 300;"));
  }
  {
    // 2026-11-21 作業員G（#588）: 作り直しの印を全部で1本に（LEARN_BUILD_ONE_LANE=on）
    const ON = { LEARN_BUILD_ONE_LANE: "on" };
    ok("既定は全部で1本の印", buildLeaseKey("all", {}) === buildLeaseKey("realpro", {}));
    ok("off で束の種類ごとの印", buildLeaseKey("all", { LEARN_BUILD_ONE_LANE: "off" }) === "human-learn-profile:all");
    ok("on: 全部で1本の印", buildLeaseKey("all", ON) === buildLeaseKey("realpro", ON));
    ok("on・応答の後・他が作っている → 既定は待たない（11/25 夜・時間切れの直し）", laneNextWait({ lease: "held", inAfter: true, waitedMs: 0, env: ON }) === null);
    ok("LEARN_AFTER_WAIT_LANE=on なら前の通り待つ", laneNextWait({ lease: "held", inAfter: true, waitedMs: 0, env: { ...ON, LEARN_AFTER_WAIT_LANE: "on" } }) === 15000);
    ok("上限を超えたら諦める", laneNextWait({ lease: "held", inAfter: true, waitedMs: LANE_WAIT_MAX_MS, env: { ...ON, LEARN_AFTER_WAIT_LANE: "on" } }) === null);
    ok("応答の前（拡張が待っている）は待たない", laneNextWait({ lease: "held", inAfter: false, waitedMs: 0, env: ON }) === null);
    ok("取れたら待たない", laneNextWait({ lease: "acquired", inAfter: true, waitedMs: 0, env: ON }) === null);
    ok("off は待たない", laneNextWait({ lease: "held", inAfter: true, waitedMs: 0, env: { LEARN_BUILD_ONE_LANE: "off" } }) === null);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
