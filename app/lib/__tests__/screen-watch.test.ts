// app/lib/__tests__/screen-watch.test.ts
// 見張り（screen-watch.ts・純関数）のテスト。実行: npx tsx app/lib/__tests__/screen-watch.test.ts
//
// 2026-09-29 竹内「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？ …画面開いているのも目で見ることができるのが理想」
//   実物の形の文（ログイン画面・メンテナンス・9/29 のスクショ「16,042棟」・過去の値がある0件・モーダル）で決定論を固定し、
//   動きが「止める・待つ・知らせる」だけ（再読み込み・再試行・クリックを返さない）・予算の関所・名前の伏せ方・Jev の答えの読み・2倍の単価を固定する
import {
  detectScreenState, expectedCountRange, actionFor, watchBudgetGate, maskWatchText, parseJevLabel, parseWatchText, parseArbiter, stopNoticeText,
  shouldSendStopNotice, readWatchConfig, outcomeOf, placesDiffer, tuneCountThresholds, tuneJevGate, jstDate, jstDayStartIso, sanitizeThresholds,
  WATCH_ACTIONS, WATCH_LABELS, DAILY_COUNT_CAP, PER_RUN_CAP, STOP_NOTICE_GAP_MS, SCREEN_WATCH_TEXT_PROMPT, SCREEN_WATCH_ARBITER_PROMPT, DEFAULT_THRESHOLDS,
  type WatchMaterial, type EventLite,
} from "../screen-watch";
import { altUsageUsd, altPriceOf, isDeepseekPeakAt } from "../llm-price";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}
const m = (x: Partial<WatchMaterial>): WatchMaterial => ({ checkpoint: "results", site: "realpro", ...x });

