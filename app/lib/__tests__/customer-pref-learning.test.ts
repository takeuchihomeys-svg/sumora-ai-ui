// app/lib/__tests__/customer-pref-learning.test.ts
// お客様ごとのこだわりの倍率の「毎週の学習」（customer-pref-learning.ts）の純関数の回帰テスト。
// 実行: npx tsx app/lib/__tests__/customer-pref-learning.test.ts
//
// 値は本番の形そのまま（2026-09-29 の売上サポの札・お客様の条件欄の書き方・DeepSeek の返事の形）。
import {
  PREF_LEARNING_CONFIG, estimateDeepSeekUsd, isDeepseekPeak, budgetAllows, prefAutoApplyEnabled, PREF_AUTO_APPLY_DEFAULT_ON, decidePrefApply, sanitizePrefTable, diffPrefTables, inputHash,
  LLM_FAMILIES, llmLevelToStrength, STRENGTH_SYSTEM, buildStrengthUser, parseStrengthReply, strengthMapFromLlm,
  APPEAL_SYSTEM, buildAppealUser, parseAppealReply, HYPOTHESIS_SYSTEM, buildHypothesisUser, parseHypothesisReply,
  SUMMARY_SYSTEM, buildSummaryUser, parseSummaryReply, deterministicWeeklySummary, compareStrengthSources, topCounts, type WeeklyNumbers,
} from "../customer-pref-learning";
import { PREF_WEIGHT_CONFIG, type PrefBacktest } from "../customer-pref-weights";
import { maskPII } from "../pii-mask";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("■ 費用・上限");
{
  t("平日 JST 11時（UTC 02時）はピーク・土曜は違う", isDeepseekPeak("2026-09-29T02:00:00Z") && !isDeepseekPeak("2026-09-26T02:00:00Z") && !isDeepseekPeak("2026-09-29T12:00:00Z"));
  // 実測の形: 入力 1,200（命中 900）・出力 60 → 通常時 (300×0.15 + 900×0.003 + 60×0.6)/1e6 = 0.0000837
  const u = estimateDeepSeekUsd({ input: 1200, cacheHit: 900, output: 60 }, "2026-09-29T12:00:00Z");
  t("費用の見積もり（公式料金・命中は 1/50）", Math.abs(u - 0.0000837) < 1e-7, String(u));
  t("ピークは2倍", Math.abs(estimateDeepSeekUsd({ input: 1200, cacheHit: 900, output: 60 }, "2026-09-29T02:00:00Z") - 0.0001674) < 1e-7);
  t("上限未満なら読める・超えたら止める", budgetAllows(0.5, 1) && !budgetAllows(1, 1) && !budgetAllows(NaN, 1) && budgetAllows(0, PREF_LEARNING_CONFIG.weeklyBudgetUsd));
}

console.log("■ 自動で表を更新する（鍵1つ）");
{
  t("既定は on（竹内「組み込む」）・off/0/false で提案だけ", PREF_AUTO_APPLY_DEFAULT_ON && prefAutoApplyEnabled({}) && !prefAutoApplyEnabled({ CUSTOMER_PREF_LEARNING_AUTO_APPLY: "off" }) && !prefAutoApplyEnabled({ CUSTOMER_PREF_LEARNING_AUTO_APPLY: "0" }) && prefAutoApplyEnabled({ CUSTOMER_PREF_LEARNING_AUTO_APPLY: "on" }));
  const bt = (enable: boolean, changes: number, reason: string): Pick<PrefBacktest, "decision" | "learned" | "gain" | "verdictFlips"> => ({
    decision: { enable, reason }, gain: enable ? 0.02 : 0, verdictFlips: { toPass: 0, toHold: 0, candidates: 100 },
    learned: { table: changes ? { floor_plan: { stated: 1.25 } } : {}, changes: Array.from({ length: changes }, () => ({ family: "floor_plan", level: "stated" as const, from: 1, to: 1.25, rounds: 12, relBefore: 0.5, relAfter: 0.48 })), skipped: [] },
  });
  t("学んだ変更が無い → 更新も提案もしない（表は空のまま）", !decidePrefApply({ enabled: true, backtest: bt(false, 0, "学べる 条件 × 強さ が無い") }).apply && !decidePrefApply({ enabled: true, backtest: bt(false, 0, "x") }).propose);
  t("当て直しで良くならない → 更新しない（提案もしない）", !decidePrefApply({ enabled: true, backtest: bt(false, 1, "確かめ用で相対順位の改善が小さい（0.003 < 0.01）") }).apply && !decidePrefApply({ enabled: true, backtest: bt(false, 1, "x") }).propose);
  const ok = decidePrefApply({ enabled: true, backtest: bt(true, 1, "確かめ用で相対順位 0.45 → 0.43") });
  t("良くなった＋鍵 on → 更新する", ok.apply && ok.propose);
  const off = decidePrefApply({ enabled: false, backtest: bt(true, 1, "確かめ用で相対順位 0.45 → 0.43") });
  t("良くなった＋鍵 off → 提案だけ（proposed で残す）", !off.apply && off.propose && /提案だけ/.test(off.reason));
}

