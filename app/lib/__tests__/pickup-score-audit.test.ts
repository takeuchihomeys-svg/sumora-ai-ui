// 売上サポの点数の監査（2026-09-25 任務A の誤り E1〜E4・任務B の強化）のテスト
// 実行: npx tsx app/lib/__tests__/pickup-score-audit.test.ts
// 形は property_pickups id 1〜3・50〜67 の資料の文字層と、スタッフが送った🌟の実データから（お客様の名前・電話番号は無い）
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, detectImageWants, reasonPoints, reasonJa, splitBuildingRoom,
  BASE_SCORE, SCORE_MAX, REASON_POINTS, DROP_REASON_CODES, HOLD_REASON_CODES,
  type CustomerLike, type Judgment,
} from "../property-brain";
import { parseAdFromText } from "../property-pickups";
import { parseEquipmentWants, parseListingEquipment, matchEquipment, conditionalFloorOf } from "../listing-equipment";
import { compareMoveIn, vacateNextDay, type MoveIn } from "../listing-terms";
import { buildRankPrompt, rankMaterialLine, RANK_PROMPT_PREFIX, buildRankConditions } from "../pickup-rank";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}
const sum50 = (j: Judgment) => Math.max(0, Math.min(SCORE_MAX, BASE_SCORE + j.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0)));
const all: Judgment[] = [];
const J = (s: string, c: CustomerLike, sent: Parameters<typeof buildCustomerProfile>[1] = []) => { const j = judgeProperty(parsePropertyFacts(s), buildCustomerProfile(c, sent)); all.push(j); return j; };

console.log("■ E1 リアプロの元付資料の「A D」（A と D の間に空白）");
{
  // 実物（id 1・3・2 の2ページ目の文字層）
  t("「A D 250%(税込)(条件あり…)」→ 2.5ヶ月", parseAdFromText("A D 250%(税込)(条件あり 振込手数料は差し引かせて頂きます。)").adMonths === 2.5);
  t("「A D 10000円」→ 10,000円", parseAdFromText("A D 10000円").adYen === 10_000);
  t("「A D 2ヶ月(税込)」→ 2ヶ月", parseAdFromText("A D 2ヶ月(税込)").adMonths === 2);
  t("「A D 1.5ヶ月(税込)」→ 1.5ヶ月", parseAdFromText("A D 1.5ヶ月(税込)").adMonths === 1.5);
  t("「A D 171,600円」→ 171,600円", parseAdFromText("A D 171,600円").adYen === 171_600);
  t("全角「ＡＤ　２ヶ月」→ 2ヶ月", parseAdFromText("ＡＤ　２ヶ月").adMonths === 2);
  t("itandi「広告費 100 %」→ 1ヶ月", parseAdFromText("広告費 100 %\n広告掲載 可").adMonths === 1);
  t("itandi「広告費 1 ヶ月 ( 内税 )」→ 1ヶ月", parseAdFromText("広告費 1 ヶ月 ( 内税 )\n広告掲載 可").adMonths === 1);
  t("「広告掲載 可」だけは AD ではない", parseAdFromText("広告掲載 可").adMonths == null && parseAdFromText("広告掲載 可").adYen == null);
  t("英単語の中の AD（「LOADING 2ヶ月」）は読まない", parseAdFromText("LOADING 2ヶ月").adMonths == null);
}

console.log("■ E2 「広告費 なし」は AD 0（不明と分ける）・AD 0.5ヶ月より下に並ぶ");
{
  t("「広告費 なし」→ adMonths 0", parseAdFromText("広告費 なし\n広告掲載 可").adMonths === 0);
  t("「AD なし」の行を説明文から 0 と読む", parsePropertyFacts("【8】X\n66,000円\n1K\nAD なし").adMonths === 0);
  t("AD の行が無い説明文は null（不明のまま）", parsePropertyFacts("【8】X\n66,000円\n1K").adMonths == null);
  const c: CustomerLike = { rent_max: 70_000 };
  const none = J("【8】X\n66,000円\n1K\nAD なし", c);
  const half = J("【11】Y\n66,000円\n1K\nAD 0.5ヶ月", c);
  const unk = J("【9】Z\n66,000円\n1K", c);
  t("AD なし → AD_NONE と PROFIT_NEGATIVE", none.reasonCodes.includes("AD_NONE") && none.reasonCodes.includes("PROFIT_NEGATIVE"), none.reasonCodes);
  t("AD なし（旧は不明と同じ）は AD 0.5ヶ月より下", none.score < half.score, [none.score, half.score]);
  t("AD 不明は今まで通り減点しない（AD_UNKNOWN 0）", unk.reasonCodes.includes("AD_UNKNOWN") && !unk.reasonCodes.includes("AD_NONE"), unk.reasonCodes);
  t("AD なしは外す候補にしない", none.verdict !== "drop");
}

