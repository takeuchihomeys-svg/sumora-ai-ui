// app/lib/__tests__/auto-search-schedule.test.ts
// 2026-09-19 竹内: 毎日11:00（3日以内に物件出しした人・新規のお客さん／更新日は本来の通り）と
//   17:00（本日の更新日付・更新順・1ページ）の自動物件検索。
// 実行: npx tsx app/lib/__tests__/auto-search-schedule.test.ts（全 PASS で exit 0）
import {
  rpUpdateDaysFor, selectAutoSearchTargets, buildAutoSearchPayload, lastPropertyTouchAt, isBatchedRun,
  RECENT_SENT_DAYS, NEW_CUSTOMER_DAYS, MAX_TARGETS_PER_RUN, PM_LATEST, SEARCH_MAX_PAGES,
  AUTO_SEARCH_SITES, LEGACY_AM_IS_WIDE, START_WINDOWS, MIN_DAY_TO_DAY_DIFF_SEC, seededRandom, startOffsetSec, autoStartAtMs, customerGapSec, notBeforeSchedule,
} from "../auto-search-schedule";
import { isClaimableNow, isPickerWaitExpired, waitStartMs, WAIT_FOR_PICKER_MS, pickerActiveAt, MAX_WAIT_WHILE_ACTIVE_MS, pickClaimable } from "../automation-sources";
import * as fs from "fs";
import * as path from "path";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// JST 2026-09-19（金）11:00
const NOW = Date.parse("2026-09-19T11:00:00+09:00");
const at = (jst: string) => new Date(`${jst}+09:00`).toISOString();

console.log("── 更新日は「前回送った日から何日か」で決まる（拡張 calcUpdateDays と同じ線）");
{
  t("★ 昨日送った人 → 更新日1日以内", rpUpdateDaysFor(at("2026-09-18T20:00:00"), NOW) === 1);
  t("★ 3日前に送った人 → 更新日3日以内", rpUpdateDaysFor(at("2026-09-16T10:00:00"), NOW) === 3);
  t("今日送った人 → 1日以内", rpUpdateDaysFor(at("2026-09-19T09:00:00"), NOW) === 1);
  t("5日前 → 7日以内", rpUpdateDaysFor(at("2026-09-14T10:00:00"), NOW) === 7);
  t("10日前 → 14日以内", rpUpdateDaysFor(at("2026-09-09T10:00:00"), NOW) === 14);
  t("初めての物件出し → 絞らない（null）", rpUpdateDaysFor(null, NOW) === null);
  t("読めない値も絞らない", rpUpdateDaysFor("？？", NOW) === null);
}

console.log("── 対象は「直近3日に送った人」と「まだ一度も送っていない人」だけ");
{
  const customers = [
    { id: "a", status: "hot", last_property_sent_at: at("2026-09-18T20:00:00"), created_at: at("2026-08-01T10:00:00") },     // 昨日送った
    { id: "b", status: "property_search", last_property_sent_at: at("2026-09-16T10:00:00"), created_at: at("2026-08-01T10:00:00") }, // 3日前
    { id: "c", status: "new_inquiry", last_property_sent_at: null, created_at: at("2026-09-18T09:00:00") },   // 昨日きた新規
    { id: "d", status: "property_search", last_property_sent_at: null, created_at: at("2026-09-17T09:00:00") }, // 2日前にきた新規
    { id: "e", status: "property_search", last_property_sent_at: at("2026-09-10T10:00:00"), created_at: at("2026-08-01T10:00:00") }, // 9日前に送った → 対象外
    { id: "f", status: "applying", last_property_sent_at: at("2026-09-18T10:00:00"), created_at: at("2026-08-01T10:00:00") }, // 申込中 → 対象外
    { id: "g", status: "pending", last_property_sent_at: null, created_at: at("2026-09-18T09:00:00") },        // 保留 → 対象外
    { id: "h", status: "property_search", last_property_sent_at: null, created_at: at("2026-06-01T09:00:00") }, // 3か月前の放置客 → 対象外
  ];
  const got = selectAutoSearchTargets(customers, { nowMs: NOW });
  t("★ 対象は a・b・c・d の4人", eq(got.map((x) => x.id).sort(), ["a", "b", "c", "d"]), JSON.stringify(got.map((x) => x.id)));
  t("★ 9日前に送った人は入らない（3日以内ではない）", !got.some((x) => x.id === "e"));
  t("★ 申込中は入らない", !got.some((x) => x.id === "f"));
  t("保留は入らない", !got.some((x) => x.id === "g"));
  t("★ 3か月前に登録されたまま送っていない放置客は入らない（実データで98人いた）", !got.some((x) => x.id === "h"));
  t("hot が先頭（返事が来ている人を優先）", got[0].id === "a", JSON.stringify(got.map((x) => x.id)));
  t("a の更新日は1日以内", got.find((x) => x.id === "a")?.rpUpdateDays === 1);
  t("b の更新日は3日以内", got.find((x) => x.id === "b")?.rpUpdateDays === 3);
  t("新規は絞らない（null）", got.find((x) => x.id === "c")?.rpUpdateDays === null);
  t("理由が付いている", got.find((x) => x.id === "a")?.reason === "recent_sent" && got.find((x) => x.id === "c")?.reason === "new_customer");
  t(`「3日以内」は ${RECENT_SENT_DAYS} 日`, RECENT_SENT_DAYS === 3);
}