console.log("■ 表の形（DB から読んだ物）");
{
  t("正しい表はそのまま・AD は捨てる・範囲に押し込む", JSON.stringify(sanitizePrefTable({ floor_plan: { stated: 1.25, strong: 1.5 }, ad: { strong: 3 }, area: { strong: 9 }, rent: { stated: 0.2 } })) === JSON.stringify({ floor_plan: { stated: 1.25, strong: 1.5 }, area: { strong: PREF_WEIGHT_CONFIG.maxMult }, rent: { stated: PREF_WEIGHT_CONFIG.minMult } }));
  t("壊れた表（配列・段が違う・数でない・鍵の形が違う）は null", sanitizePrefTable([]) === null && sanitizePrefTable({ floor_plan: { weak: 1.2 } }) === null && sanitizePrefTable({ floor_plan: { stated: "1.2" } }) === null && sanitizePrefTable({ "FLOOR PLAN": { stated: 1.2 } }) === null && sanitizePrefTable(null) === null);
  t("空の表は {}（効く所なし）", JSON.stringify(sanitizePrefTable({})) === "{}");
  const d = diffPrefTables({ floor_plan: { stated: 1.25 } }, { floor_plan: { stated: 1.5 }, area: { strong: 1.25 } });
  t("前後の差（1 は書いていないのと同じ）", d.length === 2 && d[0].family === "area" && d[0].from === 1 && d[0].to === 1.25 && d[1].family === "floor_plan" && d[1].from === 1.25 && d[1].to === 1.5 && diffPrefTables(null, {}).length === 0);
  t("ハッシュは同じ文で同じ・1字違えば違う", inputHash("abc") === inputHash("abc") && inputHash("abc") !== inputHash("abd") && /^[0-9a-f]{16}$/.test(inputHash("")));
}

console.log("■ ① お客様のこだわりの強さ（DeepSeek）");
{
  t("前置きに一覧と JSON の形がある・家族は codeFamily の鍵", /rent=家賃/.test(STRENGTH_SYSTEM) && /equip:bath_toilet=バス・トイレ別/.test(STRENGTH_SYSTEM) && /"levels"/.test(STRENGTH_SYSTEM) && LLM_FAMILIES.every((f) => /^[a-z_]+(:[a-z_0-9]+)?$/.test(f.key)));
  // 実物の条件欄の書き方（2026-09-28 の property_customers.ng_points・preferences の形）
  const cond = { rent_max: 70000, floor_plan: "1K", walk_minutes: 10, preferences: "バストイレ別は絶対\n独立洗面台があれば", ng_points: "1階NG\n木造NG", customer_name: "山田太郎", phone: "090-1234-5678", raw_format_text: "" };
  const msgs = ["バストイレ別は譲れないです", "山田です。090-1234-5678 に連絡ください", "宅配ボックスあると嬉しい"];
  const user = buildStrengthUser({ conditions: cond, messages: msgs, mask: (s) => maskPII(s, ["山田太郎"]) });
  t("条件の欄は決まった欄だけ（名前・電話の欄は渡さない）", /家賃の上限: 70000/.test(user) && /NG: 1階NG 木造NG/.test(user) && !/customer_name|phone/.test(user));
  t("発言は仮名化して渡す（電話番号が素で出ない）", /バストイレ別は譲れない/.test(user) && !/090-1234-5678/.test(user), user);
  t("発言なし・記入なしの時も形が崩れない", /（記入なし）/.test(buildStrengthUser({ conditions: null, messages: [], mask: (s) => s })) && /（発言なし）/.test(buildStrengthUser({ conditions: {}, messages: [], mask: (s) => s })));
  const reply = "```json\n{\"levels\":{\"rent\":\"prefer\",\"equip:bath_toilet\":\"absolute\",\"equip:washbasin\":\"prefer\",\"equip:delivery_box\":\"mentioned\",\"equip:floor2\":\"absolute\",\"walk\":\"none\",\"foo\":\"absolute\",\"area\":\"maybe\"}}\n```";
  const p = parseStrengthReply(reply);
  t("返事 → 一覧の鍵と段だけ（none・一覧に無い鍵・知らない段は捨てる）", !!p && p["equip:bath_toilet"] === "absolute" && p.rent === "prefer" && p["equip:delivery_box"] === "mentioned" && !("walk" in p) && !("foo" in p) && !("area" in p), JSON.stringify(p));
  t("levels が無い・JSON でない返事は null", parseStrengthReply("{\"x\":1}") === null && parseStrengthReply("読み取れません") === null);
  const m = strengthMapFromLlm(p);
  t("4段 → 3段（absolute=strong・prefer/mentioned=stated）", m["equip:bath_toilet"] === "strong" && m.rent === "stated" && m["equip:delivery_box"] === "stated" && llmLevelToStrength("none") === "none" && llmLevelToStrength(null) === "none");
}