console.log("■ E3 「2階以上はエレベーター必須」は階の希望ではない（id 2・1階の部屋が🌟★なのに上限20点だった）");
{
  const pref = "エアコン付き(リビングに最低1台)、2階以上はエレベーター必須、トイレ風呂別、独立洗面台";
  const w = parseEquipmentWants({ preferences: pref });
  t("2階以上（floor2）の希望を作らない", !w.wants.some((x) => x.key === "floor2" || x.key === "floor"), w.wants.map((x) => x.key));
  const ev = w.wants.find((x) => x.key === "elevator");
  t("エレベーターは必須・2階以上の時だけ", !!ev && ev.strong && ev.ifFloorAtLeast === 2, ev);
  t("conditionalFloorOf: 「2階以上はエレベーター必須」→ 2", conditionalFloorOf("2階以上はエレベーター必須") === 2);
  t("conditionalFloorOf: 「2階以上は必須」→ null（階の希望）", conditionalFloorOf("2階以上は必須") == null);
  t("「2階以上必須」は今まで通り階の希望", parseEquipmentWants({ preferences: "2階以上必須" }).wants.some((x) => x.key === "floor2"));
  const ground = parseListingEquipment("仲介\nY 104 号室\n構造 鉄筋コンクリート 階建 / 総戸数 5 階建 / ー\n所在階 1 階 主要採光面 南向き\n設備\nバス・トイレ別 , 独立洗面台\n備考\nー");
  const upper = parseListingEquipment("仲介\nX 405 号室\n構造 鉄筋コンクリート 階建 / 総戸数 5 階建 / ー\n所在階 4 階 主要採光面 南向き\n設備\nバス・トイレ別 , 独立洗面台 , エレベーター\n備考\nー");
  const upperNoEv = parseListingEquipment("仲介\nX 405 号室\n構造 鉄筋コンクリート 階建 / 総戸数 5 階建 / ー\n所在階 4 階 主要採光面 南向き\n設備\nバス・トイレ別 , 独立洗面台\n備考\nー");
  const mg = matchEquipment(w, ground);
  t("1階の部屋にはエレベーターの行を出さない・必須の×にしない", !mg.rows.some((r) => r.want.key === "elevator") && !mg.strongNg, mg.rows.map((r) => r.label));
  const mu = matchEquipment(w, upper);
  const evRow = mu.rows.find((r) => r.want.key === "elevator");
  t("4階の部屋ではエレベーターを照らす（○）", evRow?.result === "ok", mu.rows.map((r) => `${r.label}${r.mark}`));
  t("画面の名前は「エレベーター（2階以上の時）」", evRow?.label === "エレベーター（2階以上の時）", evRow?.label);
  const mn = matchEquipment(w, upperNoEv);
  t("4階の部屋で記載なしは要確認（－）", mn.rows.find((r) => r.want.key === "elevator")?.result === "unlisted");
  // 階の分からない資料は照らす（外さない・読めない時に希望を消さない）
  const noFloor = { ...upperNoEv, floor: null };
  t("階が分からない時はエレベーターの行を残す", matchEquipment(w, noFloor).rows.some((r) => r.want.key === "elevator"));
  t("画像で確かめる希望に「2階以上」を入れない", !detectImageWants({ preferences: pref }).includes("floor_2_plus"), detectImageWants({ preferences: pref }));
  t("「2階以上希望」は今まで通り画像の希望", detectImageWants({ preferences: "2階以上希望" }).includes("floor_2_plus"));
}

