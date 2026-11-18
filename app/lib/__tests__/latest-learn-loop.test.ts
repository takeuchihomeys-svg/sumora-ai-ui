/**
 * 最新録画 → 自動最新課題 → 通常から改善（2026-11-15）
 * 実行: npx tsx --env-file=.env.local app/lib/__tests__/latest-learn-loop.test.ts
 */
import {
  summarizeRecordingFreshness, summarizeLatestAutoChallenges, planImproveFromNormal,
} from "../latest-learn-loop";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 300))); }
};

const now = Date.parse("2026-11-15T14:00:00Z");

console.log("■ ① 最新録画の画像を把握");
{
  const f = summarizeRecordingFreshness([
    { created_at: "2026-11-15T13:00:00Z", mode: "normal", shot_key: "a.jpg", shot_w: 1920, shot_learn: null, ext_version: "2.7.85" },
    { created_at: "2026-11-15T13:30:00Z", mode: "aix", shot_key: "b.jpg", shot_w: 1920, shot_learn: null, ext_version: "2.7.85" },
    { created_at: "2026-11-14T10:00:00Z", mode: "normal", shot_key: "c.jpg", shot_w: 1920, shot_learn: { fields: [] }, ext_version: "2.7.79" },
  ], now);
  ok("通常最新の時刻", f.normalLatestAt?.startsWith("2026-11-15T13:00") === true, f.normalLatestAt);
  ok("自動最新の時刻", f.autoLatestAt?.startsWith("2026-11-15T13:30") === true, f.autoLatestAt);
  ok("通常最新は未学習", f.normalLatestLearned === false);
  ok("直近24hを数える", f.normalLast24h === 1 && f.autoLast24h === 1, f);
  ok("線に『まだ読んでいない』", /まだ読んでいない/.test(f.line), f.line);
}

console.log("\n■ ② 自動の最新課題（古い版と混ぜない）");
{
  const old = {
    created_at: "2026-11-10T10:00:00Z", mode: "aix", shot_key: "2026-11-10/aix/run_oldxxx_n1/x.jpg",
    shot_w: 1920, ext_version: "2.7.58",
    shot_ops: [{ k: "change", f: "old_field", t: 1 }],
  };
  const neu = {
    created_at: "2026-11-15T13:20:00Z", mode: "aix", shot_key: "2026-11-15/aix/run_newxxx_n1/y.jpg",
    shot_w: 1920, ext_version: "2.7.85",
    shot_ops: [
      { k: "change", f: "transportation_id", t: 100 },
      { k: "change", f: "required_time", t: 200 },
      { k: "click", f: "city_code[]", t: 300 },
      { k: "click", f: "city_code[]", t: 900 },
    ],
  };
  const ch = summarizeLatestAutoChallenges([old, neu], { hours: 48, nowMs: now });
  ok("最新窓の版は 2.7.85", ch.extVersion === "2.7.85", ch.extVersion);
  ok("old_field は出ない", !ch.fields.includes("old_field"), ch.fields);
  ok("押さず変化に transportation_id", ch.changedNoClick.includes("transportation_id"), ch.changedNoClick);
  ok("課題がある", ch.challenges.length > 0, ch.challenges);
}

console.log("\n■ ③ 通常から改善する計画");
{
  const fresh = summarizeRecordingFreshness([
    { created_at: "2026-11-15T12:00:00Z", mode: "normal", shot_key: "n.jpg", shot_w: 1920, shot_learn: null },
  ], now);
  const ch = summarizeLatestAutoChallenges([{
    created_at: "2026-11-15T13:00:00Z", mode: "aix", shot_key: "2026-11-15/aix/run_abc_n1/z.jpg",
    shot_ops: [{ k: "change", f: "required_time", t: 1 }],
  }], { hours: 48, nowMs: now });
  const plan = planImproveFromNormal(ch, fresh);
  ok("計画が出る", !!plan, plan);
  ok("preferNewest", plan?.preferNewest === true);
  ok("欄に required_time", plan?.fields.includes("required_time") === true, plan?.fields);
}

console.log("\n■ ④ 統括が把握する");
{
  const r = superviseLearn({
    rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
    weak: [{ kind: "x", name: "required_time" }],
    mode_counts: { normal: 100, aix: 50 }, site_counts: { realpro: 150 },
    with_ops: 150, site: "all", shot_rows: 180,
    shot_gaps_normal: { total: 100, unlearnedBig: 20, unlearnedSmall: 10, learnedButEmpty: 0, learnedOk: 70, todo: 20 },
    recording_freshness: {
      normalLatestAt: "2026-11-15T13:00:00Z", autoLatestAt: "2026-11-15T13:30:00Z",
      normalLast24h: 40, autoLast24h: 80, normalLatestLearned: false,
      line: "通常 最新 …未学習／自動 最新 …",
    },
    latest_auto_challenge: {
      runs: 2, extVersion: "2.7.85", fields: ["transportation_id", "required_time"],
      changedNoClick: ["transportation_id", "required_time"], retries: ["city_code[]"],
      line: "最新自動 2回／⚠ 押さず変化 transportation_id・required_time",
      challenges: [{ what: "押さずに値が変わった", why: "transportation_id", field: "transportation_id" }],
    },
    improve_from_normal: {
      fields: ["transportation_id", "required_time"],
      what: "自動の最新課題を、通常モードの画像から改善する",
      why: "課題欄: transportation_id・required_time",
      how: "newest で読む",
      preferNewest: true,
    },
  });
  ok("根拠に最新録画", r.meeting.evidence.some((e) => e.label === "最新録画の画像"), r.meeting.evidence.map((e) => e.label));
  ok("根拠に自動最新課題", r.meeting.evidence.some((e) => e.label === "自動モードの最新課題"));
  ok("原則に自動→通常", r.meeting.evidence.some((e) => (e.label || "").includes("自動最新課題")));
  const pl = (r.meeting.learning_tasks || []).find((t) => t.kind === "photo_learn");
  ok("photo_learn が newest", pl?.order === "newest", pl);
  ok("課題欄が載る", Array.isArray(pl?.fields) && pl!.fields!.includes("transportation_id"), pl);
  ok("次にやる事の先頭が改善", (r.actions[0]?.what || "").includes("通常モード"), r.actions[0]);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