console.log("\n■ ① 決定論（実物の形の文）");
{
  const login = detectScreenState(m({ dom: { url: "https://www.realnetpro.com/login.php", title: "ログイン | リアルネットプロ", count_text: null, count_number: null } }));
  t("ログインの画面（URL）→ login_expired・硬い", login.label === "login_expired" && login.hard, login);
  const loginTxt = detectScreenState(m({ dom: { url: "https://www.realnetpro.com/main.php", alert_text: "セッションが切れました。再度ログインしてください。" } }));
  t("「セッションが切れました」→ login_expired・硬い", loginTxt.label === "login_expired" && loginTxt.hard, loginTxt);
  const loginErr = detectScreenState(m({ checkpoint: "results", error: "リアプロのセッションが見つかりません。リアプロにログインしてください。" }));
  t("拡張の失敗の文が未ログイン → login_expired・硬い", loginErr.label === "login_expired" && loginErr.hard, loginErr);
  const loginButCount = detectScreenState(m({ dom: { alert_text: "ログインしてください", count_text: "全 120 件", count_number: 120 } }));
  t("件数が出ている画面のログインの文 → 硬くない（止めない）", loginButCount.label === "login_expired" && !loginButCount.hard, loginButCount);
  const maint = detectScreenState(m({ dom: { title: "メンテナンス中", alert_text: "ただいまメンテナンス中です。しばらくお待ちください" } }));
  t("メンテナンス → site_error・硬い", maint.label === "site_error" && maint.hard, maint);
  const maintNews = detectScreenState(m({ dom: { alert_text: "メンテナンス中のお知らせ（10/1 2:00〜）", count_text: "該当 58 件", count_number: 58 } }));
  t("件数が出ている画面のお知らせのメンテナンス → 硬くない", maintNews.label === "site_error" && !maintNews.hard, maintNews);
  // ITANDI は件数の文が読めない（count_text は全部 null）→ 予告のお知らせだけで止めない
  const maintNewsNoCount = detectScreenState(m({ site: "itandi", dom: { alert_text: "システムメンテナンス中のお知らせ（10/1 2:00〜5:00）" } }));
  t("件数が読めない画面でも予告のお知らせ → 硬くない（ITANDI を2時間止めない）", maintNewsNoCount.label === "site_error" && !maintNewsNoCount.hard, maintNewsNoCount);
  const maintNowNoCount = detectScreenState(m({ site: "itandi", dom: { alert_text: "ただいまメンテナンス中です。10:00 再開予定" } }));
  t("「ただいまメンテナンス」は再開の予定が書いてあっても硬い", maintNowNoCount.label === "site_error" && maintNowNoCount.hard, maintNowNoCount);
  const busy = detectScreenState(m({ dom: { modal_text: "只今アクセスが集中しております" } }));
  t("アクセスが集中 → site_error", busy.label === "site_error", busy);
  const huge = detectScreenState(m({ dom: { count_text: "16,042棟", count_number: 16042, page_text: "1 / 10 ページ" } }));
  t("9/29 のスクショ「16,042棟」→ wrong_conditions（条件が効いていない量）", huge.label === "wrong_conditions" && /16,042/.test(huge.reason), huge);
  t("  ⚠ の1行が付く", !!huge.notice && huge.notice.startsWith("⚠ 条件が入り切っていない検索"), huge.notice);
  const wideArea = detectScreenState(m({ dom: { count_text: "3,420棟", count_number: 3420 }, area_size: 24 }));
  t("広い検索（大阪市内の24区など）は 3,000 超でも疑わない", wideArea.label === "normal", wideArea);
  const range = expectedCountRange([{ count: 40, kind: "screen" }, { count: 50, kind: "screen" }, { count: 45, kind: "screen" }]);
  const jump = detectScreenState(m({ dom: { count_text: "全 480 件", count_number: 480 }, range }));
  t("過去の画面の件数（中央値45）の5倍超 → wrong_conditions", jump.label === "wrong_conditions" && jump.rules.some((r) => r.startsWith("wrong:count_jump")), jump);
  const zero = detectScreenState(m({ dom: { count_text: "該当する物件はありません", count_number: 0 }, range }));
  t("過去の値がある（下限13）0件 → zero_suspicious", zero.label === "zero_suspicious", zero);
  const zeroNew = detectScreenState(m({ dom: { count_text: "該当する物件はありません", count_number: 0 }, range: null }));
  t("過去が無い0件 → 疑わない（normal）", zeroNew.label === "normal", zeroNew);
  const zeroSmall = detectScreenState(m({ dom: { count_number: 0 }, range: expectedCountRange([{ count: 3, kind: "rows" }, { count: 2, kind: "rows" }]) }));
  t("過去の下限が3件未満の0件 → 疑わない", zeroSmall.label === "normal", zeroSmall);
  const modal = detectScreenState(m({ dom: { modal_text: "沿線・駅を選択 閉じる", count_number: null } }));
  t("モーダル（止まりでない）→ modal_blocking・硬くない", modal.label === "modal_blocking" && !modal.hard, modal);
  const modalStall = detectScreenState(m({ checkpoint: "stall", stall_kind: "stall", dom: { modal_text: "所在地を選択" } }));
  t("止まり＋モーダル → modal_blocking・硬い", modalStall.label === "modal_blocking" && modalStall.hard, modalStall);
  const stall = detectScreenState(m({ checkpoint: "stall", stall_kind: "pass_deadline", idle_min: 7, waiting_for: "検索の完了（fill-done）と全ページの送信" }));
  t("1回の検索の上限 → stuck", stall.label === "stuck" && /7分/.test(stall.reason), stall);
  const upd = detectScreenState(m({ checkpoint: "done", checks: [
    { code: "UPDATE_DAYS", severity: "warn", cause_key: "update_days:realpro:differs", title: "更新日が決まりと違う" },
    { code: "RESET_FAILED", severity: "warn", cause_key: "reset_failed:realpro", title: "前の条件を消せなかった" },
    { code: "FLOOR_PLAN_DROPPED", severity: "warn", cause_key: "floor_plan_dropped:realpro:2DK", title: "間取り「2DK」が入っていない" },
  ] }));
  t("UPDATE_DAYS の warn（と warn の札）→ normal（誤警報にしない）", upd.label === "normal", upd);
  const miss = detectScreenState(m({ checkpoint: "filled", checks: [{ code: "STATION_MISSING", severity: "bad", cause_key: "station_missing:realpro:-:東三国", title: "東三国が入っていない" }] }));
  t("STATION_MISSING（bad）→ wrong_conditions・⚠（東三国が入っていない）", miss.label === "wrong_conditions" && miss.notice === "⚠ 条件が入り切っていない検索（東三国が入っていない）", miss);
  const zc = detectScreenState(m({ checkpoint: "done", checks: [{ code: "ZERO_UNCONFIRMED", severity: "bad", cause_key: "zero_unconfirmed:realpro:no_rows", title: "0件（検索できていたか確かめられない）" }] }));
  t("ZERO_UNCONFIRMED（bad）→ zero_suspicious", zc.label === "zero_suspicious", zc);
  const drift = detectScreenState(m({ checkpoint: "filled", decision: { severity: "warn", items: [{ kind: "commute_missing", severity: "warn", title: "通勤の到達駅が抜けた（梅田まで30分: 期待 240駅・入った 3駅）" }] } }));
  t("決め方のズレ → decision_drift", drift.label === "decision_drift", drift);
  const normal = detectScreenState(m({ dom: { count_text: "検索結果 128件", count_number: 128, page_text: "1 / 7 ページ" }, range }));
  t("ふつうの結果 → normal", normal.label === "normal" && normal.rules.length === 0, normal);
}