console.log("■ E4 「退去予定(10/31)/相談」は退去日の翌日より前には入れない");
{
  const mi: MoveIn = { kind: "consult", current: "leaving", vacateMonthDay: "10-31", raw: "退去予定(10/31)/相談" };
  t("退去日の翌日は 2026-11-01（基準 9/24）", vacateNextDay(mi, { today: "2026-09-24T01:51:00Z" }) === "2026-11-01");
  t("希望 10/1 まで → 遅い（late）", compareMoveIn(mi, "2026-10-01", { today: "2026-09-24T01:51:00Z" }) === "late");
  t("希望 11/10 まで → 要確認のまま（相談なので ok にしない）", compareMoveIn(mi, "2026-11-10", { today: "2026-09-24T01:51:00Z" }) === "unknown");
  t("退去日の無い相談は要確認", compareMoveIn({ kind: "consult", current: null, raw: "相談" }, "2026-10-01", { today: "2026-09-24" }) === "unknown");
  t("年をまたぐ（基準 12月・退去 1/15）→ 翌年", vacateNextDay({ kind: "consult", current: "leaving", vacateMonthDay: "01-15", raw: "" }, { today: "2026-12-10" }) === "2027-01-16");
}

console.log("■ B1 送付済みは号室で見る（同じ建物の別の部屋は外す候補にしない）");
{
  const c: CustomerLike = { rent_max: 90_000, floor_plan: "1LDK" };
  const sent = [{ property_name: "グランコート", room_no: "101", delivery: "customer" }];
  const other = J("【1】グランコート 102号室\n80,000円\n1LDK", c, sent);
  const same = J("【2】グランコート 101号室\n80,000円\n1LDK", c, sent);
  const starSame = J("【2🌟★】グランコート 0101号室\n80,000円\n1LDK", c, sent);
  const noRoom = J("【3】グランコート\n80,000円\n1LDK", c, sent);
  t("別の部屋 → ALREADY_SENT_OTHER_ROOM（−3・外す候補にしない）", other.reasonCodes.includes("ALREADY_SENT_OTHER_ROOM") && !other.reasonCodes.includes("ALREADY_SENT") && other.verdict !== "drop", other.reasonCodes);
  // 旧は「グランコート 101号室」と送付の「グランコート」が名前で合わず当たらなかった → 号室で当たるようにしたが、外す候補は増やさず保留
  t("同じ部屋（号室で初めて当たる）→ 保留 ALREADY_SENT_SAME_ROOM（外す候補を増やさない）", same.verdict === "hold" && same.reasonCodes.includes("ALREADY_SENT_SAME_ROOM"), same.reasonCodes);
  t("🌟★付きの説明文・0101 の表記ゆれでも同じ部屋に当たる", starSame.reasonCodes.includes("ALREADY_SENT_SAME_ROOM"), starSame.reasonCodes);
  const nameSame = J("【2】グランコート 101号室\n80,000円\n1LDK", c, [{ property_name: "グランコート 101号室", delivery: "customer" }]);
  t("送付の名前も号室付きで一致（旧でも当たる形）→ 今まで通り外す候補", nameSame.verdict === "drop" && nameSame.reasonCodes.includes("ALREADY_SENT"), nameSame.reasonCodes);
  t("号室が分からない候補は今まで通り（名前が一致すれば外す候補）", noRoom.verdict === "drop", noRoom.reasonCodes);
  t("splitBuildingRoom「【1🌟】セレニティ照ヶ丘矢田A棟 303号室」", JSON.stringify(splitBuildingRoom("【1🌟】セレニティ照ヶ丘矢田A棟 303号室")) === JSON.stringify({ building: "セレニティ照ヶ丘矢田A棟", room: "303" }));
  t("号室の無い送付（旧データ）と号室付きの候補 → 外す候補にしない（旧も当たらなかった）", J("【4】コーポ北 205号室\n80,000円\n1LDK", c, [{ property_name: "コーポ北", delivery: "customer" }]).verdict !== "drop");
  t("グループ共有だけの行は送付済みにしない（今まで通り）", !J("【5】グランコート 101号室\n80,000円\n1LDK", c, [{ property_name: "グランコート", room_no: "101", delivery: "shared" }]).reasonCodes.some((x) => x.startsWith("ALREADY_SENT")));
}

