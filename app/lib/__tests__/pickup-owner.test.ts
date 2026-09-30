// 実行: npx tsx app/lib/__tests__/pickup-owner.test.ts
// 2026-09-30 v2.5.49 物件の付け先の関所（サーバー側の2枚目の壁）と、点検の札 OWNER_MISMATCH。
//   実例は 9/30 の本番: 🐥 さん（42a89f52）の ITANDI の回（16:29〜16:42）の物件 18件が ℳ さん（382d4296）に付いた。
import { checkPickupOwner, normCustomerName, ownerStepsFrom } from "../pickup-owner";
import { runSearchAuditChecks } from "../search-audit-check";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

const M = "382d4296-abc8-40f8-93d0-ea7b8b6b0918";
const HIYO = "42a89f52-3c5d-4d51-8126-1cf064c7813e";

console.log("\n■ checkPickupOwner");
{
  const bad = checkPickupOwner({ resolvedCustomerId: M, batchOwner: { customer_id: HIYO, customer_name: "🐥", run_id: "sa_x" }, postedName: "ℳ" });
  t("★ 実例: 🐥 さんの回の物件を ℳ さんに付けようとした → 受け取らない", !bad.ok && bad.reason === "owner_mismatch");
  t("理由に両方の名前が入る", !bad.ok && bad.detail.includes("ℳ") && bad.detail.includes("🐥"), JSON.stringify(bad));
  t("本人に付けるのは通す", checkPickupOwner({ resolvedCustomerId: HIYO, batchOwner: { customer_id: HIYO } }).ok);
  t("batch_owner が無い送信（手の検索・スタッフ・古い版）は通す", checkPickupOwner({ resolvedCustomerId: M, batchOwner: null }).ok);
  t("batch_owner に ID が無い時は通す", checkPickupOwner({ resolvedCustomerId: M, batchOwner: { customer_name: "🐥" } }).ok);
  t("相手が決まっていない時は通す（後ろの処理が今まで通り扱う）", checkPickupOwner({ resolvedCustomerId: null, batchOwner: { customer_id: HIYO } }).ok);
}

console.log("\n■ normCustomerName");
{
  t("末尾の「さん」「様」と空白を除く", normCustomerName("松浦 麻夜さん") === "松浦麻夜" && normCustomerName("YUMA様") === "YUMA");
  t("全角は半角にそろえる", normCustomerName("ＹＵＭＡ") === "YUMA");
  t("空は空", normCustomerName(null) === "");
}

console.log("\n■ ownerStepsFrom と札");
{
  const steps = [{ k: "begin", d: "bulk_queue", at: 1 }, { k: "owner_mismatch", d: "送る相手 382d4296（ℳ）が、検索している回のお客様 42a89f52（🐥）と違う", at: 2 }, { k: "finish", d: "ok", at: 3 }];
  const own = ownerStepsFrom(steps);
  t("付け先のずれの段を拾う", own.mismatch.length === 1 && own.nameDrift.length === 0);
  const v = runSearchAuditChecks({ site: "itandi", status: "finished", steps } as never);
  const c = v.checks.find((x) => x.code === "OWNER_MISMATCH");
  t("★ 点検に OWNER_MISMATCH（bad）の札", !!c && c.severity === "bad" && c.cause_key === "owner_mismatch:itandi", JSON.stringify(c));
  const v2 = runSearchAuditChecks({ site: "itandi", status: "finished", steps: [{ k: "owner_name_drift", d: "見出しの名前「ℳ」が回のお客様「🐥」と違う", at: 2 }] } as never);
  const c2 = v2.checks.find((x) => x.code === "OWNER_MISMATCH");
  t("名前ずれは warn の札（直して送った）", !!c2 && c2.severity === "warn" && c2.cause_key === "owner_name_drift:itandi");
  const v3 = runSearchAuditChecks({ site: "itandi", status: "finished", steps: [{ k: "begin", d: "bulk_queue", at: 1 }] } as never);
  t("段が無い回には札を付けない", !v3.checks.some((x) => x.code === "OWNER_MISMATCH"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