console.log("\n■ 過去の値（件数の幅）");
{
  const r = expectedCountRange([{ count: 58, kind: "rows" }, { count: 63, kind: "rows" }, { count: 63, kind: "rows" }]);
  t("中央値63 → 下限18・上限189", r?.low === 18 && r?.high === 189 && r?.median === 63, r);
  const small = expectedCountRange([{ count: 2, kind: "rows" }]);
  t("小さい値は 下限1・上限30（最低）", small?.low === 1 && small?.high === 30, small);
  t("過去が無ければ null", expectedCountRange([]) === null);
  const six = expectedCountRange([1, 2, 3, 4, 5, 100].map((c) => ({ count: c, kind: "rows" as const })));
  t("直近5回だけ（100 は数えない）", six?.median === 3, six);
  const zeros = expectedCountRange([{ count: 0, kind: "rows" }, { count: 0, kind: "rows" }]);
  t("過去も0件 → 下限0（0件を疑わない）", zeros?.low === 0, zeros);
}

console.log("\n■ 動き（止める・待つ・知らせるだけ）");
{
  const all = WATCH_LABELS.flatMap((l) => [actionFor(l, { hard: true }), actionFor(l, { hard: false })]);
  t("どのラベルでも再読み込み・再試行・クリックを返さない", all.every((a) => (WATCH_ACTIONS as readonly string[]).includes(a.kind)) && !all.some((a) => /reload|retry|click/i.test(JSON.stringify(a))), all.map((a) => a.kind));
  t("ログイン切れ（硬い）→ そのサイトを止める・知らせる", actionFor("login_expired", { hard: true }).stopSite && actionFor("login_expired", { hard: true }).notify);
  t("ログイン切れ（硬くない）→ 止めない", !actionFor("login_expired", { hard: false }).stopSite);
  t("サイトのエラー（硬い）→ 止める", actionFor("site_error", { hard: true }).kind === "stop_site");
  t("止まり・モーダル → 待つ（新しい動きは足さない）", actionFor("stuck", { hard: false }).kind === "wait" && actionFor("modal_blocking", { hard: true }).kind === "wait" && !actionFor("modal_blocking", { hard: true }).stopSite);
  t("条件が入り切っていない・0件の疑い → 自動の広げてを止める・知らせる", actionFor("wrong_conditions", { hard: false }).blockWiden && actionFor("zero_suspicious", { hard: false }).blockWiden);
  t("決め方のズレ → 提案だけ（段1）", actionFor("decision_drift", { hard: false }).kind === "suggest" && !actionFor("decision_drift", { hard: false }).stopSite);
  t("止めた時の1通の文（残り N人は見送り）", stopNoticeText("login_expired", "realpro", 5) === "⚠【見張り】リアプロのログインが切れています。ログインし直してください（残り 5人は見送り）");
  t("サイト×2時間に1通", shouldSendStopNotice(null, 1000) && !shouldSendStopNotice(0, STOP_NOTICE_GAP_MS - 1) && shouldSendStopNotice(0, STOP_NOTICE_GAP_MS));
}

