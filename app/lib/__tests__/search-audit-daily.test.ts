// 実行: npx tsx app/lib/__tests__/search-audit-daily.test.ts
// 2026-09-30 検索の点検の毎日のまとめ（改善ループの1段目）。行の形は本番の search_audits（9/30）のまま。
import { buildDailyDigest, digestLines, errorLabel, isFailedRun, type DailyAuditRow } from "../search-audit-daily";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }
const at = (hm: string) => `2026-09-30T${hm}:00+09:00`;
const row = (p: Partial<DailyAuditRow>): DailyAuditRow => ({ created_at: at("16:00"), finished_at: at("16:08"), site: "itandi", area_mode: "ward", trigger: "bulk_queue", status: "finished", error: null, error_kind: null, checks: [], ext_version: "2.5.47", ...p });
const WATCHDOG = "itandi 検索完了シグナル（fill-done）が245秒以内に届きませんでした";

console.log("\n■ 失敗の数え方");
{
  t("error がある回は失敗", isFailedRun(row({ error: WATCHDOG })));
  t("終わらなかった回（abandoned）は失敗", isFailedRun(row({ status: "abandoned" })));
  t("人が止めた回は失敗に数えない", !isFailedRun(row({ error: "__BATCH_STOPPED__", error_kind: "stopped" })));
  t("普通に終わった回は失敗でない", !isFailedRun(row({})));
  t("ログイン切れの札", errorLabel("AXLX_TAB_DEAD: リアプロのタブが応答しません") === "検索の画面でない（ログイン切れ等）");
  t("完了の合図が来ない札", errorLabel(WATCHDOG) === "完了の合図が来ない");
}

console.log("\n■ 知らせる事");
{
  // 9/30 の形: ITANDI の区の検索が7回中6回失敗・駅は完走
  const rows: DailyAuditRow[] = [
    ...Array.from({ length: 6 }, () => row({ error: "見張りの時間切れ: watchdog 240秒" })),
    row({}),
    ...Array.from({ length: 5 }, () => row({ area_mode: "station" })),
    ...Array.from({ length: 4 }, () => row({ site: "realpro", finished_at: at("16:01") })),
  ];
  const d = buildDailyDigest(rows);
  t("回数と失敗の数", d.runs === 16 && d.failed === 6, JSON.stringify([d.runs, d.failed]));
  t("★ ITANDI の区の検索が 7回中6回失敗 を知らせる", d.alerts.some((a) => a.includes("ITANDIの区の検索が 7回中6回失敗") && a.includes("時間切れ")), JSON.stringify(d.alerts));
  t("完走している組（ITANDI の駅・リアプロ）は知らせない", !d.alerts.some((a) => a.includes("駅の検索") || a.includes("リアプロ")));
  t("失敗の多い組が先に並ぶ", d.groups[0].key === "itandi:ward");
  t("平均の時間が出る", d.groups.find((g) => g.key === "itandi:station")?.avg_min === 8);

  const few = buildDailyDigest([row({ error: WATCHDOG }), row({ error: WATCHDOG })]);
  t("回数が少ない組（2回）は割合で知らせない", few.alerts.length === 0, JSON.stringify(few.alerts));

  const owner = buildDailyDigest([row({ checks: [{ code: "OWNER_MISMATCH", severity: "bad", cause_key: "owner_mismatch:itandi", title: "物件の付け先が別のお客様になっていた", detail: "" }] })]);
  t("★ 付け先のずれは1回でも知らせる", owner.owner_mismatch === 1 && owner.alerts.some((a) => a.includes("付け先")));

  const ghost = buildDailyDigest([row({}), row({ trigger: "single", checks: [{ code: "DOUBLE_FILL", severity: "bad", cause_key: "double_fill:itandi", title: "同じ自動入力が2本走った", detail: "" }] })]);
  t("★ 2本走りは知らせ、幽霊の行は回数に入れない", ghost.double_fill === 1 && ghost.runs === 1 && ghost.alerts.some((a) => a.includes("2本走った")));

  const plan = buildDailyDigest([row({ site: "realpro", checks: [{ code: "FLOOR_PLAN_DROPPED", severity: "bad", cause_key: "floor_plan_dropped:realpro", title: "間取りが入っていない", detail: "入れようとした=2LDK" }] })]);
  t("★ 間取りが入らないまま検索した回は1回でも知らせる（c さん 9/30 14:13）", plan.plan_dropped === 1 && plan.alerts.some((a) => a.includes("間取りが入らないまま")));

  const login = buildDailyDigest([row({ site: "realpro", error: "AXLX_TAB_DEAD: リアプロのタブが応答しません" }), row({ error: "AXLX_TAB_DEAD: ITANDI のタブが検索の画面になりません" }), row({})]);
  t("ログイン切れが2回以上で知らせる", login.login_expired === 2 && login.alerts.some((a) => a.includes("ログイン切れ")));

  const ver = buildDailyDigest([row({ ext_version: "2.5.49" }), row({ ext_version: "2.5.47" }), row({ ext_version: "2.5.47" })]);
  t("古い版の PC が動いていたら知らせる", ver.alerts.some((a) => a.includes("最新 2.5.49") && a.includes("2.5.47 が2回")), JSON.stringify(ver.alerts));
  t("版が1つだけなら知らせない", !buildDailyDigest([row({ ext_version: "2.5.49" })]).alerts.some((a) => a.includes("古い版")));

  t("何も無い日は「知らせる事はありません」", digestLines(buildDailyDigest([row({ ext_version: "2.5.49" })])).some((l) => l.includes("知らせる事はありません")));
  t("行が0件でも落ちない", buildDailyDigest([]).runs === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
