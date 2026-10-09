// 竹内さんの決定（2026-10-08）: ①確定の成約はより重い正解 ②その日最初の会話文は必ず「お世話になっております」 ③名前1文字でも「さん」
//   ⑤日付の無い約束もカレンダーへ（スタッフが日付を選ぶ）＋追加: 失注を負の正解にしない・AI貢献率は申込で数える・申込到達率の線 10
// 実行: npx tsx app/lib/__tests__/decisions-1008-takeuchi.test.ts（全 PASS で exit 0）
import { resolveGreeting, enforceOpening, buildGreetingNote, dailyGreetingRequired } from "../greeting";
import { refreshDraftGreetingForNow } from "../time-greeting";
import { oneCharCallName, normalizeDisplayName, canonOf, resolveAddressName, isPlausiblePersonName } from "../validate-reply";
import {
  computeReachStats, buildReachNote, reachScore, confirmedWinWeight, winningOutcomeTag, orderWinningPatterns, withConfirmedWinMark,
  isConfirmedWinNotes, attributionLineOf, lostAsNegativeEnabled, reachMinN, CONFIRMED_WIN_MARK,
} from "../application-reach";
import { strongPositiveWeight } from "../deal-outcome";
import { parseUndatedContactPromise, pendingUndatedPromise, undatedPromiseToContact, contactEventRow, isContactPromiseNotes } from "../contact-promise";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = <T,>(a: T, b: T, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m = "") => { if (!c) throw new Error(`not ok ${m}`); };

// ── ② 挨拶 ───────────────────────────────────────────────
const NOW = Date.parse("2026-10-08T02:00:00Z"); // JST 11:00
const HIST = [
  { sender: "staff", text: "お部屋お送りさせて頂きます！！", createdAt: "2026-10-06T03:00:00Z" },
  { sender: "customer", text: "こんばんは！\n子ども不可ですか？", createdAt: "2026-10-07T11:40:00Z" },
];
const gd = (name: string, already = false) => resolveGreeting({ customerName: name, isFirstEverReply: false, alreadyGreetedToday: already, recentMessages: HIST, jstHour: 11, now: NOW,
  isSubstantive: () => true, customerKind: "question", substanceKinds: [] });