console.log("\n■ 予算の関所（$10・回数）");
{
  const base = { spentUsd: 0.08, capUsd: 10, counts: {}, perRun: {}, arbiterDoneToday: false, keys: { jev: true, deepseek: true } };
  const g = watchBudgetGate(base);
  t("ふだん → 全部の段が使える", g.state === "ok" && g.allow.jev && g.allow.text && g.allow.image && g.allow.arbiter, g);
  const cap = watchBudgetGate({ ...base, spentUsd: 10 });
  t("$10 に達したら ①だけ（capped・②③④は止める）", cap.state === "capped" && !cap.allow.jev && !cap.allow.text && !cap.allow.image && !cap.allow.arbiter, cap);
  const unknown = watchBudgetGate({ ...base, spentUsd: Infinity });
  t("費用が読めない時も止める（安全側）", unknown.state === "capped", unknown);
  const near = watchBudgetGate({ ...base, spentUsd: 9.9995 });
  t("見積もりで上限を超える段は止める（写真 $0.001 は止め・Jev は通す）", !near.allow.image && near.allow.jev, near.allow);
  const perRun = watchBudgetGate({ ...base, perRun: { jev: PER_RUN_CAP.jev, text: PER_RUN_CAP.text, image: PER_RUN_CAP.image } });
  t("1回の検索あたりの上限（Jev 4・文字 2・写真 1）", !perRun.allow.jev && !perRun.allow.text && !perRun.allow.image && perRun.allow.arbiter, perRun.allow);
  const daily = watchBudgetGate({ ...base, counts: { jev: DAILY_COUNT_CAP.jev, text: DAILY_COUNT_CAP.text, image: DAILY_COUNT_CAP.image, arbiter: DAILY_COUNT_CAP.arbiter } });
  t("1日の回数の上限（Jev 600・文字 150・写真 20・裁定 60）", !daily.allow.jev && !daily.allow.text && !daily.allow.image && !daily.allow.arbiter, daily.allow);
  t("裁定はお客様×サイト×日に1回", !watchBudgetGate({ ...base, arbiterDoneToday: true }).allow.arbiter);
  const nokey = watchBudgetGate({ ...base, keys: { jev: false, deepseek: false } });
  t("鍵が無い時は no_key（決定論だけ・検索は止めない）", nokey.state === "no_key" && !nokey.allow.jev && !nokey.allow.text, nokey);
  const jevOnly = watchBudgetGate({ ...base, keys: { jev: false, deepseek: true } });
  t("Jev の鍵が無い時は Jev だけ止める", !jevOnly.allow.jev && jevOnly.allow.text, jevOnly.allow);
  t("JST の日付と今日の始まり", jstDate(Date.UTC(2026, 8, 28, 15, 30)) === "2026-09-29" && jstDayStartIso(Date.UTC(2026, 8, 29, 3)) === "2026-09-28T15:00:00.000Z");
}

