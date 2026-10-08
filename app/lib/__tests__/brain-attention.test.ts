// app/lib/__tests__/brain-attention.test.ts — 2026-10-08 竹内さんの決定「ブレイン最優先・判断はブレインに一本化」
// （実行: npx tsx app/lib/__tests__/brain-attention.test.ts）
// 実物: 10/08 の本番の判断（suggested_aix_meta）と、語で作られていた やること（line_tasks）の組
import {
  brainTaskTypes, brainTaskTypesToCancel, brainNeedsStaff, classifyTarget, brainHotDecision, targetSummary,
  nonBrainBannerAllowed, compareTargets, flagOn, type AttentionMeta,
} from "../brain-attention";
import { decideAutoTask } from "../property-check-task";
import { buildActionLedger } from "../action-ledger";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const NOW = Date.parse("2026-10-08T03:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const same = (a: unknown[] | null, b: unknown[]) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());

console.log("■ 1. やること（line_tasks）はブレインの判断から");
// 実物 👾（10/08 03:23）: 条件のフォーマット → スタッフ「ピックアップさせて頂きます」→ ブレイン property_send・promise:pickup・pending_pickup
t("👾 promise:pickup・pending_pickup → 物件出し", same(brainTaskTypes({ action: "property_send", reply_mode: "aix", decision_source: "promise:pickup", pending_pickup: true }), ["property_send"]));
// 実物 陽香（10/08 03:35）: AIX なし・返信（auto_reply）でも、ピックアップの約束が残っている → 物件出し
t("陽香 AIX なし・pending_pickup=true → 物件出し（約束は台帳が持つ）", same(brainTaskTypes({ action: "", reply_mode: "auto_reply", pending_pickup: true }), ["property_send"]));
// 実物 𝑛𝑎: ブレインが AIX【物件ピックアップした】（llm）・約束なし → line_tasks には置かない（AIX要対応がやること）
t("𝑛𝑎 約束の無い 物件ピックアップした → line_tasks に置かない", same(brainTaskTypes({ action: "property_send", reply_mode: "aix", decision_source: "llm" }), []));
// その理由: pending の物件出しを台帳は「こちらがピックアップを宣言（未履行）」と読む → pending_pickup のループになる
{
  const l = buildActionLedger({ messages: [{ sender: "customer", text: "物件送ってください", created_at: ago(1) } as never], lineTasks: [{ task_type: "property_send", status: "pending", created_at: ago(0.5) }], now: NOW });
  t("（理由の確認）pending の物件出しの line_tasks は台帳でピックアップの約束になる", l.facts.pickupPromisedUnfulfilled === true);
}
// 実物 ゆなまる（10/08）: 確認の約束を果たす番（promise:check・物件確認した） → 物件確認
t("ゆなまる promise:check → 物件確認", same(brainTaskTypes({ action: "property_check_result", reply_mode: "aix", decision_source: "promise:check" }), ["property_check"]));
// 実物 はる（申込中・llm 物件確認した・check_pattern なし）→ 物件確認（旧の autoDetectTask と同じ材料）
t("はる 物件確認した（募集状況）→ 物件確認", same(brainTaskTypes({ action: "property_check_result", reply_mode: "aix", decision_source: "llm", check_pattern: null }), ["property_check"]));
// brain-core が pending の物件確認を「確認待ち」の材料に読む所（detectSignalBasedAixFallback の pendingTaskTypes・台帳の confirmation_promised）:
//   ブレインが置いた物件確認（同じ task_type・status=pending）を入れると、旧の語で作った物と同じ材料が出る
{
  const types = brainTaskTypes({ action: "property_check_result", reply_mode: "aix", decision_source: "llm" }) ?? [];
  const lineTasks = types.map((tt) => ({ task_type: tt, status: "pending", created_at: ago(0.2) }));
  const pendingTaskTypes = lineTasks.map((x) => x.task_type);
  t("（材料）ブレイン由来の物件確認 → pendingTaskTypes に property_check（信号4・5 の「回答待ち」）", pendingTaskTypes.includes("property_check"));
  const msgs = [{ sender: "customer", text: "https://suumo.jp/chintai/x/ ここまだ空いてますか？", created_at: ago(0.3) }] as never;
  const fromBrain = buildActionLedger({ messages: msgs, lineTasks, now: NOW });
  const fromOld = buildActionLedger({ messages: msgs, lineTasks: [{ task_type: "property_check", status: "pending", created_at: ago(0.2) }], now: NOW });
  t("（材料）台帳の 確認の約束（募集状況）も旧と同じ", fromBrain.facts.confirmationPromisedUnfulfilled === true && JSON.stringify(fromBrain.facts) === JSON.stringify(fromOld.facts));
}
t("確認した（条件・交渉）の物件確認した → 置かない（募集状況の確認ではない）", same(brainTaskTypes({ action: "property_check_result", reply_mode: "aix", check_pattern: "mgmt_initial_cost" }), []));
// 実物 a🤫（10/08）: 見積の約束（promise:estimate）＋ピックアップの約束
t("a🤫 promise:estimate・pending_pickup → 見積書対応＋物件出し", same(brainTaskTypes({ action: "estimate_sheet", reply_mode: "aix", decision_source: "promise:estimate", pending_pickup: true }), ["estimate_sheet", "property_send"]));
t("cached（今回の発言を見ていない）→ 何も変えない", brainTaskTypes({ action: "property_send", reply_mode: "aix", source: "cached" }) === null && brainTaskTypesToCancel({ source: "cached" }).length === 0);
// 実物 愛 乃（内覧日調整）・ゆいと（内覧挨拶）: やることは無い（AIX要対応だけ）
t("愛 乃 内覧日調整 → やることなし", same(brainTaskTypes({ action: "viewing_invite", reply_mode: "aix", decision_source: "signal:scene_S4_date_alt" }), []));
t("取り下げ: ブレインが物件確認を言わなくなった → 物件確認・見積書対応を取り下げ（物件出しは pending_pickup=false の時だけ）",
  same(brainTaskTypesToCancel({ action: "", reply_mode: "auto_reply" }), ["property_check", "estimate_sheet"]) &&
  same(brainTaskTypesToCancel({ action: "", reply_mode: "auto_reply", pending_pickup: false }), ["property_check", "estimate_sheet", "property_send"]));

console.log("■ 1b. 旧の語の作成の外れ（実物）は、新では作られない");
// 実物 あ（10/06 06:04）「1度301号室の内覧お願いしたいです！」→ 旧: 物件確認のタスク（号室＝持ち込み扱い）／決まり: 内覧の希望は AIX【内覧調整】
{
  const msgs = [{ sender: "staff", text: "【サンプル 301号室】ご紹介させて頂きます😊" }, { sender: "customer", text: "ご説明ありがとうございます！\n1度301号室の内覧お願いしたいです！" }];
  const old = decideAutoTask("ご説明ありがとうございます！\n1度301号室の内覧お願いしたいです！", msgs);
  t("あ 旧の語の判定は 物件確認 を作っていた", old === "property_check", String(old));
  t("あ 新: ブレインの 内覧日調整 からは やること を作らない", same(brainTaskTypes({ action: "viewing_invite", reply_mode: "aix", decision_source: "llm" }), []));
}
// 「友人が物件を探していて」（紹介の話）→ 旧: 物件出しの語「物件を探」で作る
{
  const old = decideAutoTask("友人が物件を探していて、紹介してもいいですか？", [{ sender: "customer", text: "友人が物件を探していて、紹介してもいいですか？" }]);
  t("友人の紹介 旧の語の判定は 物件出し を作っていた", old === "property_send", String(old));
  t("友人の紹介 新: ブレインが AIX なし（返信）→ やることなし", same(brainTaskTypes({ action: "", reply_mode: "auto_reply", customer_intent: "question" }), []));
}

console.log("■ 2. 要対応（is_flagged の代わり）");
t("AIX要対応が pending → 要対応", brainNeedsStaff({ meta: null, pendingAixAction: "property_send", lastSender: "staff", status: "proposing" }).needs);
t("ブレインの AIX（お客様が最後）→ 要対応", brainNeedsStaff({ meta: { action: "viewing_invite", reply_mode: "aix" }, lastSender: "customer", status: "proposing" }).needs);
t("ブレインの AIX でもスタッフが最後（約束でない）→ 要対応にしない", !brainNeedsStaff({ meta: { action: "viewing_invite", reply_mode: "aix", decision_source: "llm" }, lastSender: "staff", status: "proposing" }).needs);
t("約束を果たす番（promise:check）はスタッフが最後でも要対応", brainNeedsStaff({ meta: { action: "property_check_result", reply_mode: "aix", decision_source: "promise:check" }, lastSender: "staff", status: "viewing" }).needs);
t("陽香 返信の番でもピックアップの約束が残る → 要対応", brainNeedsStaff({ meta: { action: "", reply_mode: "auto_reply", pending_pickup: true }, lastSender: "staff", status: "proposing" }).needs);
t("ゆかり 返信の番（AIX なし・約束なし）→ 要対応にしない（受信しただけでは立てない）", !brainNeedsStaff({ meta: { action: "", reply_mode: "auto_reply", purchase_signal_level: "soft" }, lastSender: "customer", status: "hearing" }).needs);
t("成約・失注は出さない", !brainNeedsStaff({ meta: null, pendingAixAction: "property_send", status: "closed_won" }).needs);

console.log("■ 3. 今日のターゲット（①内覧済み ②審査落ち ③新規 ④物件検索中）");
const base = { status: "proposing", createdAt: ago(24 * 40), nowMs: NOW } as const;
t("① 内覧に行った（10日前）・お客様の発言 2日前 → 内覧済み", classifyTarget({ ...base, meta: null, lastViewedAt: ago(24 * 10), lastCustomerAt: ago(48) })?.tier === "viewed");
t("① 内覧が60日前・発言も60日前 → 外す", classifyTarget({ ...base, meta: null, lastViewedAt: ago(24 * 60), lastCustomerAt: ago(24 * 60) }) === null);
t("② 申込から戻した（審査落ち）→ 審査落ち（内覧済みより先）", classifyTarget({ ...base, meta: null, screeningFailedAt: ago(24 * 3), lastViewedAt: ago(24 * 5), lastCustomerAt: ago(24) })?.tier === "screening_failed");
t("申込中（審査落ちでない）→ 外す（別のツールの領分）", classifyTarget({ ...base, status: "applying", meta: { action: "property_check_result", reply_mode: "aix" }, lastCustomerAt: ago(1) }) === null);
t("③ 作成から1日 → 新規", classifyTarget({ ...base, createdAt: ago(24), meta: null, lastCustomerAt: ago(2) })?.tier === "new");
t("④ 👾 ピックアップの約束（2時間前の発言）→ 物件検索中", classifyTarget({ ...base, meta: { action: "property_send", reply_mode: "aix", decision_source: "promise:pickup", pending_pickup: true }, lastCustomerAt: ago(2) })?.tier === "engaged");
t("④ 和樹 strong・signal:pending_pickup（thinking でも約束の合図は止めない）→ 物件検索中", classifyTarget({ ...base, meta: { action: "property_send", reply_mode: "aix", decision_source: "signal:pending_pickup", pending_pickup: true, purchase_signal_level: "strong", hesitancy_pattern: "thinking" }, lastCustomerAt: ago(5) })?.tier === "engaged");
t("④ 物件への質問（soft・提案中）→ 物件検索中", classifyTarget({ ...base, meta: { action: "", reply_mode: "auto_reply", purchase_signal_level: "soft", checkpoint_stage: "proposing" }, lastCustomerAt: ago(10) })?.tier === "engaged");
t("食いつきでも最後の発言が10日前 → 外す", classifyTarget({ ...base, meta: { action: "", reply_mode: "auto_reply", purchase_signal_level: "strong" }, lastCustomerAt: ago(240) }) === null);
t("ブレインがお客様の保留（signal・waiting）と読んだ → 外す", classifyTarget({ ...base, meta: { action: "property_send", reply_mode: "aix", decision_source: "signal:keyword", hesitancy_pattern: "waiting" }, lastCustomerAt: ago(2) }) === null);
t("ブロック → 外す", classifyTarget({ ...base, lineStatus: "blocked", meta: null, lastViewedAt: ago(24) }) === null);
t("並び: 内覧済み → 審査落ち → 新規 → 物件検索中（同じ段は発言が新しい順）",
  JSON.stringify([{ tier: "engaged" as const, lastCustomerAt: ago(1) }, { tier: "new" as const }, { tier: "viewed" as const, lastCustomerAt: ago(50) }, { tier: "viewed" as const, lastCustomerAt: ago(2) }, { tier: "screening_failed" as const }].sort(compareTargets).map((x) => `${x.tier}:${x.lastCustomerAt ?? ""}`))
    === JSON.stringify([`viewed:${ago(2)}`, `viewed:${ago(50)}`, "screening_failed:", "new:", `engaged:${ago(1)}`]));

console.log("■ 3b. hot（物件を出すべき人）");
t("④ 物件の判断 → hot", brainHotDecision({ ...base, meta: { action: "property_send", reply_mode: "aix", decision_source: "llm" }, lastCustomerAt: ago(1) }).hot);
t("③ 新規でも挨拶だけ（物件の合図なし）→ hot にしない", !brainHotDecision({ ...base, createdAt: ago(5), meta: null, lastCustomerAt: ago(1) }).hot);
t("③ 新規で初回の条件（first_contact_pickup）→ hot", brainHotDecision({ ...base, createdAt: ago(5), meta: { first_contact_pickup: "property_send" }, lastCustomerAt: ago(1) }).hot);
t("返信の番だけ（物件の合図なし・ターゲット外）→ hot にしない（旧は受信のたびに hot）", !brainHotDecision({ ...base, meta: { action: "", reply_mode: "auto_reply", purchase_signal_level: "none", customer_intent: "chat" }, lastCustomerAt: ago(1) }).hot);

console.log("■ 3c. 一言の要約（実物の条件）");
// 実物 はる: 弁天町駅・78000・1K・築浅・家具付・…
const sHaru = targetSummary({ tier: "engaged", desiredArea: "弁天町駅", rentMax: 78000, floorPlan: "1K", otherRequests: "築浅・家具付・初期費用はできるだけ安く" });
t("はる → 「弁天町駅、7.8万円ほど1K、築浅・家具付」", sHaru === "弁天町駅、7.8万円ほど1K、築浅・家具付", sHaru);
// 実物 ゆなまる: 谷町四丁目駅まで15分・95000・1LDK以上・次の AIX
const sYuna = targetSummary({ tier: "viewed", commuteStation: "谷町四丁目駅", commuteMinutes: 15, rentMax: 95000, floorPlan: "1LDK以上", nextAix: "property_check_result" });
t("ゆなまる → 内覧済み・通勤・家賃・次の AIX", sYuna.startsWith("内覧済み、谷町四丁目駅まで15分、9.5万円ほど1LDK以上") && /→AIX【/.test(sYuna), sYuna);
t("審査落ちは状況を先頭に", targetSummary({ tier: "screening_failed", desiredArea: "吹田市" }).startsWith("審査落ち・切り替え"));

console.log("■ 4. ブレイン以外の帯（ブレインと食い違う時は出さない）");
t("ブレインの今の判断なし → 出す（今まで通り）", nonBrainBannerAllowed({ bannerAix: null, brainFresh: false, brainAix: "property_send" }));
t("ブレインが AIX なし → 出す（食い違いではない）", nonBrainBannerAllowed({ bannerAix: "application_push", brainFresh: true, brainAix: null }));
t("申込②の帯・ブレインも 申込へ！ → 出す", nonBrainBannerAllowed({ bannerAix: "application_push", brainFresh: true, brainAix: "application_push" }));
t("申込②の帯・ブレインは 物件確認した → 出さない", !nonBrainBannerAllowed({ bannerAix: "application_push", brainFresh: true, brainAix: "property_check_result" }));
t("テンプレの帯（AIX なし）・ブレインが AIX → 出さない（ブレインの AIX を先に）", !nonBrainBannerAllowed({ bannerAix: null, brainFresh: true, brainAix: "viewing_invite" }));
t("物件確認した の旧名 property_check は同じ AIX", nonBrainBannerAllowed({ bannerAix: "property_check", brainFresh: true, brainAix: "property_check_result" }));

console.log("■ 5. 環境変数");
t("既定（未設定）は on", flagOn(undefined) && flagOn("") && flagOn("on"));
t("off で旧に戻す", !flagOn("off") && !flagOn(" OFF "));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
