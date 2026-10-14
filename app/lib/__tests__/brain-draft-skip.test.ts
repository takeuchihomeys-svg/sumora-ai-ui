// 返信の下書きを作るかをブレインで決める（2026-10-14 竹内さん「返信なのに下書きが無い番をブレイン基準に」）
// 実行: npx tsx app/lib/__tests__/brain-draft-skip.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brainSaysNoReply, decideClosedDraftSkip, shouldQueueDraftAfterSweep, draftSlotEmpty } from "../brain-draft-skip";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, info = "") => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name} ${info}`); } };
const ON = {} as Record<string, string | undefined>;
const RULE_SKIP = { skip: true, reason: "締めで終わっていて、お客様も短い了承だけ" };
const RULE_GO = { skip: false, reason: "お客様の返事に中身がある" };

// 実データ 08eb293c（10/08）: ブレイン「お礼と了承のみのため追撃せず、短く受け止めて待つ」（返信）を規則が [返信不要] で止めていた
const brainReply = { reply_mode: "auto_reply", action: "", note: "お礼と了承を受け止める返信", reply_direction: "お礼と了承のみのため追撃せず、短く受け止めて待つ" };
const brainWait = { reply_mode: "auto_reply", action: "", note: "返信不要（お客様の連絡待ち：「決まりましたらお知らせください」とお伝え済み・お客様はお礼／お詫びだけ）。お客様から連絡が来たら新しい条件で動く", decision_source_no_aix: "rule:waiting_customer_info" };

t("ブレインが返信 → 規則が止めたがっても作る", decideClosedDraftSkip({ brainMeta: brainReply, rule: RULE_SKIP }, ON).skip === false);
t("ブレインが返信不要（連絡待ち）→ 止める", decideClosedDraftSkip({ brainMeta: brainWait, rule: RULE_GO }, ON).skip === true);
t("ブレインの判断が無い（T3）→ 旧の規則のまま（止める）", decideClosedDraftSkip({ brainMeta: null, rule: RULE_SKIP }, ON).skip === true);
t("ブレインの判断が無い（T3）→ 旧の規則のまま（作る）", decideClosedDraftSkip({ brainMeta: null, rule: RULE_GO }, ON).skip === false);
t("BRAIN_DRAFT_SKIP=off → 旧の規則", decideClosedDraftSkip({ brainMeta: brainReply, rule: RULE_SKIP }, { BRAIN_DRAFT_SKIP: "off" }).skip === true);
t("note が「返信不要」で始まる時だけ返信不要（文中の語では決めない）", brainSaysNoReply({ note: "返信不要（本日の内覧の送り出し済み）" }) && !brainSaysNoReply({ note: "お客様は返信不要と言っている…" }));

t("sweep: ブレイン返信・下書き空 → 待ち行列", shouldQueueDraftAfterSweep({ meta: brainReply, aiDraft: null, lastSender: "customer" }, ON).queue);
t("sweep: ブレイン返信・[AIX誘導中] の残り → 待ち行列", shouldQueueDraftAfterSweep({ meta: brainReply, aiDraft: "[AIX誘導中]", lastSender: "customer" }, ON).queue);
t("sweep: ブレイン AIX → 載せない", !shouldQueueDraftAfterSweep({ meta: { reply_mode: "aix", action: "property_send" }, aiDraft: null, lastSender: "customer" }, ON).queue);
t("sweep: ブレイン返信不要 → 載せない", !shouldQueueDraftAfterSweep({ meta: brainWait, aiDraft: null, lastSender: "customer" }, ON).queue);
t("sweep: 本文の下書きが残っている → 触らない", !shouldQueueDraftAfterSweep({ meta: brainReply, aiDraft: "かしこまりました！！", lastSender: "customer" }, ON).queue);
t("sweep: スタッフの番 → 載せない", !shouldQueueDraftAfterSweep({ meta: brainReply, aiDraft: null, lastSender: "staff" }, ON).queue);
t("sweep: BRAIN_SWEEP_QUEUE_DRAFT=off → 載せない", !shouldQueueDraftAfterSweep({ meta: brainReply, aiDraft: null, lastSender: "customer" }, { BRAIN_SWEEP_QUEUE_DRAFT: "off" }).queue);
t("下書きの欄: 空・印は空き／本文は空きでない", draftSlotEmpty("") && draftSlotEmpty(" [返信不要] ") && !draftSlotEmpty("はい😊！！"));

// 配線（文で確かめる）
const root = join(__dirname, "..", "..", "..");
const bg = readFileSync(join(root, "app/api/generate-draft-bg-async/route.ts"), "utf8");
const sw = readFileSync(join(root, "app/api/cron/brain-sweep/route.ts"), "utf8");
t("bg-async は締めの後の規則をブレインで決める（decideClosedDraftSkip に brainGateDirect の meta）", /decideClosedDraftSkip\(\{ brainMeta: brainGateDirect\?\.meta/.test(bg));
t("bg-async: reply_mode=aix の止めは規則より前（今まで通り）", bg.indexOf('brainGateDirect?.meta?.reply_mode === "aix"') > 0 && bg.indexOf('brainGateDirect?.meta?.reply_mode === "aix"') < bg.indexOf("decideClosedDraftSkip({"));
t("brain-sweep はブレインの後に待ち行列の判定（draft_pending_at を 61秒前に）", /shouldQueueDraftAfterSweep\(/.test(sw) && /draft_pending_at: new Date\(Date\.now\(\) - 61_000\)/.test(sw));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
