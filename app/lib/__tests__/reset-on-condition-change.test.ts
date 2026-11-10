// app/lib/__tests__/reset-on-condition-change.test.ts
// 2026-11-10 条件が変わった時に戻す列（RESET_ON_CONDITION_CHANGE）: リアプロの rp_update_days だけでなく ITANDI の itandi_update_days も戻す。
//   戻す所（line-webhook-text・generate-draft-bg-async・household-change-server）が全部この1つを使っているか（配線）も確かめる。
// 実行: npx tsx app/lib/__tests__/reset-on-condition-change.test.ts（全 PASS で exit 0）
import { readFileSync } from "fs";
import { join } from "path";
import { CLEAR_MANUAL_UPDATE_DAYS, RESET_ON_CONDITION_CHANGE } from "../search-update-days";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── 戻す列");
t("★ itandi_update_days も null", "itandi_update_days" in RESET_ON_CONDITION_CHANGE && RESET_ON_CONDITION_CHANGE.itandi_update_days === null);
t("rp_update_days は null", RESET_ON_CONDITION_CHANGE.rp_update_days === null);
t("前回物件を出した日も null（新しい条件で全件から）", RESET_ON_CONDITION_CHANGE.last_property_sent_at === null);
t("ちょうど3列（他の列は消さない）", Object.keys(RESET_ON_CONDITION_CHANGE).sort().join(",") === "itandi_update_days,last_property_sent_at,rp_update_days");
t("送った時の戻し（CLEAR_MANUAL_UPDATE_DAYS）は更新日の2列のまま", Object.keys(CLEAR_MANUAL_UPDATE_DAYS).sort().join(",") === "itandi_update_days,rp_update_days");
{
  const fields: Record<string, unknown> = { desired_area: "大正区", rp_update_days: 1, itandi_update_days: 1, last_property_sent_at: "2026-11-09T00:00:00Z" };
  Object.assign(fields, RESET_ON_CONDITION_CHANGE);
  t("★ 正式フォーマットの形（Object.assign）で両サイトの手の指定が消える", fields.rp_update_days === null && fields.itandi_update_days === null && fields.last_property_sent_at === null && fields.desired_area === "大正区");
}

console.log("── 配線（条件が変わった時に rp_update_days だけ戻す所が残っていない）");
const root = join(__dirname, "..", "..", "..");
const files = ["app/lib/line-webhook-text.ts", "app/api/generate-draft-bg-async/route.ts", "app/lib/household-change-server.ts"];
for (const f of files) {
  const src = readFileSync(join(root, f), "utf8");
  t(`${f}: RESET_ON_CONDITION_CHANGE を使う`, /RESET_ON_CONDITION_CHANGE/.test(src));
  t(`${f}: rp_update_days だけ null にする書き方が無い`, !/rp_update_days\s*[:=]\s*null/.test(src));
}
{
  const n = (readFileSync(join(root, "app/lib/line-webhook-text.ts"), "utf8").match(/RESET_ON_CONDITION_CHANGE/g) ?? []).length;
  t("line-webhook-text は 4か所＋import", n === 5, String(n));
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