console.log("■ B2 間取りの帯（2DK↔1LDK は同じ級・希望より広いは加点・狭いは今まで通り）");
{
  const c1: CustomerLike = { rent_max: 90_000, floor_plan: "1LDK" };
  const dk2 = J("【1】A\n80,000円\n2DK", c1);
  const ldk2 = J("【2】B\n80,000円\n2LDK", c1);
  t("1LDK 希望に 2DK → FLOOR_PLAN_SAME_CLASS +8・保留にしない", dk2.reasonCodes.includes("FLOOR_PLAN_SAME_CLASS") && dk2.verdict === "pass", dk2.reasonCodes);
  t("1LDK 希望に 2LDK → FLOOR_PLAN_LARGER +5・保留にしない", ldk2.reasonCodes.includes("FLOOR_PLAN_LARGER") && ldk2.verdict === "pass", ldk2.reasonCodes);
  const small = J("【3】C\n80,000円\n1LDK", { rent_max: 90_000, floor_plan: "2LDK" });
  t("2LDK 希望に 1LDK（狭い）→ 今まで通り不一致の保留", small.reasonCodes.includes("FLOOR_PLAN_MISMATCH") && small.verdict === "hold", small.reasonCodes);
  const k2 = J("【4】D\n80,000円\n1LDK", { rent_max: 90_000, floor_plan: "2K" });
  t("2K 希望に 1LDK（1人に偏った形）は入れない＝不一致のまま", k2.reasonCodes.includes("FLOOR_PLAN_MISMATCH"), k2.reasonCodes);
  const capped = J("【5】E\n80,000円\n3LDK", { rent_max: 90_000, floor_plan: "1DK〜2K" });
  t("上限を書いた希望（1DK〜2K）に 3LDK → 広い加点にしない", !capped.reasonCodes.includes("FLOOR_PLAN_LARGER"), capped.reasonCodes);
  const dk1 = J("【6】F\n80,000円\n1DK", c1);
  t("本命（1LDK）> 同じ級（2DK）= 広げた型（1DK）> 広い（2LDK）の順", REASON_POINTS.FLOOR_PLAN_MATCH > REASON_POINTS.FLOOR_PLAN_SAME_CLASS && REASON_POINTS.FLOOR_PLAN_SAME_CLASS >= REASON_POINTS.FLOOR_PLAN_WIDE && REASON_POINTS.FLOOR_PLAN_WIDE > REASON_POINTS.FLOOR_PLAN_LARGER, dk1.reasonCodes);
}

console.log("■ B3 家賃の超過は金額の線も持つ（予算が低いお客様ほど厳しくならない）");
{
  const low: CustomerLike = { rent_max: 50_000 };
  const code = (s: string, c: CustomerLike) => J(`【1】X\n${s}\n1K`, c).reasonCodes.find((x) => x.startsWith("RENT_"));
  t("上限5万に 60,000円（1.2倍・＋1万円）→ RENT_SLIGHTLY_OVER（保留にしない）", code("60,000円", low) === "RENT_SLIGHTLY_OVER");
  t("上限5万に 68,000円（1.36倍・＋1.8万円）→ 保留（外す候補にしない）", code("68,000円", low) === "RENT_OVER_110");
  t("上限5万に 73,000円（＋2.3万円）→ 外す候補", code("73,000円", low) === "RENT_OVER_130");
  t("上限10万に 125,000円（1.25倍・＋2.5万円）→ 保留", code("125,000円", { rent_max: 100_000 }) === "RENT_OVER_110");
  t("上限7万に 105,000円（管理費込み・＋3.5万円）→ 外す候補（今まで通り）", code("95,000円 10,000円", { rent_max: 70_000 }) === "RENT_OVER_130");
}