it("② 今日はじめての会話文 → standard・enforce=true（必ず）", () => {
  const d = gd("りさ");
  eq(d.kind, "standard"); eq(d.enforce, true); eq(d.openingLine, "りささんお世話になっております！！");
  ok(dailyGreetingRequired());
});
it("② LLM が挨拶を書かなくても先頭に置く（短い返信でも）", () => {
  eq(enforceOpening("はい😊！！\nペット可能です！！", gd("りさ")).cleaned, "りささんお世話になっております！！\nはい😊！！\nペット可能です！！");
});
it("② お客様が「こんばんは」で始めても時刻の挨拶はまねず、お世話になっております", () => {
  eq(enforceOpening("こんばんは！\n\n確認させて頂きます！！", gd("りさ")).cleaned, "りささんお世話になっております！！\n確認させて頂きます！！");
});
it("② 本文の頭の呼びかけ「〇〇さん」は重ねない・「〇〇さんにオススメ」は残す", () => {
  eq(enforceOpening("りささん\n確認させて頂きます！！", gd("りさ")).cleaned, "りささんお世話になっております！！\n確認させて頂きます！！");
  eq(enforceOpening("りささんにオススメのお部屋です！！", gd("りさ")).cleaned, "りささんお世話になっております！！\nりささんにオススメのお部屋です！！");
});
it("② 今日2回目以降（none）は付けない・LLM の挨拶は外す", () => {
  const d = gd("りさ", true);
  eq(d.kind, "none");
  eq(enforceOpening("りささんお世話になっております！！\n確認させて頂きます！！", d).cleaned, "確認させて頂きます！！");
});
it("② 注記は「必ず」と言う（必須ではない、と言わない）", () => {
  const n = buildGreetingNote(gd("りさ"), 11);
  ok(n.includes("先頭行は必ず「りささんお世話になっております！！」"), n); ok(!n.includes("必須ではない"), n);
});
it("② GREETING_DAILY_REQUIRED=off で旧（付けてもよい）", () => {
  process.env.GREETING_DAILY_REQUIRED = "off";
  try { const d = gd("りさ"); eq(d.enforce, false); eq(enforceOpening("はい😊！！\nペット可能です！！", d).cleaned, "はい😊！！\nペット可能です！！"); }
  finally { delete process.env.GREETING_DAILY_REQUIRED; }
});
it("② 画面: 前に作った下書き（挨拶なし）を今日はじめて出す → 足す／今日すでに送った → 外す（名前は残す）", () => {
  const msgs = [{ sender: "customer", text: "ペット大丈夫ですか？", rawCreatedAt: "2026-10-07T12:00:00Z" }];
  const r1 = refreshDraftGreetingForNow("はい😊！！\nペット可能です！！", { messages: msgs, name: "りささん", now: NOW, ensureDaily: true });
  eq(r1.text, "りささんお世話になっております！！\nはい😊！！\nペット可能です！！");
  const msgs2 = [...msgs, { sender: "staff", text: "確認させて頂きます！！", rawCreatedAt: "2026-10-08T01:00:00Z" }];
  const r2 = refreshDraftGreetingForNow("りささんお世話になっております！！\nペット可能です！！", { messages: msgs2, name: "りささん", now: NOW, ensureDaily: true });
  eq(r2.text, "りささんペット可能です！！");
  // 資料文（🌟カード）だけ送った日は「今日の会話文」に数えない＝足す
  const msgs3 = [...msgs, { sender: "staff", text: "🌟サンライト 202号室", rawCreatedAt: "2026-10-08T01:00:00Z" }];
  eq(refreshDraftGreetingForNow("ペット可能です！！", { messages: msgs3, name: "", now: NOW, ensureDaily: true }).text, "お世話になっております！！\nペット可能です！！");
  // 🌟カード・催促の謝罪には足さない
  eq(refreshDraftGreetingForNow("🌟サンライト 202号室", { messages: msgs, name: "りささん", now: NOW, ensureDaily: true }).text, "🌟サンライト 202号室");
  eq(refreshDraftGreetingForNow("りささん、ご連絡遅くなり申し訳御座いません！！\n確認中です", { messages: msgs, name: "りささん", now: NOW, ensureDaily: true }).text, "りささん、ご連絡遅くなり申し訳御座いません！！\n確認中です");
  // ensureDaily なし＝旧（足さない）
  eq(refreshDraftGreetingForNow("はい😊！！\nペット可能です！！", { messages: msgs, name: "りささん", now: NOW }).text, "はい😊！！\nペット可能です！！");
});

// ── ③ 1文字の名前 ─────────────────────────────────────────
it("③ 1文字の表示名は呼ぶ（あ・り・R・し・Ｒ・り🍀）", () => {
  for (const [raw, want] of [["あ", "あ"], ["り", "り"], ["R", "R"], ["し", "し"], ["Ｒ", "R"], ["り🍀", "り"], ["⟡ あ ⟡", "あ"], ["rさん", "r"]] as const) eq(oneCharCallName(raw), want, raw);
});
it("③ 記号・絵文字だけ・数字・小さい字・長音・2字以上の頭文字は呼ばない", () => {
  for (const raw of ["⭐", "♡", "💞", "7", "っ", "ー", "々", "A.B", "K Y", "", "ゆき"]) eq(oneCharCallName(raw), "", raw);
});
it("③ 呼び名の決定（表示名だけの会話）・canonOf・本文の候補の検査は変えない", () => {
  eq(normalizeDisplayName("あ"), "あ"); eq(normalizeDisplayName("ゆき♡"), "ゆき"); eq(normalizeDisplayName("⭐"), "");
  eq(canonOf("り"), "り"); eq(canonOf("関"), "関");
  eq(resolveAddressName({ messages: [{ sender: "customer", text: "物件ありますか" }], displayName: "あ" }).name, "あ");
  eq(isPlausiblePersonName("は"), false); // 本文の「は」を名前と読まない（変えない）
});
it("③ ONE_CHAR_CALL_NAME=off で旧（呼ばない）", () => {
  process.env.ONE_CHAR_CALL_NAME = "off";
  try { eq(oneCharCallName("あ"), ""); eq(normalizeDisplayName("あ"), ""); eq(canonOf("り"), ""); } finally { delete process.env.ONE_CHAR_CALL_NAME; }
});

