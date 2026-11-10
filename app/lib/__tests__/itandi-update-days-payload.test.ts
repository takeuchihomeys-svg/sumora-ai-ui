// app/lib/__tests__/itandi-update-days-payload.test.ts
// 2026-11-10 DB_STRUCTURE.md の混ざっている所 2: 一括検索・自動便の payload に ITANDI の更新日（itandi_update_days）を載せる（サーバー側）。
//   ITANDI はリアプロの手の指定（rp_update_days）を使わず、ITANDI の手の指定 → 無ければ自動。計画（空いた時間で広げる）はリアプロと同じ線。
// 実行: npx tsx app/lib/__tests__/itandi-update-days-payload.test.ts（全 PASS で exit 0）
import { effectiveItandiUpdateDays, effectiveRpUpdateDays } from "../rp-update-days";
import { itandiPlanFrom, planPayload, planUpdateDays, planFor } from "../search-update-days";
import { buildWebBrainCommands } from "../web-brain-search";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const H = 3600 * 1000;
const NOW = Date.parse("2026-11-10T15:00:00+09:00");
const at = (jst: string) => new Date(`${jst}+09:00`).toISOString();

console.log("── ITANDI の更新日（手の指定 → 自動・リアプロの手の指定は使わない）");
{
  const sentYesterday = at("2026-11-09T18:00:00");
  t("★ ITANDI の手の指定が先（itandi=3・rp=7 → 3）", effectiveItandiUpdateDays({ rp_update_days: 7, itandi_update_days: 3, last_property_sent_at: sentYesterday }, NOW) === 3);
  t("★ リアプロの手の指定（7）は ITANDI に使わない → 自動（昨日→1）", effectiveItandiUpdateDays({ rp_update_days: 7, itandi_update_days: null, last_property_sent_at: sentYesterday }, NOW) === 1);
  t("リアプロは今まで通り 7", effectiveRpUpdateDays({ rp_update_days: 7, itandi_update_days: 3, last_property_sent_at: sentYesterday }, NOW) === 7);
  t("両方の手の指定が無ければ同じ自動の値", effectiveItandiUpdateDays({ last_property_sent_at: sentYesterday }, NOW) === effectiveRpUpdateDays({ last_property_sent_at: sentYesterday }, NOW));
  t("0・負・NaN は手の指定でない（自動）",
    effectiveItandiUpdateDays({ itandi_update_days: 0, last_property_sent_at: sentYesterday }, NOW) === 1
    && effectiveItandiUpdateDays({ itandi_update_days: -1, last_property_sent_at: sentYesterday }, NOW) === 1
    && effectiveItandiUpdateDays({ itandi_update_days: NaN, last_property_sent_at: sentYesterday }, NOW) === 1);
  t("初めてのお客様は絞らない（null）", effectiveItandiUpdateDays({}, NOW) === null);
  t("null のお客様は null", effectiveItandiUpdateDays(null, NOW) === null);
}

console.log("── ITANDI の計画（リアプロと同じ空いた時間で広げる・狭めない）");
{
  const last = new Date(NOW - 49 * H).toISOString();
  const rp = planUpdateDays({ baseDays: 7, lastSearchAt: last, nowMs: NOW, lastBySite: { realpro: last } });
  const it = itandiPlanFrom(rp, 1, NOW);
  t("★ ITANDI の元の値 1 は 49時間の空きを覆えない → 3 に広げる", it.days === 3 && it.widened === true, JSON.stringify(it));
  t("リアプロは 7 のまま（覆える）", rp.days === 7 && rp.widened === false);
  t("前回の検索・止める線はリアプロの計画と同じ", it.last_search_at === rp.last_search_at && JSON.stringify(it.last_by_site) === JSON.stringify(rp.last_by_site));
  t("広い手の指定（14）は狭めない", itandiPlanFrom(rp, 14, NOW).days === 14);
  const noLast = planUpdateDays({ baseDays: 7, lastSearchAt: null, nowMs: NOW });
  t("前回の検索の記録なし → ITANDI の元の値のまま", itandiPlanFrom(noLast, 3, NOW).days === 3);
  t("元の値 null（指定なし）は null のまま", itandiPlanFrom(rp, null, NOW).days === null);
  const old = planUpdateDays({ baseDays: 1, lastSearchAt: new Date(NOW - 20 * 24 * H).toISOString(), nowMs: NOW });
  t("14日でも覆えない空き → 指定なし（null）", itandiPlanFrom(old, 1, NOW).days === null);

  const p = planPayload([{ id: "c1", plan: rp, itandiPlan: it }, { id: "c2", plan: rp }]);
  t("★ planPayload に itandi_days（拡張が ITANDI で読む）", p.by_customer.c1.itandi_days === 3 && p.by_customer.c1.days === 7);
  t("itandiPlan が無い行は itandi_days を書かない（拡張は days に落とす）", !("itandi_days" in p.by_customer.c2));
  t("planFor で読める", planFor({ update_days_plan: p }, "c1")?.itandi_days === 3);
}

console.log("── AIXツールの一括検索の payload（web_brain）");
{
  const { rows } = buildWebBrainCommands([
    { id: "c1", rp_update_days: 7, itandi_update_days: 3 },
    { id: "c2", rp_update_days: 7, last_property_sent_at: at("2026-11-09T18:00:00") },
    { id: "c3" },
  ], ["realnetpro", "itandi"], false, { nowMs: NOW });
  t("★ ITANDI の手の指定は ITANDI だけ（rp=7・itandi=3）", rows[0].payload.rp_update_days === 7 && rows[0].payload.itandi_update_days === 3);
  t("★ ITANDI の手の指定が無ければ自動（rp=7・itandi=1）", rows[1].payload.rp_update_days === 7 && rows[1].payload.itandi_update_days === 1);
  t("初めては両方 null（キーはある＝拡張は ITANDI の値として読む）", rows[2].payload.rp_update_days === null && "itandi_update_days" in rows[2].payload && rows[2].payload.itandi_update_days === null);
  const { rows: rpOnly } = buildWebBrainCommands([{ id: "c1", rp_update_days: 7, itandi_update_days: 3 }], "realnetpro", false, { nowMs: NOW });
  t("リアプロだけの命令にも載せる（後から itandi を足す fold のため）", rpOnly[0].payload.itandi_update_days === 3);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
