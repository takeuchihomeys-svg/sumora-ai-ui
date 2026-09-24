// 物件送った表の行を「共有した／お客様に送った」「どの経路で」で読む純関数のテスト（2026-09-24）
// 実行: npx tsx app/lib/__tests__/sent-delivery.test.ts（全 PASS で exit 0）
import {
  channelFromSource, deliveryFromSource, rowDelivery, rowChannel, isCustomerRow,
  badgeKindOfRow, pickBadge, badgeNameKey,
} from "../sent-delivery";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

console.log("── channelFromSource ──");
t("line_group → extension_group", channelFromSource("line_group") === "extension_group");
t("aix:property_send → pickup", channelFromSource("aix:property_send") === "pickup");
t("aix:property_recommendation → recommendation", channelFromSource("aix:property_recommendation") === "recommendation");
t("aix:property_check_result → check", channelFromSource("aix:property_check_result") === "check");
t("aix:estimate_sheet → estimate", channelFromSource("aix:estimate_sheet") === "estimate");
t("aix:foo → aix_other", channelFromSource("aix:foo") === "aix_other");
t("staff_image → staff_image", channelFromSource("staff_image") === "staff_image");
t("vision → null（経路不明）", channelFromSource("vision") === null);
t("null → null", channelFromSource(null) === null);

console.log("── deliveryFromSource / rowDelivery / rowChannel ──");
t("line_group だけ shared", deliveryFromSource("line_group") === "shared");
t("null は customer", deliveryFromSource(null) === "customer");
t("vision は customer", deliveryFromSource("vision") === "customer");
t("aix:* は customer", deliveryFromSource("aix:property_send") === "customer");
t("列を優先（delivery=customer・source=line_group でも customer）", rowDelivery({ delivery: "customer", source: "line_group" }) === "customer");
t("列が NULL なら source から", rowDelivery({ delivery: null, source: "line_group" }) === "shared");
t("rowChannel: 列を優先（vision でも channel=pickup）", rowChannel({ channel: "pickup", source: "vision" }) === "pickup");
t("rowChannel: 列が NULL なら source から", rowChannel({ channel: null, source: "aix:property_recommendation" }) === "recommendation");
t("isCustomerRow: 共有の行は false", isCustomerRow({ source: "line_group" }) === false);
t("isCustomerRow: 読み取りの行は true", isCustomerRow({ source: "vision" }) === true);

console.log("── badgeKindOfRow / pickBadge ──");
t("共有 → shared", badgeKindOfRow({ source: "line_group" }) === "shared");
t("オススメ → recommend", badgeKindOfRow({ source: "vision", channel: "recommendation" }) === "recommend");
t("ピックアップ → pickup", badgeKindOfRow({ source: "aix:property_send" }) === "pickup");
t("物件確認 → sent", badgeKindOfRow({ source: "aix:property_check_result" }) === "sent");
t("経路不明の送付 → sent", badgeKindOfRow({ source: "vision" }) === "sent");
{
  const rows = [
    { id: "a", source: "line_group", sent_at: "2026-09-24T01:00:00Z" },
    { id: "b", source: "aix:property_send", sent_at: "2026-09-20T01:00:00Z" },
    { id: "c", source: "vision", channel: "recommendation", sent_at: "2026-09-10T01:00:00Z" },
    { id: "d", source: "vision", sent_at: "2026-09-23T01:00:00Z" },
  ];
  t("オススメ＞ピックアップ＞送付＞共有（古くてもオススメが勝つ）", pickBadge(rows)?.id === "c", pickBadge(rows));
  t("オススメが無ければピックアップ", pickBadge(rows.filter((r) => r.id !== "c"))?.id === "b");
  t("送付と共有なら送付", pickBadge([rows[0], rows[3]])?.id === "d");
  const p2 = pickBadge([
    { id: "x", source: "aix:property_send", sent_at: "2026-09-01T00:00:00Z" },
    { id: "y", source: "aix:property_send", sent_at: "2026-09-05T00:00:00Z" },
  ]);
  t("同じ種類なら新しい方", p2?.id === "y" && p2?.kind === "pickup");
  const p3 = pickBadge([{ id: "s", source: "line_group", sent_at: "2026-09-01T00:00:00Z" }]);
  t("共有だけなら shared", p3?.kind === "shared");
  t("空なら null", pickBadge([]) === null);
}

console.log("── badgeNameKey（拡張の nameKey と同じ入出力・例を固定）──");
// ⚠ chrome-extension/score-overlay.js の nameKey と目で合わせる例（片方だけ変えない）
const CASES: Array<[string, string]> = [
  ["コル・デ・ソル杭全", "コルデソル杭全"],
  ["ＹＵＭＡテスト荘", "yumaテスト荘"],
  ["グラン パシフィック　生野東", "グランパシフィック生野東"],
  ["ｱｰﾊﾞﾈｯｸｽ本町II", "アーバネックス本町ii"],
  ["A・B", ""],
];
for (const [inp, exp] of CASES) t(`「${inp}」→「${exp}」`, badgeNameKey(inp) === exp, badgeNameKey(inp));
t("null → 空", badgeNameKey(null) === "");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