// ── ① 確定の成約＝より重い正解 ───────────────────────────────
const RNOW = Date.parse("2026-10-08T00:00:00Z");
const pts = [
  { conversationId: "a", episodeNo: 1, at: "2026-08-01T00:00:00Z", action: "viewing_invite", scene: "viewing", bucket: "pre_viewing" as const },
  { conversationId: "b", episodeNo: 1, at: "2026-08-01T00:00:00Z", action: "viewing_invite", scene: "viewing", bucket: "pre_viewing" as const },
  { conversationId: "c", episodeNo: 1, at: "2026-08-01T00:00:00Z", action: null, scene: "viewing", bucket: "pre_viewing" as const },
  { conversationId: "d", episodeNo: 1, at: "2026-08-01T00:00:00Z", action: null, scene: "viewing", bucket: "pre_viewing" as const },
];
const eps = [
  { conversationId: "a", episodeNo: 1, appliedAt: "2026-08-10T00:00:00Z", result: "won", confirmedWon: true },
  { conversationId: "b", episodeNo: 1, appliedAt: null, result: "lost" },
  { conversationId: "c", episodeNo: 1, appliedAt: "2026-08-10T00:00:00Z", result: "won", confirmedWon: false }, // 推定の成約＝重くしない
  { conversationId: "d", episodeNo: 1, appliedAt: null, result: "lost" },
];
it("① 申込到達率は変えず、確定の成約の数（won）を足す・推定の成約は数えない", () => {
  const rows = computeReachStats(pts, eps, { nowMs: RNOW });
  const vi = rows.find((r) => r.action === "viewing_invite")!; const rp = rows.find((r) => r.action === "reply")!;
  eq([vi.n, vi.reached, vi.rate, vi.won], [2, 1, 0.5, 1]); eq([rp.n, rp.reached, rp.rate, rp.won], [2, 1, 0.5, 0]);
  eq(reachScore(vi, 1), 1); eq(reachScore(rp, 1), 0.5);
});
it("① ブレインに渡す数字: 同じ率なら確定の成約のある判断が先・「うち成約確定」を添える（重み0なら旧の並び）", () => {
  const rows = computeReachStats(pts, eps, { nowMs: RNOW });
  const n1 = buildReachNote(rows, "viewing", "pre_viewing", { minN: 2, winWeight: 1, labels: { viewing_invite: "内覧誘導" } });
  const lines = n1.split("\n");
  ok(lines[1].includes("内覧誘導") && lines[1].includes("うち成約確定 1"), n1);
  const n0 = buildReachNote(rows, "viewing", "pre_viewing", { minN: 2, winWeight: 0 });
  ok(!n0.includes("成約確定"), n0);
  eq(confirmedWinWeight({}), 1); eq(confirmedWinWeight({ WIN_CONFIRMED_WEIGHT: "off" }), 0); eq(confirmedWinWeight({ WIN_CONFIRMED_WEIGHT: "2" }), 2);
});
it("① 成約パターン: 印 [成約確定] の札と並び（段階が合う物の中で先）", () => {
  eq(withConfirmedWinMark("転換点X"), `${CONFIRMED_WIN_MARK} / 転換点X`); eq(withConfirmedWinMark(withConfirmedWinMark("x")), `${CONFIRMED_WIN_MARK} / x`);
  ok(isConfirmedWinNotes("[成約確定] / x"));
  eq(winningOutcomeTag("applying", {}, "[成約確定] / x"), "【申込に届いた・成約確定】");
  eq(winningOutcomeTag("applying", {}, "x"), "【申込に届いた】");
  eq(winningOutcomeTag("applying", { WIN_CONFIRMED_WEIGHT: "off" }, "[成約確定] / x"), "【申込に届いた】");
  eq(winningOutcomeTag("closed_lost", {}, "[成約確定]"), "【失注】");
  const rows = [{ id: 1, notes: "a", checkpoint_stage: "viewing" }, { id: 2, notes: "[成約確定] / b", checkpoint_stage: "proposing" }, { id: 3, notes: "[成約確定] / c", checkpoint_stage: "viewing" }];
  eq(orderWinningPatterns(rows, "viewing", {}).map((r) => r.id), [3, 1, 2]);
  eq(orderWinningPatterns(rows, null, {}).map((r) => r.id), [2, 3, 1]);
  eq(orderWinningPatterns(rows, "viewing", { WIN_CONFIRMED_WEIGHT: "off" }).map((r) => r.id), [1, 3, 2]);
});
it("① オススメの学習の強い正の重み: 確定の成約 3＞申込 2＞内覧 1・負なし", () => {
  eq(strongPositiveWeight("won", {}), 3); eq(strongPositiveWeight("applied", {}), 2); eq(strongPositiveWeight("viewing_held", {}), 1); eq(strongPositiveWeight(null, {}), 0);
  eq(strongPositiveWeight("won", { WIN_CONFIRMED_WEIGHT: "off" }), 2);
});