console.log("■ B4 AD は月数だけでも点を付ける（家賃が読めない候補プールの形）");
{
  const j = J("【1】X\n1LDK\nAD 2ヶ月", { rent_max: 90_000, floor_plan: "1LDK" });
  t("家賃なし・AD 2ヶ月 → AD_HIGH（AD_UNKNOWN にしない）", j.reasonCodes.includes("AD_HIGH") && !j.reasonCodes.includes("AD_UNKNOWN"), j.reasonCodes);
  t("家賃なしの時は利益の札（まかなえる／利益が出ない）を付けない", !j.reasonCodes.includes("AD_COVERS_DISCOUNT") && !j.reasonCodes.includes("PROFIT_NEGATIVE") && j.profitYen == null, j.reasonCodes);
  const j1 = J("【2】Y\n1LDK\nAD 1ヶ月", { rent_max: 90_000, floor_plan: "1LDK" });
  t("家賃なし・AD 1ヶ月 → AD_1M", j1.reasonCodes.includes("AD_1M"), j1.reasonCodes);
  const j3 = J("【3】Z\n60,000円\n1LDK\nAD 3ヶ月", { rent_max: 90_000, floor_plan: "1LDK" });
  t("家賃ありは今まで通り（まかなえる＋2ヶ月以上＋3ヶ月以上）", ["AD_COVERS_DISCOUNT", "AD_HIGH", "AD_VERY_HIGH"].every((c) => j3.reasonCodes.includes(c)), j3.reasonCodes);
}

console.log("■ 新しい札の点の表・日本語・50＋合計＝score");
{
  const NEW = ["ALREADY_SENT_OTHER_ROOM", "FLOOR_PLAN_SAME_CLASS", "FLOOR_PLAN_LARGER", "AD_NONE"];
  t("新しい札は全部 点の表と日本語がある", [...NEW, "ALREADY_SENT_SAME_ROOM"].every((c) => c in REASON_POINTS && reasonJa(c) !== c));
  t("新しい札は外す候補・保留のコードに入れない", NEW.every((c) => !DROP_REASON_CODES.has(c) && !HOLD_REASON_CODES.has(c)));
  t("同じ部屋（号室で当たる）は保留で外す候補ではない", HOLD_REASON_CODES.has("ALREADY_SENT_SAME_ROOM") && !DROP_REASON_CODES.has("ALREADY_SENT_SAME_ROOM"));
  const bad = all.filter((j) => !j.reasonCodes.includes("EQUIP_MUST_NG_CAP") && sum50(j) !== j.score);
  t(`全ての判定で 50＋札の点の合計＝score（${all.length}件）`, bad.length === 0, bad.map((j) => [j.name, j.score, j.reasonCodes]));
}

console.log("■ 🌟 の順位付け: 固定の前置きが先頭（キャッシュ）・資料の行・家賃は安さで選ばない");
{
  const p1 = buildRankPrompt(["【1】A\n70,000円\n1K"], "家賃〜8万円 / 1K");
  const p2 = buildRankPrompt(["【1】B\n60,000円\n1LDK", "【2】C\n65,000円\n1LDK"], "家賃〜7万円 / 1LDK / 敷礼なるべく0", ["敷なし・礼なし ／ 築2年 ／ 設備: オートロック", null]);
  t("お客様・物件が違っても先頭は同じ固定の前置き", p1.startsWith(RANK_PROMPT_PREFIX) && p2.startsWith(RANK_PROMPT_PREFIX));
  t("お客様の条件は前置きの後ろ", p2.indexOf("【お客様の希望条件") > RANK_PROMPT_PREFIX.length);
  t("資料の行は該当の物件の下にだけ付く", /【1】B[\s\S]*資料: 敷なし・礼なし[\s\S]*【2】C/.test(p2) && (p2.match(/資料: /g) ?? []).length === 1);
  t("「㎡あたりの家賃（安いほど良い）」を使わない", !/安いほど良い/.test(RANK_PROMPT_PREFIX));
  t("スタッフの訴求（敷金礼金0・築浅・駅近・独立洗面台）が入る", ["敷金礼金0", "築浅", "駅近", "独立洗面台", "2DK と 1LDK"].every((w) => RANK_PROMPT_PREFIX.includes(w)));
  const line = rankMaterialLine({ hasText: true, depositMonths: 0, keyMoneyMonths: 1, buildingAgeYears: 2, newBuild: false, moveIn: { kind: "date", date: "2026-11", part: "上旬" } }, ["オートロック", "独立洗面台"]);
  t("資料の行「敷なし・礼1ヶ月 ／ 築2年 ／ 入居11月上旬〜 ／ 設備: …」", line === "敷なし・礼1ヶ月 ／ 築2年 ／ 入居11月上旬〜 ／ 設備: オートロック・独立洗面台", line);
  t("退去予定日があれば出す（E4）", (rankMaterialLine({ hasText: true, depositMonths: 0, keyMoneyMonths: 0, buildingAgeYears: 1, newBuild: false, moveIn: { kind: "consult", vacateMonthDay: "10-31" } }, []) ?? "").includes("退去予定10/31"));
  t("文字の無い資料は行を作らない", rankMaterialLine({ hasText: false, depositMonths: null, keyMoneyMonths: null, buildingAgeYears: null, newBuild: false, moveIn: { kind: "unknown" } }, []) == null);
}

