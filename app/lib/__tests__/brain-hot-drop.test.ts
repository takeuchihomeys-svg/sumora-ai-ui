// app/lib/__tests__/brain-hot-drop.test.ts — 2026-10-08 竹内「hot から外す事もブレインがしてよい」「AIX 3回連続無視等」
//   ＋「🌟ターゲット🌟」の形・お客様一覧の要対応
// （実行: npx tsx app/lib/__tests__/brain-hot-drop.test.ts）
import { brainHotDrop, ignoredFollowUpStreak, silentDaysSetting, FOLLOWUP_AIX_TYPES, HOT_DROP_IGNORED_AIX_DAYS } from "../brain-hot-drop";
import { attentionRank, brainHotDecision, classifyTarget, dealEnded, isAttentionExcluded, type TargetInput } from "../brain-attention";
import { withScheduleAt, conditionPhrase, formatTargetList, screeningSummaryLine, targetSummaryLine } from "../target-list-format";
import { customerAttention } from "../customer-attention";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const NOW = Date.parse("2026-10-08T03:00:00Z");
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

console.log("■ 1. 続けて返事の無い AIX の数え方（JST の日ごと・お客様の最後の発言より後だけ）");
{
  // 同じ JST の日に2通 → 1日。お客様の発言より前の AIX は数えない
  const g = ignoredFollowUpStreak(["2026-10-01T01:00:00Z", "2026-10-01T05:00:00Z", "2026-10-02T01:00:00Z", "2026-09-29T01:00:00Z"], "2026-09-30T00:00:00Z");
  t("同じ日の2通は1・発言の前は数えない", g.days === 2 && g.lastAixAt === "2026-10-02T01:00:00Z", JSON.stringify(g));
  // JST の日の境目（UTC 15:00 = JST 0:00）
  const h = ignoredFollowUpStreak(["2026-10-01T14:59:00Z", "2026-10-01T15:01:00Z"], null);
  t("JST の日の境目で2日", h.days === 2);
  t("お客様の発言が無い時は全部数える", ignoredFollowUpStreak([ago(9), ago(8)], null).days === 2);
}

console.log("■ 2. 外す線（3日分・最後の AIX から3日）");
{
  const three = ignoredFollowUpStreak([ago(10), ago(7), ago(4)], ago(12));
  t(`${HOT_DROP_IGNORED_AIX_DAYS}日分・最後から4日 → 外す`, brainHotDrop({ ignored: three, nowMs: NOW }).drop);
  const fresh = ignoredFollowUpStreak([ago(5), ago(3.5), ago(1)], ago(12));
  t("3日分でも最後の AIX から1日 → まだ待つ", !brainHotDrop({ ignored: fresh, nowMs: NOW }).drop);
  const two = ignoredFollowUpStreak([ago(10), ago(7)], ago(12));
  t("2回 → 外さない（28% が戻る）", !brainHotDrop({ ignored: two, nowMs: NOW }).drop);
  const back = ignoredFollowUpStreak([ago(10), ago(7), ago(4)], ago(3));
  t("お客様が戻った（最後の AIX より後に発言）→ 0 から数え直し・外さない", back.days === 0 && !brainHotDrop({ ignored: back, nowMs: NOW }).drop);
  t("スタッフが最後の AIX の後に hot を確かめた → 外さない", !brainHotDrop({ ignored: three, hotConfirmedAt: ago(1), nowMs: NOW }).drop);
}

console.log("■ 2b. 2本目の線（お客様の発言が30日無い）");
{
  t("30日の線: 31日前の発言 → 外す", brainHotDrop({ ignored: null, lastCustomerAt: ago(31), silentDays: 30, nowMs: NOW }).drop);
  t("30日の線: 20日前 → 外さない（12〜22% が戻る）", !brainHotDrop({ ignored: null, lastCustomerAt: ago(20), silentDays: 30, nowMs: NOW }).drop);
  t("30日の線: 発言が無い人は会話を始めた時から", brainHotDrop({ ignored: null, lastCustomerAt: null, silentSince: ago(40), silentDays: 30, nowMs: NOW }).drop);
  t("30日の線: off（null）なら使わない", !brainHotDrop({ ignored: null, lastCustomerAt: ago(60), silentDays: null, nowMs: NOW }).drop);
  t("30日の線: スタッフが最近 hot を確かめた → 外さない", !brainHotDrop({ ignored: null, lastCustomerAt: ago(60), hotConfirmedAt: ago(2), silentDays: 30, nowMs: NOW }).drop);
  t("環境変数: 既定は30（10/08 竹内さん「30日を超えたら外す」）・off=null・数字", silentDaysSetting(undefined) === 30 && silentDaysSetting("off") === null && silentDaysSetting("45") === 45);
  t("30日ちょうどは外さない（超えたら）", !brainHotDrop({ ignored: null, lastCustomerAt: ago(30), silentDays: 30, nowMs: NOW }).drop);
  t("追客は物件ピックアップと物件オススメだけ", FOLLOWUP_AIX_TYPES.join() === "property_send,property_recommendation");
  t("理由は「追客 N回」", /追客.*3回 続けて返事なし/.test(brainHotDrop({ ignored: ignoredFollowUpStreak([ago(10), ago(7), ago(4)], ago(12)), nowMs: NOW }).reason ?? ""));
}

