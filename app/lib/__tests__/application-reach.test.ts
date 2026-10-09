// 申込到達（決定①⑥）・30日の確認（決定②）・申込基準の分析（決定③）・段階を申込にする促し（決定④）の決まり
// 実行: npx tsx app/lib/__tests__/application-reach.test.ts
// 文は実物（scripts/audit-apply-stage-nudge.ts で読んだ物・名前と物件名は伏せた）
import {
  applicationReachEnabled, legacyActionWinRatesEnabled, outcomeApplyBasisEnabled, reachMinN, reachActionKey, turnSceneAt, stageBucketAt,
  computeReachStats, buildReachNote, reachedApplication, reachStrictEnabled, wilsonInterval, hasSeparatedPair, winningOutcomeTag, analysisOutcomeOf, analysisCutoffAt,
  type ReachDecisionPoint, type ReachEpisode,
} from "../application-reach";
import { pickConfirmCandidate, confirmPatch, autoSeiyakuBlockedByConfirm, confirmHeadline, isConfirmChoice, type ConfirmCandidateRow } from "../outcome-confirm";
import { screeningEvidenceOf, resolveApplyStageNudge, isPreApplyForNudge } from "../apply-stage-nudge";
import { watchAixMatchRates } from "../watch-aix-match";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} got ${x} want ${y}`); }
function ok(v: unknown, msg = "") { if (!v) throw new Error(`expected truthy ${msg}`); }

const NOW = Date.parse("2026-10-08T03:00:00Z");
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

// ─── 戻す口 ─────────────────────────────────────────────────────────
it("戻す口: 新は既定 on・旧の勝率は既定 off（BRAIN_ACTION_WIN_RATES=on で旧）", () => {
  eq(applicationReachEnabled({}), true); eq(applicationReachEnabled({ BRAIN_APPLY_REACH: "off" }), false);
  eq(legacyActionWinRatesEnabled({}), false); eq(legacyActionWinRatesEnabled({ BRAIN_ACTION_WIN_RATES: "on" }), true);
  eq(outcomeApplyBasisEnabled({}), true); eq(outcomeApplyBasisEnabled({ OUTCOME_APPLY_BASIS: "off" }), false);
  eq(reachMinN({}), 10); eq(reachMinN({ BRAIN_APPLY_REACH_MIN_N: "8" }), 8); eq(reachMinN({ BRAIN_APPLY_REACH_MIN_N: "1" }), 10);
});

// ─── 場面と段階 ─────────────────────────────────────────────────────
it("判断が読んだ番のお客様の文から場面（画像は除く・こちらの文で切る）", () => {
  const msgs = [
    { sender: "customer", text: "条件これで探してほしいです", createdAt: iso(NOW - 3 * DAY) },
    { sender: "staff", text: "かしこまりました！！", createdAt: iso(NOW - 2 * DAY) },
    { sender: "customer", text: "[画像] 物件の写真", createdAt: iso(NOW - DAY) },
    { sender: "customer", text: "内覧できますか？", createdAt: iso(NOW - DAY + 1000) },
    { sender: "customer", text: "初期費用いくらですか", createdAt: iso(NOW) },
  ];
  eq(turnSceneAt(msgs, NOW - DAY + 1000), "viewing");
  eq(turnSceneAt(msgs, NOW), "cost");
  eq(turnSceneAt(msgs, NOW - 10 * DAY), null);
});
it("段階: 内覧の日がその時刻より前なら内覧後", () => {
  eq(stageBucketAt(["2026-10-01T12:00:00+09:00"], NOW), "post_viewing");
  eq(stageBucketAt(["2026-10-20T12:00:00+09:00"], NOW), "pre_viewing");
  eq(stageBucketAt([], NOW), "pre_viewing");
});

// ─── 申込到達率 ─────────────────────────────────────────────────────
function pts(): { points: ReachDecisionPoint[]; episodes: ReachEpisode[] } {
  const points: ReachDecisionPoint[] = [];
  const episodes: ReachEpisode[] = [];
  // 内覧の案内（viewing_invite）: 10案件・6案件が申込へ
  for (let i = 0; i < 10; i++) {
    const at = NOW - 60 * DAY + i * DAY;
    points.push({ conversationId: `v${i}`, episodeNo: 1, at: iso(at), action: "viewing_invite", scene: "viewing", bucket: "pre_viewing" });
    points.push({ conversationId: `v${i}`, episodeNo: 1, at: iso(at + 3600_000), action: "viewing_invite", scene: "viewing", bucket: "pre_viewing" }); // 同じ案件の2回目は数えない
    episodes.push({ conversationId: `v${i}`, episodeNo: 1, appliedAt: i < 6 ? iso(at + 5 * DAY) : null, result: i < 6 ? "won" : "lost" });
  }
  // 返信（AIX なし）: 10案件・2案件が申込へ
  for (let i = 0; i < 10; i++) {
    const at = NOW - 60 * DAY + i * DAY;
    points.push({ conversationId: `r${i}`, episodeNo: 1, at: iso(at), action: "", scene: "viewing", bucket: "pre_viewing" });
    episodes.push({ conversationId: `r${i}`, episodeNo: 1, appliedAt: i < 2 ? iso(at + 5 * DAY) : null, result: i < 2 ? "in_progress" : "lost" });
  }
  // 申込の後の判断（数えない）・まだ分からない新しい判断（数えない）・場面なし（数えない）
  points.push({ conversationId: "v0", episodeNo: 1, at: iso(NOW - 50 * DAY), action: "application_push", scene: "viewing", bucket: "pre_viewing" });
  points.push({ conversationId: "n1", episodeNo: 1, at: iso(NOW - 5 * DAY), action: "viewing_invite", scene: "viewing", bucket: "pre_viewing" });
  episodes.push({ conversationId: "n1", episodeNo: 1, appliedAt: null, result: "in_progress" });
  points.push({ conversationId: "x1", episodeNo: 1, at: iso(NOW - 40 * DAY), action: "viewing_invite", scene: null, bucket: "pre_viewing" });
  return { points, episodes };
}
it("場面×段階×判断ごとに案件で数える（同じ案件は1つ・申込の後・まだ分からない物・場面なしは数えない）", () => {
  const { points, episodes } = pts();
  const rows = computeReachStats(points, episodes, { nowMs: NOW });
  eq(rows.map((r) => [r.action, r.n, r.reached, r.rate]), [["reply", 10, 2, 0.2], ["viewing_invite", 10, 6, 0.6]]);
  eq(reachActionKey(null), "reply"); eq(reachActionKey("estimate_sheet"), "estimate_sheet");
});
it("ブレインへの注記: 場面と段階が合い・線を超えた判断が2つ以上の時だけ（材料だけ・指示は書かない）", () => {
  const { points, episodes } = pts();
  const rows = computeReachStats(points, episodes, { nowMs: NOW });
  const note = buildReachNote(rows, "viewing", "pre_viewing", { minN: 10, computedAt: "2026-10-08T00:30:00Z", labels: { viewing_invite: "内覧誘導" } });
  ok(note.includes("AIX 内覧誘導（viewing_invite）: 60%（6/10案件）"), note);
  ok(note.includes("返信（AIX なし）: 20%（2/10案件）"), note);
  ok(note.includes("10/08 集計"), note);
  ok(!/重視/.test(note), "指示を書かない");
  eq(buildReachNote(rows, "viewing", "pre_viewing", { minN: 11 }), "", "線の下は出さない");
  eq(buildReachNote(rows, "viewing", "post_viewing", { minN: 10 }), "", "段階が違う");
  eq(buildReachNote(rows, "cost", "pre_viewing", { minN: 10 }), "", "場面が違う");
  eq(buildReachNote(rows.filter((r) => r.action !== "reply"), "viewing", "pre_viewing", { minN: 10 }), "", "1つだけは比べられない");
});
it("申込に届いた案件（成約の確かさは問わない）", () => {
  eq(reachedApplication({ applied_at: "2026-09-01T00:00:00Z", max_stage: "applied" }), true);
  eq(reachedApplication({ applied_at: null, max_stage: "won" }), true);
  eq(reachedApplication({ applied_at: null, max_stage: "viewing_held" }), false);
});

// ─── 申込基準の分析（決定③） ──────────────────────────────────────
it("成約も申込として分析する・札は「申込に届いた」（OUTCOME_APPLY_BASIS=off で旧）", () => {
  eq(analysisOutcomeOf("closed_won", {}), "applying"); eq(analysisOutcomeOf("closed_won", { OUTCOME_APPLY_BASIS: "off" }), "closed_won");
  eq(analysisOutcomeOf("closed_lost", {}), "closed_lost");
  eq(winningOutcomeTag("applying", {}), "【申込に届いた】"); eq(winningOutcomeTag("closed_won", {}), "【申込に届いた】");
  eq(winningOutcomeTag("closed_lost", {}), "【失注】"); eq(winningOutcomeTag("applying", { OUTCOME_APPLY_BASIS: "off" }), "【成約】");
});
it("分析の会話の終わり＝一番新しい案件の申込の時刻（切り替え・失注で終わった案件・申込なしは切らない）", () => {
  eq(analysisCutoffAt([{ episode_no: 1, applied_at: "2026-09-01T00:00:00Z", result: "switched" }, { episode_no: 2, applied_at: "2026-09-20T00:00:00Z", result: "in_progress" }]), "2026-09-20T00:00:00Z");
  eq(analysisCutoffAt([{ episode_no: 1, applied_at: "2026-09-01T00:00:00Z", result: "switched" }, { episode_no: 2, applied_at: null, result: "in_progress" }]), null);
  eq(analysisCutoffAt([{ episode_no: 1, applied_at: "2026-09-01T00:00:00Z", result: "switched" }]), null);
  eq(analysisCutoffAt([]), null);
});

// ─── 30日の確認（決定②） ────────────────────────────────────────────
const row = (o: Partial<ConfirmCandidateRow>): ConfirmCandidateRow => ({
  conversation_id: "c1", episode_no: 1, applied_at: iso(NOW - 31 * DAY), result: "in_progress", result_certainty: "estimated", result_evidence: "applying",
  locked: false, staff_confirmed_at: null, confirm_snooze_until: null, property_name: "〇〇マンション", room_no: "302", ...o,
});
it("申込から30日・申込中のまま／自動の成約は聞く", () => {
  const c = pickConfirmCandidate([row({})], NOW);
  eq([c?.episodeNo, c?.current, c?.daysSinceApplied, c?.propertyLabel], [1, "in_progress", 31, "〇〇マンション 302"]);
  eq(pickConfirmCandidate([row({ result: "won", result_certainty: "estimated", result_evidence: "auto_seiyaku" })], NOW)?.current, "won_estimated");
  ok(confirmHeadline(c!).startsWith("申込から31日たちました。「〇〇マンション 302」の結果"));
});
it("聞かない: 30日未満・確定の成約・切り替え・失注・locked・確認済み・待ちの間・前の案件", () => {
  eq(pickConfirmCandidate([row({ applied_at: iso(NOW - 29 * DAY) })], NOW), null);
  eq(pickConfirmCandidate([row({ result: "won", result_certainty: "confirmed" })], NOW), null);
  eq(pickConfirmCandidate([row({ result: "switched" })], NOW), null);
  eq(pickConfirmCandidate([row({ result: "lost" })], NOW), null);
  eq(pickConfirmCandidate([row({ locked: true })], NOW), null);
  eq(pickConfirmCandidate([row({ staff_confirmed_at: iso(NOW - DAY) })], NOW), null);
  eq(pickConfirmCandidate([row({ confirm_snooze_until: iso(NOW + DAY) })], NOW), null);
  ok(pickConfirmCandidate([row({ confirm_snooze_until: iso(NOW - DAY) })], NOW), "待ちが過ぎたらまた聞く");
  eq(pickConfirmCandidate([row({}), row({ episode_no: 2, applied_at: null, result: "in_progress" })], NOW), null, "一番新しい案件だけ");
  eq(pickConfirmCandidate([row({ applied_at: null })], NOW), null);
});
it("選んだ結果の書き方（成約・審査落ち・キャンセルは確定で locked／まだ手続き中は14日後）", () => {
  const w = confirmPatch("won", NOW);
  eq([w.result, w.result_certainty, w.locked, w.staff_confirm_choice, w.result_evidence], ["won", "confirmed", true, "won", "staff_confirm:won"]);
  const s = confirmPatch("screening_failed", NOW);
  eq([s.result, s.switch_reason, s.locked], ["switched", "screening_rejected", true]);
  const c = confirmPatch("cancelled", NOW);
  eq([c.result, c.lost_type, c.lost_reason, c.locked], ["lost", "application_cancelled", "unknown", true]);
  const p = confirmPatch("pending", NOW);
  eq([p.locked, p.result, p.confirm_snooze_until], [undefined, undefined, iso(NOW + 14 * DAY)]);
  eq(isConfirmChoice("won"), true); eq(isConfirmChoice("contract"), false);
});
it("自動の成約（auto-seiyaku）は確認の「成約」以外と待ちの間は飛ばす", () => {
  eq(autoSeiyakuBlockedByConfirm([{ episode_no: 1, locked: true, confirm_snooze_until: null, staff_confirm_choice: "cancelled" }], NOW), true);
  eq(autoSeiyakuBlockedByConfirm([{ episode_no: 1, locked: true, confirm_snooze_until: null, staff_confirm_choice: "won" }], NOW), false);
  eq(autoSeiyakuBlockedByConfirm([{ episode_no: 1, locked: false, confirm_snooze_until: iso(NOW + DAY), staff_confirm_choice: null }], NOW), true);
  eq(autoSeiyakuBlockedByConfirm([], NOW), false);
});

// ─── 段階を申込にする促し（決定④） ──────────────────────────────────
const S = (text: string) => ({ sender: "staff", text, createdAt: iso(NOW - DAY) });
const C = (text: string) => ({ sender: "customer", text, createdAt: iso(NOW - DAY) });
it("この方の審査が動いている文（実物）は形跡", () => {
  for (const t of [
    "野口さん お世話になっております！！ 管理会社に入居日交渉させていただき、無事11/16日からのご入居で許可をいただきました😊！！ 野口さん問題なければこれよりオーナーの最終審査に移行となります！！",
    "確認しましたところ現在まだ審査中となります！！ 審査状況進捗あり次第ご連絡させて頂きます！！",
    "無事保証会社の審査通過致しました！！ 貸主による最終審査に移行致します！",
    "かしこまりました！！ ルネフラッツ〇〇606号室お申込みさせていただきます😊！！",
    "Sさん お送りいただきありがとうございます！！ こちらでお申し込みフォーマット入力完了となりますので、管理会社にご連絡させていただきます😊！！",
    "くぼさん 2番手でお申込み完了しております！！ 1番手に繰り上がり次第審査開始となります！！ 審査の進捗あり次第ご連絡させていただきます😌！！",
  ]) eq(screeningEvidenceOf(S(t)), "screening_text", t.slice(0, 30));
  for (const t of ["おはようございます！ 審査結果ってまだ分からない感じでしょうか？？", "オーナー審査どうなりましたか🥲", "審査通過ありがとうございます！ 10/31日入居でお願いいたします！", "お世話になっております。審査こんなに遅いことあるんですか？？"])
    eq(screeningEvidenceOf(C(t)), "screening_text", t.slice(0, 30));
});
it("物件の説明・他の申込者・誘い・流れの説明・仮定は形跡にしない（実物）", () => {
  for (const t of [
    "🌟〇〇902号室 審査通過しやすく広々としたオススメ出来るお部屋が募集に出ました！！",
    "管理会社に確認させていただきましたが、まだ一番手お申込みの方での審査中とのご返事でした！！",
    "ayaさん お世話になっております！！ 〇〇の礼金が無いお部屋にお申込みが入ってしまい、現在審査中となっております！！",
    "お父様の年収380万円収入面で審査も問題ございませんので、よろしければお父様ご契約者様としてお部屋のお申込みさせていただきます😊！！",
    "🌟お申込み後の流れをご案内させていただきます！！ ①【保証会社による審査】 お申込み後、保証会社の審査に移ります。",
    "審査否決の場合1週間から2週間程で審査の結果がわかり再度募集に出る形となります！！",
    "[画像] 審査完了メール",
  ]) eq(screeningEvidenceOf(S(t)), null, t.slice(0, 30));
  eq(screeningEvidenceOf(C("保証会社など審査通りやすくできたりするでしょうか？？")), null);
});
it("促す: 申込より前の段階・21日以内・戻した後・その後に否決が無い", () => {
  const msgs = [S("確認しましたところ現在まだ審査中となります！！")];
  eq(resolveApplyStageNudge({ status: "proposing", messages: msgs, nowMs: NOW })?.kind, "screening_text");
  eq(resolveApplyStageNudge({ status: "applying", messages: msgs, nowMs: NOW }), null, "申込以降");
  eq(resolveApplyStageNudge({ status: "closed_won", messages: msgs, nowMs: NOW }), null);
  eq(resolveApplyStageNudge({ status: "proposing", messages: [{ ...msgs[0], createdAt: iso(NOW - 30 * DAY) }], nowMs: NOW }), null, "古い");
  eq(resolveApplyStageNudge({ status: "proposing", messages: msgs, nowMs: NOW, lastBackAt: iso(NOW - DAY / 2) }), null, "戻した後に無い");
  const rejected = [...msgs, { sender: "staff", text: "管理会社より保証会社審査が否決となり、審査継続不可能とのご連絡がございました。", createdAt: iso(NOW - DAY / 2) }];
  eq(resolveApplyStageNudge({ status: "proposing", messages: rejected, nowMs: NOW }), null, "否決の後は切り替えの番");
  eq(isPreApplyForNudge("hearing"), true); eq(isPreApplyForNudge(""), false);
});

// ─── 見張りの一致率（auto-reply-readiness の関所） ────────────────────
it("見張りの一致率: same／other／not_pressed だけで数える", () => {
  const r = watchAixMatchRates([
    { brain_action: "viewing_invite", aix_verdict: "same" }, { brain_action: "viewing_invite", aix_verdict: "same" },
    { brain_action: "viewing_invite", aix_verdict: "not_pressed" }, { brain_action: "viewing_invite", aix_verdict: null },
    { brain_action: "", aix_verdict: "unexpected" }, { brain_action: "property_send", aix_verdict: "other" },
  ]);
  eq(r.viewing_invite, { same: 2, n: 3, rate: 0.667 }); eq(r.property_send, { same: 0, n: 1, rate: 0 }); eq(r[""], undefined);
});

// ─── 申込到達率の厳密な数え方（10/08 竹内さん「進めて良い」＝改善案1〜6・REACH_STRICT=off で旧） ─────
it("厳密: ①30日たった判断だけ・届いた＝30日以内の申込 ②実際に送った AIX ③案件は最初の判断1つ ④理由不明の切り替えは外す ⑤初回のガードは外す", () => {
  eq(reachStrictEnabled({}), true); eq(reachStrictEnabled({ REACH_STRICT: "off" }), false);
  const P = (c: string, daysAgo: number, o: Partial<ReachDecisionPoint> = {}): ReachDecisionPoint =>
    ({ conversationId: c, episodeNo: 1, at: iso(NOW - daysAgo * DAY), action: "viewing_invite", scene: "viewing", bucket: "pre_viewing", ...o });
  const points: ReachDecisionPoint[] = [
    P("a", 40, { actualAction: "viewing_invite" }),                        // 申込 5日後 → 届いた
    P("a", 39, { actualAction: null }),                                     // ③ 同じ案件の2つ目（別の判断でも数えない）
    P("b", 10, { actualAction: "viewing_invite" }),                        // ① 30日たっていない（申込済みでも数えない）
    P("c", 50, { actualAction: "viewing_invite" }),                        // 申込 40日後 → 30日の外＝届いていない
    P("d", 45, { action: "viewing_invite", actualAction: null }),         // ② 提案は内覧誘導でも送っていない→返信
    P("e", 45, { actualAction: "viewing_invite" }),                        // ④ 理由不明の切り替え→外す
    P("f", 45, { actualAction: "viewing_invite" }),                        // ④ 確定の審査落ち→申込に届いた
    P("g", 45, { actualAction: null, src: "guard:first_contact" }),        // ⑤ 初回のガード→外す
  ];
  const episodes: ReachEpisode[] = [
    { conversationId: "a", episodeNo: 1, appliedAt: iso(NOW - 35 * DAY), result: "in_progress" },
    { conversationId: "b", episodeNo: 1, appliedAt: iso(NOW - 5 * DAY), result: "in_progress" },
    { conversationId: "c", episodeNo: 1, appliedAt: iso(NOW - 10 * DAY), result: "in_progress" },
    { conversationId: "d", episodeNo: 1, appliedAt: null, result: "lost" },
    { conversationId: "e", episodeNo: 1, appliedAt: iso(NOW - 40 * DAY), result: "switched", switchReason: "unknown" },
    { conversationId: "f", episodeNo: 1, appliedAt: iso(NOW - 40 * DAY), result: "switched", switchReason: "screening_rejected" },
    { conversationId: "g", episodeNo: 1, appliedAt: null, result: "lost" },
  ];
  const rows = computeReachStats(points, episodes, { nowMs: NOW, strict: true });
  eq(rows.map((r) => [r.action, r.n, r.reached]), [["viewing_invite", 3, 2], ["reply", 1, 0]]);
  // 旧の数え方は変わらない（strict を付けない時）
  const old = computeReachStats(points, episodes, { nowMs: NOW });
  ok(old.some((r) => r.action === "viewing_invite" && r.n >= 4), "旧は提案で数え・30日前の届いた判断も入る");
});
it("厳密: ⑥95%の幅が重ならない時だけ渡す（幅を添える）", () => {
  const [lo, hi] = wilsonInterval(6, 10);
  ok(lo > 0.3 && lo < 0.32 && hi > 0.83 && hi < 0.84, `${lo} ${hi}`);
  eq(wilsonInterval(0, 0), [0, 1]);
  const close = [{ scene_key: "viewing", stage_bucket: "pre_viewing" as const, action: "viewing_invite", n: 10, reached: 6, rate: 0.6 }, { scene_key: "viewing", stage_bucket: "pre_viewing" as const, action: "reply", n: 10, reached: 2, rate: 0.2 }];
  eq(hasSeparatedPair(close), false);
  eq(buildReachNote(close, "viewing", "pre_viewing", { minN: 10, strict: true }), "", "幅が重なる＝渡さない");
  ok(buildReachNote(close, "viewing", "pre_viewing", { minN: 10 }) !== "", "旧は渡す");
  const far = [{ ...close[0], n: 30, reached: 24, rate: 0.8 }, { ...close[1], n: 30, reached: 6, rate: 0.2 }];
  eq(hasSeparatedPair(far), true);
  const note = buildReachNote(far, "viewing", "pre_viewing", { minN: 10, strict: true });
  ok(note.includes("80%（24/30案件・95%の幅 63〜90%）"), note);
  ok(note.includes("30日以内に申込"), note);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