// ── 追加の決定（失注・AI貢献率・線） ───────────────────────────
it("追加: 失注は負の正解にしない（既定）・LOST_AS_NEGATIVE=on で旧", () => {
  eq(lostAsNegativeEnabled({}), false); eq(lostAsNegativeEnabled({ LOST_AS_NEGATIVE: "on" }), true);
  const rows = [{ id: 1, notes: "a", outcome_type: "applying" }, { id: 2, notes: "b", outcome_type: "closed_lost" }];
  eq(orderWinningPatterns(rows, null, {}).map((r) => r.id), [1]); // ブレインに【失注】を渡さない
  eq(orderWinningPatterns(rows, null, { LOST_AS_NEGATIVE: "on" }).map((r) => r.id), [1, 2]);
});
it("追加: AI貢献率は申込で数える・確定の成約を別に並べる（旧の値はそのまま読める）", () => {
  eq(attributionLineOf({ basis: "applied", rate: 0.5, total: 20, ai_assisted: 10, won_total: 4, won_assisted: 3 }), "🤖 AI貢献率: 50%（直近30日申込20件中10件AI貢献・成約確定4件中3件）");
  eq(attributionLineOf({ basis: "applied", rate: 0.5, total: 20, ai_assisted: 10, won_total: 0, won_assisted: 0 }), "🤖 AI貢献率: 50%（直近30日申込20件中10件AI貢献）");
  eq(attributionLineOf({ rate: 0.25, total: 4, ai_assisted: 1 }), "🤖 AI貢献率: 25%（直近30日成約4件中1件AI貢献）");
  eq(attributionLineOf(null), "");
});
it("追加: 申込到達率の線の既定は 10 案件", () => { eq(reachMinN({}), 10); eq(reachMinN({ BRAIN_APPLY_REACH_MIN_N: "20" }), 20); });