console.log("■ 3. ブレインの判断（hot・ターゲットの段）に入る");
{
  const base: TargetInput = {
    status: "proposing", createdAt: ago(20), lastCustomerAt: ago(6), nowMs: NOW,
    meta: { action: "property_send", reply_mode: "aix", source: "llm", decision_source: "llm", purchase_signal_level: "strong" },
    ignoredAix: ignoredFollowUpStreak([ago(5.5), ago(4.5), ago(3.5)], ago(6)),
  };
  t("④物件検索中でも続けて無視 → ターゲットから外す", classifyTarget(base) === null);
  t("hot に上げない（理由つき）", (() => { const d = brainHotDecision(base); return !d.hot && /返事なし/.test(d.reason ?? ""); })());
  t("HOT_DROP_BY_BRAIN=off（hotDrop=false）→ 今まで通り ④", classifyTarget({ ...base, hotDrop: false })?.tier === "engaged");
  t("①内覧済みは最優先なので一覧に残す", classifyTarget({ ...base, lastViewedAt: "2026-10-01" })?.tier === "viewed");
  t("①内覧済みでも hot の印は外す", !brainHotDecision({ ...base, lastViewedAt: "2026-10-01" }).hot);
  const back = { ...base, lastCustomerAt: ago(0.1), ignoredAix: ignoredFollowUpStreak([ago(5.5), ago(4.5), ago(3.5)], ago(0.1)) };
  t("戻ってきたら再び ④・hot", classifyTarget(back)?.tier === "engaged" && brainHotDecision(back).hot);
}

console.log("■ 4. 要対応の並び（AIX要対応 → ①② → ③ → ④）");
{
  t("AIX要対応が先", attentionRank({ pendingAixAction: "estimate_sheet", tier: "engaged" }) === 0);
  t("①<②<③<④<その他", [attentionRank({ tier: "viewed" }), attentionRank({ tier: "screening_failed" }), attentionRank({ tier: "new" }), attentionRank({ tier: "engaged" }), attentionRank({})].join() === "1,2,3,4,9");
  t("実在しない AIX は要対応の先頭にしない", attentionRank({ pendingAixAction: "follow_up", tier: "new" }) === 3);
  const brain = { c1: { needs: true, rank: 0 }, c2: { needs: false, rank: 4 } };
  t("お客様一覧: ブレインの要対応", customerAttention({ convId: "c1", isFlaggedDb: false, brain }).flagged);
  t("お客様一覧: is_flagged=true でもブレインが要らない → 出さない", !customerAttention({ convId: "c2", isFlaggedDb: true, brain }).flagged);
  t("お客様一覧: 手で付けた印は足す", customerAttention({ convId: "c2", isFlaggedDb: false, brain, manualFlags: new Set(["c2"]) }).flagged);
  t("お客様一覧: ブレインを読む前・off は is_flagged のまま", customerAttention({ convId: "c2", isFlaggedDb: true, brain: null }).flagged);
}