console.log("── ★ 「物件出しした」は送信だけでなく**確認**も含む（2026-09-19 竹内）");
{
  // 一覧の「送:」＝ last_property_sent_at ／「確:」＝ property_viewed_at（拡張 popup.js）
  const customers = [
    // 送信は9日前だが、確認は昨日 → 対象（確認の方が新しい）
    { id: "v1", status: "property_search", last_property_sent_at: at("2026-09-10T10:00:00"), property_viewed_at: at("2026-09-18T15:00:00"), created_at: at("2026-06-01T10:00:00") },
    // 一度も送っていないが確認だけした（3日前）→ 対象
    { id: "v2", status: "property_search", last_property_sent_at: null, property_viewed_at: at("2026-09-16T10:00:00"), created_at: at("2026-06-01T10:00:00") },
    // 送信も確認も9日前 → 対象外
    { id: "v3", status: "property_search", last_property_sent_at: at("2026-09-10T10:00:00"), property_viewed_at: at("2026-09-10T11:00:00"), created_at: at("2026-06-01T10:00:00") },
  ];
  const got = selectAutoSearchTargets(customers, { nowMs: NOW });
  t("★ 送信は古いが確認が新しい人は対象", got.some((x) => x.id === "v1"), JSON.stringify(got.map((x) => x.id)));
  t("★ 送信ゼロでも確認していれば対象", got.some((x) => x.id === "v2"));
  t("どちらも古ければ対象外", !got.some((x) => x.id === "v3"));
  t("★ 更新日は新しい方（確認=昨日）で計算する → 1日以内", got.find((x) => x.id === "v1")?.rpUpdateDays === 1, JSON.stringify(got));
  t("確認3日前なら3日以内", got.find((x) => x.id === "v2")?.rpUpdateDays === 3);
  t("新しい方を返す関数", lastPropertyTouchAt({ last_property_sent_at: at("2026-09-10T10:00:00"), property_viewed_at: at("2026-09-18T15:00:00") }) === at("2026-09-18T15:00:00"));
  t("片方しか無ければそれを返す", lastPropertyTouchAt({ last_property_sent_at: null, property_viewed_at: at("2026-09-16T10:00:00") }) === at("2026-09-16T10:00:00"));
  t("どちらも無ければ null", lastPropertyTouchAt({ last_property_sent_at: null, property_viewed_at: null }) === null);
}

