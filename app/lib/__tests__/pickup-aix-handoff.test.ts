// 2026-09-25 竹内「複数選択なら AIX 物件ピックアップ・1件なら AIX 物件オススメ」— 売上サポ → トークの AIX の受け渡し
// 実行: npx tsx app/lib/__tests__/pickup-aix-handoff.test.ts
import { aixTypeForPickupCount, pickupAixButtonLabel, buildPickupAixHref, parsePickupAixHandoff, PICKUP_AIX_MAX } from "../pickup-aix-handoff";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}

console.log("■ 件数で AIX の種類を決める");
t("1件 → 物件オススメ", aixTypeForPickupCount(1) === "property_recommendation");
t("2件 → 物件ピックアップ", aixTypeForPickupCount(2) === "property_send");
t("10件 → 物件ピックアップ", aixTypeForPickupCount(10) === "property_send");
t("0件 → なし", aixTypeForPickupCount(0) === null);
t("ボタン: 1件は 物件オススメ", pickupAixButtonLabel(1) === "🏠 AIX物件オススメ（1件）");
t("ボタン: 3件は 物件ピックアップ（3件）", pickupAixButtonLabel(3) === "📤 AIX物件ピックアップ（3件）");
t("ボタン: 0件はチェックを促す", /チェック/.test(pickupAixButtonLabel(0)));

console.log("■ URL を作る");
const one = buildPickupAixHref({ conversationId: "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", pickupIds: [45], batchId: "b1" });
t("1件 → aix=property_recommendation", one === "/?conv=dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7&aix=property_recommendation&pickup=45&batch=b1", one);
const many = buildPickupAixHref({ conversationId: "c", pickupIds: [3, 1, 2], batchId: "b" });
t("複数 → aix=property_send・並びはそのまま", many === "/?conv=c&aix=property_send&pickup=3%2C1%2C2&batch=b", many);
t("11件は作らない（10件まで）", buildPickupAixHref({ conversationId: "c", pickupIds: Array.from({ length: PICKUP_AIX_MAX + 1 }, (_, i) => i + 1) }) === null);
t("会話が無ければ作らない", buildPickupAixHref({ conversationId: "", pickupIds: [1] }) === null);
t("0件は作らない", buildPickupAixHref({ conversationId: "c", pickupIds: [] }) === null);

console.log("■ トーク側で URL を読む");
const r1 = parsePickupAixHandoff(new URL(`http://x${one}`).search);
t("作った URL を読める（1件＝物件オススメ）", r1?.aix === "property_recommendation" && r1.ids === "45" && r1.batch === "b1", r1);
const r2 = parsePickupAixHandoff(new URL(`http://x${many}`).search);
t("複数＝物件ピックアップ・ids は 3,1,2", r2?.aix === "property_send" && r2.ids === "3,1,2", r2);
t("旧の URL（aix=property_send で1件）は物件ピックアップのまま", parsePickupAixHandoff("?conv=c&aix=property_send&pickup=7")?.aix === "property_send");
t("物件オススメで2件来たら物件ピックアップに直す（オススメは1件だけ）", parsePickupAixHandoff("?conv=c&aix=property_recommendation&pickup=7,8")?.aix === "property_send");
t("他の aix は読まない", parsePickupAixHandoff("?conv=c&aix=estimate_sheet&pickup=7") === null);
t("pickup が無ければ読まない", parsePickupAixHandoff("?conv=c&aix=property_send") === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