console.log("\n■ 帯の文を抜き名前を伏せる");
{
  const a = maskWatchText("隼斗: 家賃〜10.5万 / 2K 2DK 2LDK / 更新3日内(前回09/29) 検索結果 16,042棟 隼斗さん 090-1234-5678", { names: ["隼斗"] });
  t("帯の頭の名前・本文の名前・電話が消える", !a.includes("隼斗") && !a.includes("090") && a.includes("16,042棟") && a.includes("家賃〜10.5万"), a);
  const b = maskWatchText("▶ 一括検索中（隼斗・リアプロ） 件数 58件", { bandText: "▶ 一括検索中（隼斗・リアプロ）", names: [] });
  t("band_text そのものは抜く", !b.includes("隼斗") && b.includes("58件"), b);
  const c = maskWatchText("該当物件はありません", { names: ["竹内悠馬"] });
  t("名前の無い文はそのまま", c === "該当物件はありません", c);
}

console.log("\n■ Jev・DeepSeek の答えの読み");
{
  t("Jev の知っているラベル", JSON.stringify(parseJevLabel({ label: { choice: "login_expired", probabilities: { login_expired: 0.93 } } })) === JSON.stringify({ label: "login_expired", prob: 0.93 }));
  t("Jev の知らないラベルは null", parseJevLabel({ label: { choice: "reload_page" } }) === null);
  t("Jev の答えが無ければ null", parseJevLabel(null) === null && parseJevLabel({}) === null);
  t("DeepSeek の文字の答え", parseWatchText('```json\n{"label":"site_error","reason_ja":"メンテナンスの表示","confidence":0.8}\n```')?.label === "site_error");
  t("DeepSeek の知らないラベルは null", parseWatchText('{"label":"click_retry","reason_ja":"x"}') === null);
  const ar = parseArbiter('{"right":"table","missing":["十三","江坂"],"extra":[],"next":"re_search_temp","reason_ja":"通勤の到達駅が抜けた","confidence":0.7}');
  t("裁定の答え", ar?.right === "table" && ar.missing.join() === "十三,江坂" && ar.next === "re_search_temp", ar);
  t("裁定の知らない next は null", parseArbiter('{"right":"brain","next":"click_search"}') === null);
  t("固定の前置きは版つき・先頭が固定（キャッシュ）", SCREEN_WATCH_TEXT_PROMPT.startsWith("【見張り・画面の文字】screen-watch-text-v1") && SCREEN_WATCH_ARBITER_PROMPT.startsWith("【見張り・検索の決め方の裁定】screen-watch-arbiter-v1"));
  t("裁定の前置きに通勤の決まり（乗り換え1回・上限240）", /乗り換え1回/.test(SCREEN_WATCH_ARBITER_PROMPT) && /240/.test(SCREEN_WATCH_ARBITER_PROMPT));
}

console.log("\n■ 単価（2倍の安全側）");
{
  const row = { model: "deepseek-flash", input_uncached: 770, cache_read: 1060, output_tokens: 240, created_at: "2026-09-27T05:00:00Z" }; // 日曜＝混雑していない
  const off = altUsageUsd(row);
  const want = (770 * 0.15 + 1060 * 0.003 + 240 * 0.6) / 1e6;
  t("DeepSeek flash（混雑していない時）", Math.abs(off - want) < 1e-12, { off, want });
  t("上限の計算は常に2倍", Math.abs(altUsageUsd(row, { alwaysPeak: true }) - want * 2) < 1e-12);
  t("平日 JST 11時は混雑（2倍）", isDeepseekPeakAt("2026-09-29T02:00:00Z") && Math.abs(altUsageUsd({ ...row, created_at: "2026-09-29T02:00:00Z" }) - want * 2) < 1e-12);
  t("pro の単価", altPriceOf("deepseek-v4-pro")?.in === 0.66 && altPriceOf("deepseek-v4-pro")?.out === 1.98);
  t("Jev（入力 $0.042/100万・2倍にしない）", Math.abs(altUsageUsd({ model: "jev:jev-latest", input_uncached: 1500, output_tokens: 3 }, { alwaysPeak: true }) - 1500 * 0.042 / 1e6) < 1e-12);
  t("Claude・知らないモデルは 0", altUsageUsd({ model: "claude-sonnet-5", input_uncached: 1000 }) === 0);
}