console.log("── ★ 新規（まだ出していない人）も3日以内（2026-09-19 竹内）");
{
  t(`新規の窓は ${NEW_CUSTOMER_DAYS} 日`, NEW_CUSTOMER_DAYS === 3);
  const customers = [
    { id: "n1", status: "new_inquiry", last_property_sent_at: null, created_at: at("2026-09-17T09:00:00") }, // 2日前 → 対象
    { id: "n2", status: "new_inquiry", last_property_sent_at: null, created_at: at("2026-09-16T09:00:00") }, // 3日前 → 対象
    { id: "n3", status: "new_inquiry", last_property_sent_at: null, created_at: at("2026-09-14T09:00:00") }, // 5日前 → 対象外
  ];
  const got = selectAutoSearchTargets(customers, { nowMs: NOW }).map((x) => x.id);
  t("★ 2日前・3日前は対象、5日前は対象外", eq(got.sort(), ["n1", "n2"]), JSON.stringify(got));
}

console.log("── 多すぎる時は優先順位の高い順に上限で切る（11:00〜17:00 で終わらせるため）");
{
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: `id-${String(i).padStart(3, "0")}`,
    status: i < 5 ? "hot" : "property_search",
    last_property_sent_at: i < 60 ? at("2026-09-18T20:00:00") : null,
    created_at: at("2026-09-17T09:00:00"),
  }));
  const got = selectAutoSearchTargets(many, { nowMs: NOW });
  t(`上限 ${MAX_TARGETS_PER_RUN} 件で切れる`, got.length === MAX_TARGETS_PER_RUN, String(got.length));
  t("hot が先に入る", got.slice(0, 5).every((x) => Number(x.id.slice(3)) < 5), JSON.stringify(got.slice(0, 6).map((x) => x.id)));
  t("上限を指定できる", selectAutoSearchTargets(many, { nowMs: NOW, limit: 7 }).length === 7);
  t("0件の時は空", eq(selectAutoSearchTargets([], { nowMs: NOW }), []));
}

console.log("── 11時の便（AD高い順・更新日は人ごと）");
{
  const target = { id: "a", reason: "recent_sent" as const, rpUpdateDays: 3 };
  const p = buildAutoSearchPayload("am", target, NOW);
  t("並びは AD 高い順", p.sort === "ad");
  t("★ 更新日は人ごとの値（3日以内）", p.rp_update_days === 3);
  // 2026-09-30 v2.5.42 竹内「ページの上限は 5 ページまで上げる」（3 → 5・拡張の既定 DEFAULT_MAX_PAGES と同じ）
  t("ページは 5ページまで（SEARCH_MAX_PAGES）", p.max_pages === 5 && SEARCH_MAX_PAGES === 5);
  // 2026-09-30 v2.5.44 竹内さんの決定: 午前もピンポイントから（AUTO_SEARCH_PLAN=legacy の時だけ LEGACY_AM_IS_WIDE＝広げて）
  t("★ 11時もピンポイント（v2.5.44・旧 2026-09-19 の広げては legacy だけ）", p.is_wide === false && LEGACY_AM_IS_WIDE === true);
  t("日付が入る（同じ日に二重で積まないための鍵）", p.jst_date === "2026-09-19");
  t("source で見分けられる", p.source === "auto_schedule" && p.mode === "am");
}

console.log("── 17時の便（本日の更新日付・更新順・1ページだけ）");
{
  const target = { id: "a", reason: "recent_sent" as const, rpUpdateDays: 3 };
  const p = buildAutoSearchPayload("pm", target, NOW);
  t("★ 本日の更新日付（更新日1日以内）＝人ごとの値を使わない", p.rp_update_days === 1);
  t("★ AD順ではなく更新順", p.sort === "updated");
  // 2026-09-30 v2.5.42 1ページ → 5ページ（更新日1日以内の中を最後まで見る・旧は点検で cut_by_pages が出ていた）
  t("★ 5ページまで（更新日1日以内で絞る）", p.max_pages === 5);
  t("新規の人も同じ（当日で絞る）", buildAutoSearchPayload("pm", { id: "c", reason: "new_customer", rpUpdateDays: null }, NOW).rp_update_days === 1);
  t("指定はまとめて定数にしてある", PM_LATEST.rpUpdateDays === 1 && PM_LATEST.sort === "updated" && PM_LATEST.maxPages === SEARCH_MAX_PAGES);
  t("★ 17時はピンポイント検索（広げない）", p.is_wide === false);
  t("★ 17時は1コマンドにまとめる／11時は1人1コマンド", isBatchedRun("pm") === true && isBatchedRun("am") === false);
  t("17時は target が無くても作れる（全員同じ条件だから）", buildAutoSearchPayload("pm", null, NOW).rp_update_days === 1);
}