console.log("■ 反証レビュー: 番号の印・階の希望・年をまたぐ退去日");
{
  t("【1🌟★】は番号として読む", parsePropertyFacts("【1🌟★】X 303号室\n70,000円\n1K").rank === 1);
  t("【2024年築】は番号の印ではない（名前を削らない）", parsePropertyFacts("【2024年築】X\n70,000円\n1K").name.startsWith("【2024年築】"));
  const w = (s: string) => detectImageWants({ preferences: s } as CustomerLike).includes("floor_2_plus");
  t("「2階以上は必須」は階の希望（floor_2_plus）", w("2階以上は必須"));
  t("「2階以上は希望」は階の希望", w("2階以上は希望"));
  t("「2階以上はエレベーター必須」は階の希望ではない", !w("2階以上はエレベーター必須"));
  t("「1階NG、2階以上ならエレベーター」は 1階NG で階の希望", w("1階NG、2階以上ならエレベーター"));
  t("1月の基準で「退去予定(12/31)」は去年（翌日 1/1）", vacateNextDay({ kind: "consult", vacateMonthDay: "12-31" } as MoveIn, { today: "2027-01-10" }) === "2027-01-01");
  t("1月の基準で去年12月退去は入居が遅いにしない", compareMoveIn({ kind: "consult", vacateMonthDay: "12-31" } as MoveIn, "2027-02-01", { today: "2027-01-10" }) !== "late");
}

// 2026-09-25 YUMA テスト: 🌟 に渡る条件の文。拡張の文は家賃を万で丸め（7.5万→「予算8万円以内」）設備・入居時期が入らない → DB の条件の要約を正に
{
  const ext = "予算8万円以内・1K希望・徒歩5分以内・築3年以内・25㎡以上・エリア:大国町";
  const line = "家賃 7.5万まで｜間取り 1K｜広さ 25㎡以上｜エリア 大国町｜徒歩 5分以内｜築年 3年以内｜入居 10月中旬まで｜設備 角部屋";
  t("🌟の条件: 要約があれば要約（丸めた拡張の文は使わない）", buildRankConditions(ext, { summaryLine: line }) === line);
  t("🌟の条件: 要約が無ければ拡張の文のまま", buildRankConditions(ext, null) === ext && buildRankConditions(ext, { summaryLine: "" }) === ext);
  t("🌟の条件: 初期費用を抑えたい方は一言足す", (buildRankConditions(ext, { summaryLine: "家賃 5万〜6.2万｜間取り 1K", lowInitialCost: true }) ?? "").endsWith("初期費用を抑えたい（敷金・礼金0の物件を優先）"));
  t("🌟の条件: どちらも無ければ null", buildRankConditions(null, null) === null);
  t("🌟の条件: 固定の前置きより後ろに入る（キャッシュを割らない）", buildRankPrompt(["【1】A", "【2】B"], buildRankConditions(ext, { summaryLine: line })).startsWith(RANK_PROMPT_PREFIX));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