console.log("■ ② スタッフが訴求した点");
{
  t("前置きに一覧と JSON の形", /rent=家賃/.test(APPEAL_SYSTEM) && /"appeals"/.test(APPEAL_SYSTEM));
  // 実物の🌟の本文の形（recommendation_snapshots.star_text）
  const star = "山田様\n🌟一番オススメ\n【1】エグゼレジデンスタワー 301\n家賃6.8万円・敷礼0・駅徒歩5分で予算内です！\nバストイレ別・独立洗面台付きです";
  const u = buildAppealUser([star, ""], (s) => maskPII(s, ["山田太郎"]));
  t("送った文は番号付きで並べる・空は落とす", /\(1\) /.test(u) && !/\(2\)/.test(u));
  const a = parseAppealReply("{\"appeals\":[\"rent\",\"initial_cost\",\"station_near\",\"bath_toilet\",\"rent\",\"xxx\"]}");
  t("返事 → 一覧の鍵だけ・重複は1つ", !!a && a.join(",") === "rent,initial_cost,station_near,bath_toilet");
  t("空の配列は空（読めた扱い）・配列でなければ null", parseAppealReply("{\"appeals\":[]}")?.length === 0 && parseAppealReply("{\"appeals\":\"rent\"}") === null);
}

console.log("■ ③ 👑 と違う物件を選んだ理由の仮説");
{
  t("前置きに一覧と JSON の形", /walk=駅徒歩/.test(HYPOTHESIS_SYSTEM) && /photo=/.test(HYPOTHESIS_SYSTEM) && /"items"/.test(HYPOTHESIS_SYSTEM));
  const u = buildHypothesisUser({
    crown: { name: "AIA難波南 102", facts: "【1】AIA難波南 102 家賃6.5万 1K 25㎡ 築5年 徒歩8分 AD2", reasons: ["家賃が上限内", "間取り一致", "AD 2ヶ月以上"], score: 118 },
    chosen: { name: "エグゼレジデンスタワー 301", facts: "【4】エグゼレジデンスタワー 301 家賃6.9万 1DK 30㎡ 築12年 徒歩4分 AD1", reasons: ["家賃が上限内", "近い間取り"], score: 96 },
    strength: { rent: "stated", walk: "strong", size: "strong", floor_plan: "none" },
  }, (s) => s);
  t("お客様のこだわり（none は出さない）と2つの物件を並べる", /駅徒歩=絶対/.test(u) && /広さ・帖数=絶対/.test(u) && /家賃=希望/.test(u) && !/間取り=/.test(u) && /採点の1位（👑・送らなかった）】AIA難波南 102（118点）/.test(u) && /スタッフが送った物件】エグゼレジデンスタワー 301（96点）/.test(u), u);
  const h = parseHypothesisReply("{\"items\":[\"walk\",\"size\",\"ad\",\"rent\",\"zzz\"],\"note\":\"駅近と広さを優先したと読める。\\nAD は社内の事情\"}");
  t("返事 → 一覧の鍵だけ・多くて3つ・自由文は1行 60字以内", !!h && h.items.join(",") === "walk,size,ad" && h.note === "駅近と広さを優先したと読める。 AD は社内の事情");
  t("項目が空なら unknown・配列でなければ null", parseHypothesisReply("{\"items\":[],\"note\":\"\"}")?.items[0] === "unknown" && parseHypothesisReply("{\"items\":\"walk\"}") === null);
}

