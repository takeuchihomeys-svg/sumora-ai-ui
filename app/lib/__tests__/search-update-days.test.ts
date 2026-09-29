// app/lib/__tests__/search-update-days.test.ts
// 更新日（前回の検索から空いた時間を覆う・点検の決まりの出どころ・一覧の更新日・ページの打ち切り）と、見張りの更新日・Jev の材料のテスト。
// 実行: npx tsx app/lib/__tests__/search-update-days.test.ts
//
// 2026-09-29 竹内「更新日もちゃんと確認する。更新日を生かすことによって最新の物件の検索や新規物件のもれがないようにするのが目的」
//   9/22〜 の UPDATE_DAYS の warn 90件（differs 90・typed_unverified 2）の実物の形を固定する
import { createRequire } from "module";
import {
  planUpdateDays, neededDays, coverChoice, coversGap, hoursSince, ageDaysOfCell, agesOutside, planPayload, planFor,
} from "../search-update-days";
import { runSearchAuditChecks, expectedUpdateDays, type AuditInput } from "../search-audit-check";
import { detectScreenState, updateDaysFindings, jevStateFor, type WatchMaterial } from "../screen-watch";
import { normalizePropertyName } from "../property-name-match";
import { normalizeRoomNo } from "../sent-property-record";

const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SK = require_("../../../chrome-extension/sent-skip.js") as {
  normName(s: string): string; normRoom(s: string): string; ageDaysOfCell(s: string): number | null;
};

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}
const H = 3600_000;
const now = Date.parse("2026-09-29T08:00:00Z"); // JST 17:00（午後の便）

console.log("\n■ 空いた時間 → 要る日数 → 選択肢（1/3/7/14・無理なら指定なし）");
{
  t("6時間（午前の便→午後の便）→ 1日", neededDays(6) === 1 && coverChoice(1) === 1);
  t("24時間＋20分（開始のばらつき）→ 1日（余裕 0.5時間）", neededDays(24.3) === 1);
  t("31時間（前日 10:00 → 今日 17:00）→ 2日 → 3日以内", neededDays(31) === 2 && coverChoice(2) === 3);
  t("4日 → 7日以内", coverChoice(neededDays(96)) === 7);
  t("15日 → 指定なし（大きい側）", coverChoice(neededDays(15 * 24)) === null);
  t("指定なしは覆える", coversGap(null, 1000));
  t("1日以内で49時間は覆えない", !coversGap(1, 49));
  t("未来の時刻は読めない", hoursSince(new Date(now + 5 * 60_000).toISOString(), now) === null);
}

console.log("\n■ 計画（今までの決まりを広げるだけ・狭めない）");
{
  const p1 = planUpdateDays({ baseDays: 1, lastSearchAt: new Date(now - 49 * H).toISOString(), nowMs: now });
  t("午後の便 1 で前回 49時間前 → 3日以内に広げる", p1.days === 3 && p1.widened && p1.need_days === 3, p1);
  const p2 = planUpdateDays({ baseDays: 7, lastSearchAt: new Date(now - 6 * H).toISOString(), nowMs: now });
  t("今までの決まり 7 は狭めない（前回6時間前でも 7）", p2.days === 7 && !p2.widened, p2);
  const p3 = planUpdateDays({ baseDays: 3, lastSearchAt: null, nowMs: now });
  t("前回の検索の記録なし → 今までの決まり", p3.days === 3 && !p3.widened && p3.gap_hours === null, p3);
  const p4 = planUpdateDays({ baseDays: null, lastSearchAt: new Date(now - 30 * H).toISOString(), nowMs: now });
  t("初回（指定なし）はそのまま指定なし", p4.days === null && !p4.widened, p4);
  const p5 = planUpdateDays({ baseDays: 14, lastSearchAt: new Date(now - 20 * 24 * H).toISOString(), nowMs: now });
  t("14 でも覆えない → 指定なし", p5.days === null && p5.widened, p5);
  const pl = planPayload([{ id: "c1", plan: p1 }]);
  t("payload の形から引ける", planFor({ update_days_plan: pl }, "c1")?.days === 3 && planFor({ update_days_plan: pl }, "c2") === undefined);
}