console.log("\n■ 設定・結果の結び付け・線の調整");
{
  const c0 = readWatchConfig({});
  t("既定: on・$10・Jev は影・写真 on・自動調整 on", c0.enabled && c0.dailyUsd === 10 && c0.jev === "shadow" && c0.image && c0.autoTune && c0.notifyGroup, c0);
  const c1 = readWatchConfig({ SCREEN_WATCH: "off", SCREEN_WATCH_DAILY_USD: "3", SCREEN_WATCH_JEV: "gate", SCREEN_WATCH_IMAGE: "off", SCREEN_WATCH_AUTO_TUNE: "off" });
  t("環境変数で止める・変える", !c1.enabled && c1.dailyUsd === 3 && c1.jev === "gate" && !c1.image && !c1.autoTune, c1);
  t("24時間たつまで結ばない", outcomeOf("wrong_conditions", { severity: "bad", ageMs: 3600_000 }) === null);
  t("異常と見て本当に bad → 当たり", outcomeOf("wrong_conditions", { severity: "bad", cause_key: "station_missing:realpro:-:東三国", ageMs: 25 * 3600_000 })?.outcome === "hit");
  t("異常と見たが ok → 外れ（誤警報）", outcomeOf("zero_suspicious", { severity: "ok", ageMs: 25 * 3600_000 })?.outcome === "false_alarm");
  t("更新日だけの bad は本当の異常ではない", outcomeOf("normal", { severity: "bad", cause_key: "update_days:realpro:not_filled", ageMs: 25 * 3600_000 })?.outcome === "ok");
  t("問題なしと見たがスタッフが手で直した → 見逃し", outcomeOf("normal", { severity: "ok", staffFixed: true, ageMs: 25 * 3600_000 })?.outcome === "miss");
  t("駅の並びの違い（駅の有無・「駅」の付け外しは同じ）", placesDiffer(["梅田", "十三"], ["梅田"]) && !placesDiffer(["梅田駅", "十三"], ["十三", "梅田"]));
  const evs: EventLite[] = [];
  for (let i = 0; i < 40; i++) evs.push({ final_label: "zero_suspicious", outcome: "false_alarm", material: { count: 0, range_median: 12 } }); // 下限 3 → 誤警報
  for (let i = 0; i < 5; i++) evs.push({ final_label: "zero_suspicious", outcome: "hit", material: { count: 0, range_median: 40 } });
  const tuned = tuneCountThresholds(evs, DEFAULT_THRESHOLDS);
  t("誤警報が減り見逃しが増えない倍率だけ（0.3→0.2）", tuned?.thresholds.countLo === 0.2 && (tuned.backtest.after as { miss: number }).miss === 0, tuned);
  t("行が30未満なら当て直さない", tuneCountThresholds(evs.slice(0, 10), DEFAULT_THRESHOLDS) === null);
  const jevRows: EventLite[] = Array.from({ length: 120 }, (_, i) => ({ final_label: "normal", jev_label: i < 20 ? "wrong_conditions" : "normal", jev_prob: 0.9, outcome: i < 20 ? "hit" : "ok" }));
  const jg = tuneJevGate(jevRows);
  t("Jev の線: 本当の異常の見逃し率 5%以下", !!jg && jg.missRate <= 0.05 && jg.n === 120, jg);
  t("Jev の線: 100行未満は出さない", tuneJevGate(jevRows.slice(0, 50)) === null);
  t("線の形が壊れていれば既定", JSON.stringify(sanitizeThresholds({ countLo: 9, countHi: "x" })) === JSON.stringify(DEFAULT_THRESHOLDS));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