console.log("■ ④ 週のまとめ");
{
  const n: WeeklyNumbers = {
    weekOf: "2026-10-04T20:40:00Z", rounds: 383, customers: 108, train: 269, holdout: 114,
    base: { relRank: 0.435, top1: 0.28, top3: 0.42, top10: 0.77 }, weighted: { relRank: 0.435, top1: 0.28, top3: 0.42, top10: 0.77 }, gain: 0,
    changes: [], skipped: [{ family: "floor_plan", level: "stated", rounds: 34, reason: "動かない（学んでも同じ順位）" }], worseBands: [], verdictFlips: { toPass: 0, toHold: 0 },
    decision: "学べる 条件 × 強さ が無い（件数・人数の不足か、動かしても順位が変わらない）", applied: false, llmGain: 0.002, strengthAgree: { compared: 120, agree: 84 },
    appealTop: [["rent", 40], ["station_near", 22], ["initial_cost", 18], ["equipment", 5]], hypothesisTop: [["walk", 6], ["size", 4], ["unknown", 3]], reads: { customer: 40, appeal: 40, hypothesis: 30, usd: 0.0412 },
  };
  const s = deterministicWeeklySummary(n);
  const lines = s.split("\n");
  t("決定論のまとめは 10行以内・数字が入る・表はそのまま", lines.length <= 10 && /0\.435 → 0\.435/.test(s) && /表はそのまま/.test(s) && /変更なし/.test(s) && /家賃の安さ 40/.test(s) && /設備全般 5/.test(s) && !/（オートロック/.test(s) && /駅徒歩 6/.test(s) && /\$0\.0412/.test(s), s);
  const applied = deterministicWeeklySummary({ ...n, applied: true, gain: 0.015, changes: [{ family: "floor_plan", level: "stated", from: 1, to: 1.25, rounds: 34 }], worseBands: [{ band: "家賃", value: "7〜10万", gain: -0.004, n: 51 }], verdictFlips: { toPass: 1, toHold: 0 } });
  t("更新した週は表の変更・帯・通す／保留の行が出る", /表を更新した/.test(applied) && /間取り×stated ×1→×1\.25（34回）/.test(applied) && /悪くなる帯: 家賃=7〜10万 -0\.004（51回）/.test(applied) && /保留→通す 1/.test(applied));
  t("DeepSeek の前置きは決まり（10行・数字は渡された物だけ）", /10行以内/.test(SUMMARY_SYSTEM) && /数字は渡された物だけ/.test(SUMMARY_SYSTEM) && /【数字（決定論）】/.test(buildSummaryUser(n)));
  const long = Array.from({ length: 14 }, (_, i) => `行${i + 1} 数字は同じです。`).join("\n");
  t("返事は 10行・600字以内に切る・短すぎ／空は null", parseSummaryReply(long)!.split("\n").length === 10 && parseSummaryReply("") === null && parseSummaryReply("了解") === null && parseSummaryReply("```\n今週は変わらない。学べる条件が無い。\n次は材料を待つ。\n```")!.startsWith("今週は変わらない"));
}

console.log("■ 決定論と DeepSeek の強さを比べる・集計");
{
  const c = compareStrengthSources([
    { det: { rent: "stated", "equip:bath_toilet": "strong", walk: "none" }, llm: { rent: "stated", "equip:bath_toilet": "stated", walk: "stated" } },
    { det: { rent: "strong" }, llm: null },
    { det: null, llm: { rent: "strong" } },
  ]);
  t("両方ある人だけ・none 同士は数えない・一致とどちらが強いか", c.customers === 1 && c.compared === 3 && c.agree === 1 && c.detHigher === 1 && c.llmHigher === 1 && c.byFamily.rent.agree === 1, JSON.stringify(c));
  t("件数の多い順", JSON.stringify(topCounts([["rent", "walk"], ["rent"], ["size"]])) === JSON.stringify([["rent", 2], ["size", 1], ["walk", 1]]));
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
