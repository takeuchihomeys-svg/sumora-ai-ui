// AIX の1通目を送った直後の2通目（aix-template-generate）にブレインの判断を届ける（2026-10-14・AIX_TEMPLATE_BRAIN_RESTORE）
// 実行: npx tsx app/lib/__tests__/aix-template-brain-restore.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restoreMetaAfterShown, SHOWN_DRAFT_SENTINEL } from "../brain-meta-restore";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`); } };
const root = join(__dirname, "..", "..", "..");
const load = readFileSync(join(root, "app/lib/brain-meta-load.ts"), "utf8");
const tmpl = readFileSync(join(root, "app/api/aix-template-generate/route.ts"), "utf8");

t("aix-template-generate は続きの番として読む（afterStaffSend: true）", /"aix-template-generate", \{ afterStaffSend: true \}\)/.test(tmpl));
t("続きの番は表示の印が無くても同じ線で戻す・戻す線 AIX_TEMPLATE_BRAIN_RESTORE", /afterStaffSend/.test(load) && /AIX_TEMPLATE_BRAIN_RESTORE/.test(load) && /ai_draft: SHOWN_DRAFT_SENTINEL/.test(load));

// 戻す線（restoreMetaAfterShown）は同じ: 最新のお客様発言を見た判断だけ・古い判断は戻さない
const last = { action: "property_recommendation", reply_mode: "aix", analyzed_msg_ts: "2026-10-10T01:00:00Z", source: "fresh" };
const base = { suggestedAixMeta: null, lastBrainMeta: last, status: "proposing", skipStatuses: ["applying"], aiDraft: SHOWN_DRAFT_SENTINEL };
t("最新のお客様発言を見た判断 → 戻す", restoreMetaAfterShown({ ...base, latestCustomerMsgAt: "2026-10-10T01:00:00Z" }).restored);
t("新しいお客様発言が後に来ている → 戻さない（stale）", restoreMetaAfterShown({ ...base, latestCustomerMsgAt: "2026-10-10T05:00:00Z" }).reason === "stale");
t("申込以降 → 戻さない", restoreMetaAfterShown({ ...base, status: "applying", latestCustomerMsgAt: "2026-10-10T01:00:00Z" }).reason === "skip_status");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