// ── ⑤ 日付の無い約束 ───────────────────────────────────────
const REAL_UNDATED = [ // 実送信（全期間の監査で拾った4通・scripts/audit-contact-promise-undated.ts）
  "かしこまりました！！\n再度交渉させていただきましたが最大でも1ヶ月前のお申込みで8月半ばご入居とのご返事変わらずでした！！\n時期が来ましたら募集状況確認させていただきます😊！！",
  "夏奈さん\nお世話になっております！！\n\n退去後のお部屋でしたらお申込みいただいてから1ヶ月間程が入居可能時期となります😊！！\n\n夏奈さんのお引越し時期が来ましたら再度お部屋探しサポートさせていただきます😌！！",
  "ご査収いただきありがとうございます😊！！\nプラウド南堀江は8月末退去予定、9/1日以降でのご案内が出来ますので時期が来ましたらお部屋のご案内させていただきます！！",
  "𝒮さん本日お時間頂きありがとうございました！！\n\nお父様の事など大変な時期と思われますが、落ち着いたタイミングでご連絡下さい！！\n\nSさんのお引越しのタイミングが来ましたら引き続き全力でサポートさせていただきます！！",
  "来年再相談させて頂きます！！引き続き何卒よろしくお願い致します！！",
];
const NOT_UNDATED = [ // 約束ではない・日付つき・今日の約束・お客様にお願い
  "体調が落ち着かれましたらいつでもお気軽にご連絡ください！！",
  "落ち着かれましたらいつでもお気軽にご連絡ください。内覧日程の調整させていただきます。",
  "7月1日にきむらさんのご条件に合ったお部屋をピックアップしお送りさせて頂きます！！",
  "確認出来次第ご連絡させて頂きます！！",
  "引き続き新着でオススメ出来るお部屋が出ましたらお送りさせて頂きます！！",
  "お引越しの時期が近づいてまいりましたので、お部屋お送りさせていただきました😊！！",
  "来年から社会人の場合親御様での代理契約可能ですと1番審査通過する可能性が高くなります！！",
];
it("⑤ 日付の無い約束を拾う（実送信4通＋来年再相談）", () => {
  for (const t of REAL_UNDATED) ok(parseUndatedContactPromise(t, "2026-10-01T03:00:00Z"), t.slice(0, 30));
});
it("⑤ 約束でない・日付つき・確認の約束・新着の待ち・過去形は拾わない", () => {
  for (const t of NOT_UNDATED) eq(parseUndatedContactPromise(t, "2026-10-01T03:00:00Z"), null, t.slice(0, 30));
});
it("⑤ 画面に出すのは、こちらの最後の会話文が日付の無い約束で、その後に連絡の日の行が無い時だけ（60日以内）", () => {
  const msgs = [
    { sender: "customer", text: "来年になりそうです", createdAt: "2026-10-01T02:00:00Z" },
    { sender: "staff", text: REAL_UNDATED[4], createdAt: "2026-10-01T03:00:00Z" },
    { sender: "customer", text: "よろしくお願いします", createdAt: "2026-10-01T04:00:00Z" },
  ];
  const now = Date.parse("2026-10-08T00:00:00Z");
  ok(pendingUndatedPromise(msgs, [], now));
  // その後にこちらが別の会話文を送った → 出さない
  eq(pendingUndatedPromise([...msgs, { sender: "staff", text: "かしこまりました！！", createdAt: "2026-10-02T00:00:00Z" }], [], now), null);
  // 資料文（🌟）は数えない → まだ出る
  ok(pendingUndatedPromise([...msgs, { sender: "staff", text: "🌟サンライト 202号室", createdAt: "2026-10-02T00:00:00Z" }], [], now));
  // 約束の後に連絡の日の行を入れた → 出さない／前の行は関係ない
  const row = { notes: "【必ず】YUMAさんに連絡【連絡日 2027-01-10】\n約束: 「x」", created_at: "2026-10-02T00:00:00Z" };
  eq(pendingUndatedPromise(msgs, [row], now), null);
  ok(pendingUndatedPromise(msgs, [{ ...row, created_at: "2026-09-01T00:00:00Z" }], now));
  // 60日より前の約束は出さない
  eq(pendingUndatedPromise(msgs, [], Date.parse("2026-12-15T00:00:00Z")), null);
});
it("⑤ 選んだ日で【必ず】の連絡の日の行を作る（今日より前・3年より先は作らない）", () => {
  const p = { sentence: "来年再相談させて頂きます", sentAt: "2026-10-01T03:00:00Z" };
  const c = undatedPromiseToContact(p, "2027-01-10", Date.parse("2026-10-08T00:00:00Z"))!;
  eq(c.contact, { y: 2027, m: 1, d: 10 });
  const row = contactEventRow(c, { customerName: "YUMA", conversationId: "x", sentAt: p.sentAt });
  ok(isContactPromiseNotes(row.notes)); ok(row.notes.startsWith("【必ず】YUMAさんに連絡【連絡日 2027-01-10】"), row.notes);
  eq(undatedPromiseToContact(p, "2026-10-01", Date.parse("2026-10-08T00:00:00Z")), null);
  eq(undatedPromiseToContact(p, "2030-01-01", Date.parse("2026-10-08T00:00:00Z")), null);
  eq(undatedPromiseToContact(p, "2027-02-30", Date.parse("2026-10-08T00:00:00Z")), null);
});
it("⑤ CONTACT_PROMISE_UNDATED=off で拾わない", () => {
  process.env.CONTACT_PROMISE_UNDATED = "off";
  try { eq(parseUndatedContactPromise(REAL_UNDATED[4], "2026-10-01T03:00:00Z"), null); } finally { delete process.env.CONTACT_PROMISE_UNDATED; }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" -", f); process.exit(1); }