console.log("■ 5. 「🌟ターゲット🌟」の形と一言");
{
  const text = formatTargetList({
    targets: [{ mark: "・", name: "隼斗", summary: "高殿6丁目まで自転車15〜20分" }, { mark: "✅", name: "慶次", summary: "" }],
    screening: [{ name: "yasuki", summary: "11/30審査通過" }, { name: "S", summary: "" }],
  });
  const idx = (s: string) => text.indexOf(s);
  t("見出しと順（時間割 → 内覧・申込 → 決まった行 → 審査中）",
    idx("🌟ターゲット🌟") === 0 && idx("10:30までに管理会社とのやりとり") < idx("【内覧・申込】") && idx("【内覧・申込】") < idx("アクション何もない時は3日で審査の進捗確認")
    && idx("審査通過後に入居日カレンダーに追加、必要書類確認、連絡") < idx("【審査中】"), text);
  t("名前（一言）・一言が無ければ名前だけ", text.includes("・隼斗（高殿6丁目まで自転車15〜20分）") && text.includes("✅慶次\n"));
  t("審査中は ・名前（状況）", text.includes("・yasuki（11/30審査通過）") && text.includes("・S"));
  // 実物の条件（本番 property_customers・10/08）
  t("条件の一言（エリア・家賃・間取り・敷礼の要望）",
    conditionPhrase({ desiredArea: "弁天町駅", rentMax: 78000, floorPlan: "1K", otherRequests: "築浅・家具付・初期費用はできるだけ安く・駅からの徒歩は5~15分・保証人できればなし", nowMs: NOW })
      === "弁天町駅、7.8万円ほど1K、築浅、家具付", conditionPhrase({ desiredArea: "弁天町駅", rentMax: 78000, floorPlan: "1K", otherRequests: "築浅・家具付・初期費用はできるだけ安く", nowMs: NOW }));
  t("通勤の駅", conditionPhrase({ commuteStation: "谷町四丁目駅", commuteMinutes: 15, rentMax: 95000, floorPlan: "1LDK以上", nowMs: NOW }) === "谷町四丁目駅まで15分以内、9.5万円ほど1LDK以上");
  t("①内覧済みは状況（新しい時）・これからの内覧は「次回M/D内覧」",
    targetSummaryLine({ tier: "viewed", desiredArea: "十三駅", situation: "ブロッサム十三302退去内覧待ち", situationAt: ago(1), nextViewingDate: "2026-10-12", nowMs: NOW }) === "次回10/12内覧、ブロッサム十三302退去内覧待ち");
  t("古い状況（8日前）は使わず条件", targetSummaryLine({ tier: "viewed", desiredArea: "十三駅", situation: "古い状況", situationAt: ago(8), nowMs: NOW }) === "十三駅");
  t("②審査落ちも段の名は書かない（状況の一言だけ）", targetSummaryLine({ tier: "screening_failed", desiredArea: "なんば", situation: "メゾン深江601の申込決定", situationAt: ago(1), nowMs: NOW }) === "メゾン深江601の申込決定");
  t("地名の重なり・括弧の説明を落とす", conditionPhrase({ desiredArea: "玉造、玉造", rentMax: 80000, floorPlan: "1DK・1K", nowMs: NOW }) === "玉造、8万円ほど1DK・1K"
    && conditionPhrase({ desiredArea: "松屋町駅周辺、南船場(Googleマップで示した地図の左側エリア)", nowMs: NOW }) === "松屋町駅周辺、南船場");
  t("間取りの「希望なし」は書かない", conditionPhrase({ desiredArea: "平野", rentMax: 45000, floorPlan: "希望なし", nowMs: NOW }) === "平野、4.5万円ほど");
  t("審査中の一言は状況だけ（古ければ空）", screeningSummaryLine({ situation: "再審査の申込準備中", situationAt: ago(2), nowMs: NOW }) === "再審査の申込準備中"
    && screeningSummaryLine({ situation: "10/1入居前の鍵・書類の受け渡し段階", situationAt: ago(9), nowMs: NOW }) === "");
}

console.log("■ 5a. 時間割は朝 10 時の便だけ");
{
  const later = formatTargetList({ targets: [{ name: "隼斗" }], screening: [{ name: "S" }], withSchedule: withScheduleAt(14) });
  t("10 時の便だけ時間割", withScheduleAt(10) && !withScheduleAt(12) && !withScheduleAt(20));
  t("他の便は一覧だけ（運用メモと審査中は残る）", !later.includes("10:30までに") && later.startsWith("🌟ターゲット🌟\n\n【内覧・申込】") && later.includes("アクション何もない時は3日で審査の進捗確認") && later.includes("【審査中】"));
}

console.log("■ 5b. 審査落ちの後に終わった人は外す（台帳の失注の確定・決まった言い方）");
{
  const failed: TargetInput = { status: "proposing", createdAt: ago(40), lastCustomerAt: ago(4), screeningFailedAt: ago(10), meta: null, nowMs: NOW };
  t("審査落ち・終わりの記録なし → ②", classifyTarget(failed)?.tier === "screening_failed");
  t("実物 H: 審査落ちの後に引越し中止（L4）・その後話していない → 外す", classifyTarget({ ...failed, dealEndedAt: ago(4) }) === null);
  t("終わりの発言の続き（6時間以内）も同じ番 → 外す", classifyTarget({ ...failed, dealEndedAt: ago(4.2) }) === null);
  t("実物 H・アヤ: 終わった後のお礼だけ → 外したまま", classifyTarget({ ...failed, dealEndedAt: ago(8), lastCustomerAt: ago(1), meta: { action: null, source: "llm", analyzed_msg_ts: ago(1) } }) === null);
  t("終わった後に探しを再開（ブレインが物件の番と読んだ）→ ②に戻る", classifyTarget({ ...failed, dealEndedAt: ago(8), lastCustomerAt: ago(1), meta: { action: "property_send", reply_mode: "aix", source: "llm", analyzed_msg_ts: ago(1) } })?.tier === "screening_failed");
  t("dealEnded: 記録なし → false", !dealEnded({ dealEndedAt: null, lastCustomerAt: ago(1), meta: null }));
}

console.log("■ 6. YUMA を含むテストの会話は外す");
{
  t("YUMA 本体", isAttentionExcluded("dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", "YUMA"));
  t("YUMA が入っているグループ", isAttentionExcluded("95019eb8-4dc3-4d90-9f5b-0b76b6a43ac0", "【グループ】野口　力也, YUMA, スモラ(3)") && isAttentionExcluded("x", "【グループ】喜子, YUMA, スモラ(3)"));
  t("スタッフ同士の会話（既存の一覧）", isAttentionExcluded("469a614a-7518-45c7-88cc-814e674fa881", "【グループ】緊急用(4)"));
  t("お客様のグループ・名前に YUMA を含むだけの人は外さない", !isAttentionExcluded("y", "【グループ】黒明様お部屋探し(4)") && !isAttentionExcluded("z", "YUMAKO") && !isAttentionExcluded("w", "【グループ】YUMAKO, スモラ(2)"));
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