console.log("── ★ 2026-09-27 ITANDI も積む・開始は窓の中で毎日ばらつく（10:15〜11:15・16:15〜17:15 JST）");
{
  t("★ 自動便はリアプロ → ITANDI の順", eq([...AUTO_SEARCH_SITES], ["realnetpro", "itandi"]));
  const jst = (ms: number) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 19);
  const days: string[] = [];
  for (let d = 0; d < 120; d++) days.push(new Date(Date.parse("2026-09-01T12:00:00+09:00") + d * 86_400_000 + 9 * 3600 * 1000).toISOString().slice(0, 10));
  let inWin = true, sameMinute = 0;
  const ams = new Set<string>();
  for (const mode of ["am", "pm"] as const) {
    const w = START_WINDOWS[mode];
    let prevOff: number | null = null;
    for (const d of days) {
      const ms = autoStartAtMs(mode, d);
      const lo = Date.parse(`${d}T00:00:00+09:00`) + w.fromMin * 60_000;
      if (ms < lo || ms >= lo + (w.toMin - w.fromMin) * 60_000) inWin = false;
      const off = startOffsetSec(mode, d);
      if (prevOff !== null && Math.abs(off - prevOff) < MIN_DAY_TO_DAY_DIFF_SEC) sameMinute++;
      prevOff = off;
      if (mode === "am") ams.add(jst(ms).slice(0, 5));
    }
  }
  t("★ 120日×2便すべて窓の中（午前 10:15〜11:15・午後 16:15〜17:15）", inWin);
  t("★ 前の日といつも7分以上ずれる", sameMinute === 0, String(sameMinute));
  t("★ 毎日違う時刻（120日で窓の60分のうち45通り以上の分に散る）", ams.size >= 45, String(ams.size));
  t("同じ日・同じ便は何度計算しても同じ（cron の再実行と二重積みの防止が食い違わない）", autoStartAtMs("am", "2026-09-28") === autoStartAtMs("am", "2026-09-28"));
  t("午前と午後は窓の中の位置が別", startOffsetSec("am", "2026-09-28") !== startOffsetSec("pm", "2026-09-28"));
  t("前の日との差の下限は7分", MIN_DAY_TO_DAY_DIFF_SEC === 420);
  t("数え始めより前の日も窓の中", startOffsetSec("am", "2025-06-01") >= 0 && startOffsetSec("am", "2025-06-01") < 3600);
  const r1 = seededRandom("x"), r2 = seededRandom("x");
  t("種が同じなら乱数も同じ", r1() === r2() && r1() === r2());
  t("種が違えば違う", seededRandom("a")() !== seededRandom("b")());
  let roundish = 0;
  for (const d of days) { if (startOffsetSec("am", d) % 300 === 0) roundish++; }
  t("5分刻みちょうどに揃わない（秒まで散る）", roundish <= 3, String(roundish));
}