console.log("\n■ 点検の決まりの出どころ（9/22〜 の differs 90件の実物の形）");
{
  const masked = { last_property_sent_at: "＊＊＊T02:50:40.434+00:00", property_viewed_at: "＊＊＊T04:17:11.1+00:00" };
  t("写しの日時が伏せ字（v2.5.40 まで）→ 決まりが分からない＝言わない", expectedUpdateDays({ customer_snapshot: masked as never }).known === false);
  const base: AuditInput = { site: "realpro", status: "finished", customer_snapshot: masked as never, intended: { rp_update_days: 1 }, filled: { form: { update_days: "1" } }, created_at: new Date(now).toISOString() };
  const v1 = runSearchAuditChecks(base, now);
  t("伏せ字の古い行に differs を付けない", !v1.checks.some((c) => c.cause_key.endsWith(":differs")), v1.checks);
  t("午後の便（mode=pm）の決まりは 1", expectedUpdateDays({ command_payload: { source: "auto_schedule", mode: "pm", rp_update_days: 1 } }).days === 1);
  t("web_brain の決まりはサーバーが積んだ値", expectedUpdateDays({ command_payload: { source: "web_brain", rp_update_days: 3 } }).days === 3);
  const planP = { source: "auto_schedule", mode: "pm", rp_update_days: 1, update_days_plan: planPayload([{ id: "c1", plan: planUpdateDays({ baseDays: 1, lastSearchAt: new Date(now - 49 * H).toISOString(), nowMs: now }) }]) };
  t("計画があれば計画の値（3）", expectedUpdateDays({ command_payload: planP, customer_id: "c1" }).days === 3);
  const v2 = runSearchAuditChecks({ ...base, command_payload: { source: "web_brain", rp_update_days: 3 }, intended: { rp_update_days: 1 } }, now);
  t("web_brain の 3 を 1 で入れた（popup が payload を見ていなかった 9/28 03:07 の形）→ differs", v2.checks.some((c) => c.cause_key === "update_days:realpro:differs"), v2.checks);
  const clear = { last_property_sent_at: new Date(now - 30 * H).toISOString() };
  const v3 = runSearchAuditChecks({ ...base, customer_snapshot: clear as never, intended: { rp_update_days: 1 }, filled: { form: { update_days: "1" } } }, now);
  t("日時が読める写し: 前回物件を出したのが前日（JST の日付で1日）→ 決まり 1 と一致（differs なし）", !v3.checks.some((c) => c.cause_key.endsWith(":differs")), v3.checks);
}

console.log("\n■ 前回の検索から空いた分（C1）・ページの打ち切り（C3）・一覧の更新日（C2）");
{
  const base: AuditInput = { site: "realpro", status: "finished", intended: { rp_update_days: 1 }, filled: { form: { update_days: "1" } }, created_at: new Date(now).toISOString(), command_payload: { source: "auto_schedule", mode: "pm", rp_update_days: 1 } };
  const g = runSearchAuditChecks({ ...base, last_search_at: new Date(now - 49 * H).toISOString() }, now);
  const gc = g.checks.find((c) => c.cause_key === "update_days:realpro:gap_uncovered");
  t("前回 9/27 の検索から49時間・1日以内 → gap_uncovered（warn）", !!gc && gc.severity === "warn", g.checks);
  const g2 = runSearchAuditChecks({ ...base, last_search_at: new Date(now - 6 * H).toISOString() }, now);
  t("前回が6時間前なら言わない", !g2.checks.some((c) => c.cause_key.endsWith(":gap_uncovered")));
  const it = runSearchAuditChecks({ site: "itandi", status: "finished", intended: { rp_update_days: 14 }, filled: { update_days: { status: "out_of_range" }, form: { update_days: "" } }, created_at: new Date(now).toISOString(), last_search_at: new Date(now - 10 * 24 * H).toISOString() }, now);
  t("ITANDI の 14（なしで検索＝広い側）は覆える", !it.checks.some((c) => c.cause_key.endsWith(":gap_uncovered")), it.checks);
  const cut = runSearchAuditChecks({ ...base, intended: { rp_update_days: 3 }, filled: { form: { update_days: "3" } }, command_payload: null, result: { page_limit: 3, count_number: 120, read_rows: 90 } }, now);
  t("3ページで打ち切り → cut_by_pages", cut.checks.some((c) => c.cause_key === "update_days:realpro:cut_by_pages"), cut.checks);
  const rows = runSearchAuditChecks({ ...base, command_payload: null, result: { update_ages: { n: 10, max_days: 9, sample: [0.2, 0.5, 1, 3, 4, 5, 9, 0.1, 0.3, 0.9] } } }, now);
  t("1日以内なのに2日前より古い行が4/10 → rows_outside", rows.checks.some((c) => c.cause_key === "update_days:realpro:rows_outside"), rows.checks);
  const rowsOk = runSearchAuditChecks({ ...base, command_payload: null, result: { update_ages: { n: 10, max_days: 1.5, sample: [0.2, 0.5, 1, 1.5, 0.1, 0.3, 0.9, 0.4, 0.2, 0.1] } } }, now);
  t("「1日前」までは中（表示は切り捨て）", !rowsOk.checks.some((c) => c.cause_key.endsWith(":rows_outside")), rowsOk.checks);
  t("1件だけ外は言わない", agesOutside(1, { n: 10, max_days: 3, sample: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 3] })?.bad === false);
}

