// app/lib/__tests__/rp-update-days.test.ts
// 2026-09-25 竹内「更新日も拡張ツールと連動」: ウェブ・拡張・一括検索（trigger）で更新日を同じ1つの決まりにする。
// 実行: npx tsx app/lib/__tests__/rp-update-days.test.ts（全 PASS で exit 0）
import { createRequire } from "module";
import { effectiveRpUpdateDays, autoRpUpdateDays, manualRpUpdateDays, RP_UPDATE_DAYS_CHOICES } from "../rp-update-days";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const EXT = require("../../../chrome-extension/rp-update-days.js") as {
  effectiveRpUpdateDays: (c: unknown, now?: number) => number | null;
  autoRpUpdateDays: (c: unknown, now?: number) => number | null;
  manualRpUpdateDays: (c: unknown) => number | null;
};

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
// JST 2026-09-25（金）08:30
const NOW = Date.parse("2026-09-25T08:30:00+09:00");
const at = (jst: string) => new Date(`${jst}+09:00`).toISOString();

console.log("── 手で決めた値が先（拡張の更新日の select・ウェブの切替）");
{
  t("手で 7 → 7（送った日が昨日でも）", effectiveRpUpdateDays({ rp_update_days: 7, last_property_sent_at: at("2026-09-24T10:00:00") }, NOW) === 7);
  t("null → 自動", effectiveRpUpdateDays({ rp_update_days: null, last_property_sent_at: at("2026-09-24T10:00:00") }, NOW) === 1);
  t("0 は決めていない扱い（拡張の if (c.rp_update_days) と同じ）", manualRpUpdateDays({ rp_update_days: 0 }) === null);
  t("選べる値は 1/3/7/14", JSON.stringify(RP_UPDATE_DAYS_CHOICES) === "[1,3,7,14]");
}

console.log("── 自動: 送った日と確認した日の新しい方・JST の日付で数える");
{
  t("★ 確認だけの人（送った日なし）も更新日が入る（旧ウェブは空＝すべて表示）", autoRpUpdateDays({ property_viewed_at: at("2026-09-23T15:00:00") }, NOW) === 3);
  t("★ 送った日が古くても確認した日が新しければそちら", autoRpUpdateDays({ last_property_sent_at: at("2026-09-10T10:00:00"), property_viewed_at: at("2026-09-24T21:00:00") }, NOW) === 1);
  t("★ 昨日の 23:50 に送った人（時刻の差では 0.36日だが日付では1日）→ 1", autoRpUpdateDays({ last_property_sent_at: at("2026-09-24T23:50:00") }, NOW) === 1);
  t("★ 3日前の夜（時刻の差では 2.5日）→ 3", autoRpUpdateDays({ last_property_sent_at: at("2026-09-22T20:00:00") }, NOW) === 3);
  t("4日前 → 7", autoRpUpdateDays({ last_property_sent_at: at("2026-09-21T10:00:00") }, NOW) === 7);
  t("20日前 → 14", autoRpUpdateDays({ last_property_sent_at: at("2026-09-05T10:00:00") }, NOW) === 14);
  t("初めて（どちらも無い）→ null＝絞らない", autoRpUpdateDays({}, NOW) === null);
  t("読めない値 → null", autoRpUpdateDays({ last_property_sent_at: "？？" }, NOW) === null);
  t("お客様なし → null", effectiveRpUpdateDays(null, NOW) === null);
}

console.log("── 拡張の写し（chrome-extension/rp-update-days.js）と一字一句同じ答え");
{
  const cases: Array<Record<string, unknown>> = [
    {}, { rp_update_days: 3 }, { rp_update_days: 0, last_property_sent_at: at("2026-09-24T01:00:00") },
    { rp_update_days: -1 }, { last_property_sent_at: "bad" }, { property_viewed_at: "bad", last_property_sent_at: at("2026-09-20T12:00:00") },
  ];
  // 60日分 × 1日4つの時刻 × 送った／確認した／両方
  for (let d = 0; d < 60; d++) for (const h of ["00:05:00", "08:59:00", "09:00:00", "23:59:00"]) {
    const ms = Date.parse(`2026-09-25T${h}+09:00`) - d * 86_400_000;
    const iso = new Date(ms).toISOString();
    cases.push({ last_property_sent_at: iso }, { property_viewed_at: iso }, { last_property_sent_at: iso, property_viewed_at: at("2026-09-01T12:00:00") });
  }
  let diff = 0;
  let first = "";
  for (const nowMs of [NOW, Date.parse("2026-09-25T00:01:00+09:00"), Date.parse("2026-09-25T23:59:00+09:00")]) {
    for (const c of cases) {
      const a = effectiveRpUpdateDays(c, nowMs), b = EXT.effectiveRpUpdateDays(c, nowMs);
      if (a !== b) { diff++; if (!first) first = `${JSON.stringify(c)} now=${new Date(nowMs).toISOString()} ts=${a} ext=${b}`; }
    }
  }
  t(`食い違い 0（${cases.length * 3} 通り）`, diff === 0, first);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
