// app/lib/__tests__/auto-search-schedule.test.ts
// 2026-09-19 竹内: 毎日11:00（3日以内に物件出しした人・新規のお客さん／更新日は本来の通り）と
//   17:00（本日の更新日付・更新順・1ページ）の自動物件検索。
// 実行: npx tsx app/lib/__tests__/auto-search-schedule.test.ts（全 PASS で exit 0）
import {
  rpUpdateDaysFor, selectAutoSearchTargets, buildAutoSearchPayload, lastPropertyTouchAt, isBatchedRun,
  RECENT_SENT_DAYS, NEW_CUSTOMER_DAYS, MAX_TARGETS_PER_RUN, PM_LATEST,
} from "../auto-search-schedule";

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
  t("ページは今まで通り（1ページに絞らない）", p.max_pages === 3);
  t("★ 11時は広げて検索（2026-09-19 竹内）", p.is_wide === true);
  t("日付が入る（同じ日に二重で積まないための鍵）", p.jst_date === "2026-09-19");
  t("source で見分けられる", p.source === "auto_schedule" && p.mode === "am");
}

console.log("── 17時の便（本日の更新日付・更新順・1ページだけ）");
{
  const target = { id: "a", reason: "recent_sent" as const, rpUpdateDays: 3 };
  const p = buildAutoSearchPayload("pm", target, NOW);
  t("★ 本日の更新日付（更新日1日以内）＝人ごとの値を使わない", p.rp_update_days === 1);
  t("★ AD順ではなく更新順", p.sort === "updated");
  t("★ 1ページだけ", p.max_pages === 1);
  t("新規の人も同じ（当日で絞る）", buildAutoSearchPayload("pm", { id: "c", reason: "new_customer", rpUpdateDays: null }, NOW).rp_update_days === 1);
  t("指定はまとめて定数にしてある", PM_LATEST.rpUpdateDays === 1 && PM_LATEST.sort === "updated" && PM_LATEST.maxPages === 1);
  t("★ 17時はピンポイント検索（広げない）", p.is_wide === false);
  t("★ 17時は1コマンドにまとめる／11時は1人1コマンド", isBatchedRun("pm") === true && isBatchedRun("am") === false);
  t("17時は target が無くても作れる（全員同じ条件だから）", buildAutoSearchPayload("pm", null, NOW).rp_update_days === 1);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
