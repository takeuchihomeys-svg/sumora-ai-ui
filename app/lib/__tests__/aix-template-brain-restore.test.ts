// AIX の1通目を送った直後の2通目（aix-template-generate）にブレインの判断を届ける（2026-10-14・AIX_TEMPLATE_BRAIN_RESTORE）
// 実行: npx tsx app/lib/__tests__/aix-template-brain-restore.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restoreMetaAfterShown, staffTurnStillOpen, staffTurnSameJstDay, SHOWN_DRAFT_SENTINEL } from "../brain-meta-restore";

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

// 2026-10-14 独立レビュー: 別の番（お客様の発言の後のスタッフの最初の送信から2時間超）の判断は戻さない
const H = 3_600_000, now = Date.parse("2026-10-12T10:00:00Z");
t("スタッフの番の中（最初の送信から30分）→ 戻す", staffTurnStillOpen(now - 0.5 * H, now, 2 * H));
t("まだ答えていない番 → 戻す", staffTurnStillOpen(null, now, 2 * H));
t("別の番（最初の送信から2日）→ 戻さない", !staffTurnStillOpen(now - 48 * H, now, 2 * H));
t("読めない → 戻さない", !staffTurnStillOpen(NaN, now, 2 * H));
{
  const j = (s: string) => Date.parse(s);
  t("その日のうち: JST 9時の送信 → 同じ日の23時 → 戻す", staffTurnSameJstDay(j("2026-10-14T00:00:00Z"), j("2026-10-14T14:00:00Z")));
  t("その日のうち: JST 23時の送信 → 翌日0時半 → 戻さない", !staffTurnSameJstDay(j("2026-10-14T14:00:00Z"), j("2026-10-14T15:30:00Z")));
  t("その日のうち: まだ答えていない → 戻す", staffTurnSameJstDay(null, now));
  t("その日のうち: 読めない → 戻さない", !staffTurnSameJstDay(NaN, now));
}
t("続きの番の線は brain-meta-load が使う", /staffTurnStillOpen\(firstStaffMs/.test(load) && /other_turn/.test(load));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