console.log("\n■ 見張り（ラベルは変えない・規則と1行だけ）・Jev の材料");
{
  const checks = runSearchAuditChecks({ site: "realpro", status: "started", intended: { rp_update_days: 1 }, filled: { form: { update_days: "1" } }, created_at: new Date(now).toISOString(), last_search_at: new Date(now - 49 * H).toISOString() }, now).checks;
  const m: WatchMaterial = { checkpoint: "filled", site: "realpro", checks, update: { days: 1, gap_hours: 49, need_days: 3, last_search_at: new Date(now - 49 * H).toISOString() } };
  const d = detectScreenState(m);
  t("空いた分を覆えない C1 → ラベルは normal のまま・規則 update:gap_uncovered・1行", d.label === "normal" && d.rules.includes("update:gap_uncovered") && /前回の検索から空いた2日を覆えていない/.test(d.update_notice ?? ""), d);
  const c2 = updateDaysFindings({ checkpoint: "results", site: "realpro", update: { days: 3, gap_hours: 6, need_days: 1, last_search_at: null }, dom: { count_text: "全 40 件", update_ages: { n: 10, max_days: 12, sample: [0.2, 5, 6, 7, 12, 1, 2, 0.5, 9, 3] } } });
  t("C2: 画面の一覧の更新日が 3日以内 の外に5/10 → rows_outside", c2.items.some((x) => x.code === "rows_outside") && /絞りが効いていない/.test(c2.notice ?? ""), c2);
  t("differs（決まりとの違い）は見張りに出さない", updateDaysFindings({ checkpoint: "done", checks: [{ code: "UPDATE_DAYS", severity: "warn", cause_key: "update_days:realpro:differs", title: "更新日が決まりと違う" }] }).items.length === 0);
  const st = jevStateFor(m, {}, d, { conditions: { desired_area: "梅田まで30分", rent_max: 80000 }, wants: ["設備:ガスコンロ"], commute: "梅田まで30分", scope: "permanent", intent: "駅 3（梅田・十三・中津）", update_days: { days: 1, gap_hours: 49, need_days: 3 } });
  const js = JSON.stringify(st);
  t("Jev の state にブレインの材料（条件・要望・通勤・切り替え・意図・前回から）", /"brain"/.test(js) && /ガスコンロ/.test(js) && /"scope":"permanent"/.test(js) && /"need_days":3/.test(js), st);
  t("Jev の state に名前の欄は無い", !/customer_name/.test(js));
}

console.log("\n■ 拡張の写し（sent-skip.js）が TS と同じ答え（四者同名・送付済みの実物の名前）");
{
  const names = ["カーサグランテ竹島", "メゾン ブランカ あびこ南", "Brillia　Tower　堂島", "【3】ArtizA瓦屋町Ⅱ", "(仮称)ジーメゾン西湊ベルジュール", "maison de Villa 北畠", "ＳＥＲＥｎｉＴＥ本町エコート", "エステムコート難波サウスプレイスⅣラグジー"];
  const bad = names.filter((n) => SK.normName(n) !== normalizePropertyName(n));
  t("名前の正規化が一致", bad.length === 0, bad);
  const rooms = ["0405", "405", "405号室", "１０１", "005B", "B101", "309"];
  const badR = rooms.filter((r) => SK.normRoom(r) !== normalizeRoomNo(r));
  t("号室の正規化が一致", badR.length === 0, badR.map((r) => [r, SK.normRoom(r), normalizeRoomNo(r)]));
  const cells = ["309 4日前 閲覧済", "0405 4時間前 閲覧済", "1001 30分前", "401 2週間前", "309 閲覧済"];
  const badA = cells.filter((c) => SK.ageDaysOfCell(c) !== ageDaysOfCell(c));
  t("更新日の経過の読みが一致", badA.length === 0, badA);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