console.log("── ★ 午前の便は1人ずつ不規則な間でずらす（notBeforeSchedule）");
{
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const sch = notBeforeSchedule("am", "2026-09-28", ids);
  t("1人目は開始時刻", sch[0].notBeforeMs === autoStartAtMs("am", "2026-09-28"));
  const gaps = sch.slice(1).map((x, i) => (x.notBeforeMs - sch[i].notBeforeMs) / 1000);
  t("★ 間は 40〜360秒", gaps.every((g) => g >= 40 && g <= 360), JSON.stringify(gaps));
  t("★ 間は毎回違う", new Set(gaps).size === gaps.length, JSON.stringify(gaps));
  t("順番は積む順のまま（時刻が増えていく）", sch.every((x, i) => i === 0 || x.notBeforeMs > sch[i - 1].notBeforeMs));
  t("同じ人でも日が変われば間が変わる", customerGapSec("am", "2026-09-28", "b") !== customerGapSec("am", "2026-09-29", "b"));
  let breath = 0;
  const N = 300;
  for (let k = 0; k < N; k++) { if (customerGapSec("am", "2026-09-28", "id" + k) >= 180) breath++; }
  t("時々一息（180秒以上）が入る（1〜3割）", breath / N > 0.08 && breath / N < 0.3, `${breath}/${N}`);
  t("空なら空", eq(notBeforeSchedule("am", "2026-09-28", []), []));
}

console.log("── ★ /api/automation/pending は not_before より前を渡さない・3時間は not_before から数える");
{
  const now = Date.parse("2026-09-28T10:30:00+09:00");
  const iso = (j: string) => new Date(`${j}+09:00`).toISOString();
  t("★ not_before 前は渡さない", !isClaimableNow({ source: "auto_schedule", not_before: iso("2026-09-28T10:41:07") }, now));
  t("★ not_before を過ぎたら渡す", isClaimableNow({ source: "auto_schedule", not_before: iso("2026-09-28T10:29:59") }, now));
  t("not_before の無い物（手動・web_brain・古い自動便）は今までどおりすぐ渡す", isClaimableNow({ source: "web_brain" }, now) && isClaimableNow(null, now));
  t("読めない not_before は渡す（止めない）", isClaimableNow({ not_before: "??" }, now));
  const row = { created_at: iso("2026-09-28T10:00:00"), payload: { source: "auto_schedule", not_before: iso("2026-09-28T11:10:00") } };
  t("★ 3時間は not_before から（10:00 に積んで 11:10 開始 → 14:10 まで待つ）", waitStartMs(row) === Date.parse(iso("2026-09-28T11:10:00")));
  t("14:05 はまだ閉じない", !isPickerWaitExpired(row, Date.parse(iso("2026-09-28T14:05:00"))));
  t("14:11 に閉じる", isPickerWaitExpired(row, Date.parse(iso("2026-09-28T14:11:00"))));
  t("not_before の無い物は積んだ時刻から（今までどおり）", isPickerWaitExpired({ created_at: iso("2026-09-28T07:00:00"), payload: {} }, now) && WAIT_FOR_PICKER_MS === 3 * 3600 * 1000);
  // 2026-09-30 午前の便60人×1人1命令を1台が順に拾う: 後ろの人は「前の人が終わってから」3時間を数える
  const late = { created_at: iso("2026-09-30T10:00:00"), payload: { source: "auto_schedule", not_before: iso("2026-09-30T11:40:00") } };
  const active = Date.parse(iso("2026-09-30T16:20:00")); // 拾い手が最後に動いた（前の人が終わった）
  t("★ 拾い手が動いている間は閉じない（not_before 11:40 から4時間50分・前の人が終わって10分）", !isPickerWaitExpired(late, Date.parse(iso("2026-09-30T16:30:00")), active));
  t("拾い手が無い（動きが無い）なら今まで通り 14:41 に閉じる", isPickerWaitExpired(late, Date.parse(iso("2026-09-30T14:41:00")), null));
  t("拾い手が最後に動いてから3時間で閉じる", isPickerWaitExpired(late, Date.parse(iso("2026-09-30T19:21:00")), active) && !isPickerWaitExpired(late, Date.parse(iso("2026-09-30T19:19:00")), active));
  t("延ばすのは not_before から12時間まで（夜通しの古い指示で検索しない）", isPickerWaitExpired(late, Date.parse(iso("2026-09-30T23:41:00")), Date.parse(iso("2026-09-30T23:30:00"))) && MAX_WAIT_WHILE_ACTIVE_MS === 12 * 3600 * 1000);
  t("not_before より前の動きは使わない（今まで通り）", isPickerWaitExpired(late, Date.parse(iso("2026-09-30T14:41:00")), Date.parse(iso("2026-09-30T11:00:00"))));
  t("pickerActiveAt: picked_up_at・completed_at の一番新しい物", pickerActiveAt([{ picked_up_at: iso("2026-09-30T12:00:00"), completed_at: iso("2026-09-30T12:07:00") }, { picked_up_at: iso("2026-09-30T12:09:00"), completed_at: null }]) === Date.parse(iso("2026-09-30T12:09:00")) && pickerActiveAt([]) === null);
}

console.log("── 配線（cron・pending・vercel.json）");
{
  const root = path.join(__dirname, "../../..");
  const cron = fs.readFileSync(path.join(root, "app/api/cron/auto-property-search/route.ts"), "utf8");
  t("★ cron の sites はリアプロと ITANDI（積む2か所・まとめの1か所）", (cron.match(/sites: \[\.\.\.AUTO_SEARCH_SITES\]/g) || []).length === 3 && !/sites: \["realnetpro"\]/.test(cron));
  t("★ 午後の便は not_before＝その日の開始時刻", /not_before: new Date\(autoStartAtMs\(mode, jstDate\)\)\.toISOString\(\)/.test(cron));
  t("★ 午前の便は1人ずつ notBeforeSchedule", /notBeforeSchedule\(mode, jstDate, toQueue\.map/.test(cron));
  t("同じ日・同じ便の二重積みの防止は今までどおり", /\.eq\("payload->>jst_date", jstDate\)/.test(cron));
  const pend = fs.readFileSync(path.join(root, "app/api/automation/pending/route.ts"), "utf8");
  t("★ pending は pickClaimable で選ぶ（isClaimableNow・自動便でない物が先）", pend.includes("const cmd = pickClaimable(commands ?? [], nowMs);"));
  {
    const iso2 = (j: string) => new Date(`${j}+09:00`).toISOString();
    const q = [
      { id: "am1", payload: { source: "auto_schedule", not_before: iso2("2026-09-30T11:00:00") } },
      { id: "am2", payload: { source: "auto_schedule", not_before: iso2("2026-09-30T11:02:00") } },
      { id: "wb", payload: { source: "web_brain" } },
      { id: "pm1", payload: { source: "auto_schedule", not_before: iso2("2026-09-30T16:20:00") } },
    ];
    const at = (h: string) => Date.parse(iso2(`2026-09-30T${h}:00`));
    t("★ 手の検索（web_brain）は自動便の残りより先に渡す", pickClaimable(q, at("14:00"))?.id === "wb");
    t("自動便どうしは古い順（午前の続きが先）", pickClaimable(q.filter((x) => x.id !== "wb"), at("16:30"))?.id === "am1");
    t("not_before 前の物は渡さない", pickClaimable([q[3]], at("16:00")) === null);
  }
  t("★ 期限は isPickerWaitExpired（not_before から・拾い手が動いている間は前の人が終わってから）", /isPickerWaitExpired\(r, nowMs, activeAt\)/.test(pend) && pend.includes("const activeAt = await activeAtFor(sources);"));
  const upd = fs.readFileSync(path.join(root, "app/api/automation/update/route.ts"), "utf8");
  t("★ 心拍: update が running の行の picked_up_at を新しくする（30分の見張りに戻させない）", upd.includes("const heartbeat = body.heartbeat === true || typeof body.processed_customers === \"number\";") && upd.includes(".update({ picked_up_at: new Date().toISOString() })") && upd.includes(".eq(\"status\", \"running\");"));
  const vj = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  const am = vj.crons.find((c: { path: string }) => c.path === "/api/cron/auto-property-search?mode=am");
  const pm = vj.crons.find((c: { path: string }) => c.path === "/api/cron/auto-property-search?mode=pm");
  t("★ cron は窓より前に積むだけ（10:00 JST＝01:00 UTC）", am?.schedule === "0 1 * * *", am?.schedule);
  t("★ cron は窓より前に積むだけ（16:00 JST＝07:00 UTC）", pm?.schedule === "0 7 * * *", pm?.schedule);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
