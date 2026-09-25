// 資料の表の募集の条件（listing-terms.ts）を物件の判定（property-brain.ts）と売上サポの保存形（pickup-terms.ts）に組み込むテスト
// 実行: npx tsx app/lib/__tests__/pickup-terms.test.ts
// 資料の文字は 2026-09-25 の実物（property_pickups の1ページ目の文字層）の抜粋。お客様の名前・電話番号は無い
import { parseListingTerms } from "../listing-terms";
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, fillFactsFromTerms, applyEquipmentMatch, applyImageFacts, reasonPoints, reasonJa, BASE_SCORE, SCORE_MAX,
  type CustomerLike,
} from "../property-brain";
import { buildPickupTerms, formatTermsLine } from "../pickup-terms";
import { matchEquipment, parseEquipmentWants, parseListingEquipment } from "../listing-equipment";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ""}`); }
}
const TODAY = "2026-09-25";
const T = (s: string) => parseListingTerms(s, { today: TODAY });

// itandi（id 50: 礼1・築2008・居住中 11月上旬・普通2年・更新1ヶ月・外国籍可）
const IT50 = `仲介
エステムコート新⼤阪 Ⅵ エキスプレイス 405 号室
賃料 67,000 円 管理費‧共益費 なし
間取り 1K 専有⾯積 20.8 ㎡
敷⾦ / 礼⾦ / 保証⾦ なし / 1 ヶ⽉ / ー 敷引償却 ー
築年数 2008 年 6 ⽉ 物件種別 マンション
所在階 4 階 主要採光⾯ ⻄向き
現況 居住中 ⼊居可能時期 2026 年 11 ⽉上旬
契約期間 2 年間（普通借家） 解約予告 1 ヶ⽉前
保険加⼊ 加⼊要 2 年間 22,000 円 更新料 新賃料 1 ヶ⽉
設備
都市ガス , バス‧トイレ別 , 独⽴洗⾯台 , 室内洗濯機置場 , ペット相談 , 外国
籍可
備考
ー`;
// itandi（id 61: 敷礼なし・築2017・9月下旬・楽器不可・事務所使用不可・外国籍は敷金2ヶ月＝相談）
const IT61 = `賃料 58,000 円 管理費‧共益費 5,000 円
間取り 1K 専有⾯積 19.15 ㎡
敷⾦ / 礼⾦ / 保証⾦ なし / なし / ー 敷引償却 ー
築年数 2017 年 9 ⽉ 物件種別 マンション
所在階 3 階 主要採光⾯ 北向き
現況 ー ⼊居可能時期 2026 年 9 ⽉下旬
契約期間 2 年間（普通借家） 解約予告 2 ヶ⽉前
保険加⼊ 加⼊要 2 年間 20,000 円 更新料 新賃料 1 ヶ⽉
保証会社
要保証会社加⼊ , エポスカード ROOMiD ※ 外国籍の申込者様は敷⾦ 2 ヶ⽉。
設備
都市ガス , バス‧トイレ別 , 独⽴洗⾯台 , 室内洗濯機置場 , エアコン , オー
トロック , 事務所使⽤不可 , エレベーター
備考
‧更新料：新賃料の 1 ヶ⽉
分‧楽器不可‧掲載画像は反転⼜は類似物件写真の場合有`;
// itandi（id 60: 相談・単身限定・大手法人は礼金積み増し）
const IT60 = `賃料 58,000 円 管理費‧共益費 7,000 円
間取り 1K 専有⾯積 20.88 ㎡
敷⾦ / 礼⾦ / 保証⾦ なし / 1 ヶ⽉ / ー 敷引償却 ー
築年数 2008 年 6 ⽉ 物件種別 マンション
所在階 4 階 主要採光⾯ 南向き
現況 居住中 ⼊居可能時期 相談
契約期間 2 年間（普通借家） 解約予告 ー
保険加⼊ なし 更新料 1 ヶ⽉
設備
バス‧トイレ別 , 独⽴洗⾯台 , 宅配 BOX, 単⾝限定 , 保証⼈不要
備考
短期違約⾦あり ⼤⼿法⼈
契約の場合、礼⾦ 1 ヶ⽉積み増しとなります。`;
// itandi（id 59: 更新料「ー」・契約期間「ー」・二人入居可・外国籍可・入居時期「ー」）
const IT59 = `賃料 60,000 円 管理費‧共益費 なし
間取り 1K 専有⾯積 20.8 ㎡
敷⾦ / 礼⾦ / 保証⾦ なし / なし / なし 敷引償却 ー
築年数 2008 年 6 ⽉ 物件種別 マンション
現況 ー ⼊居可能時期 ー
契約期間 ー 解約予告 ー
保険加⼊ ー 更新料 ー
設備
バス‧トイレ別 , 独⽴洗⾯台 , ペット相談 , ⼆⼈
⼊居可 , 外国籍可 , 保証⼈不要 , 都市ガス
備考
ー`;
// リアプロの形（定期借家・フリーレント・即入）
const RP_FIXED = `物件種目 [住居用] マンション
物件名 テスト定借
号室名 305（3階部分）
間取タイプ 1K
専有面積 25.62㎡ 開口部方位 南
築年 2020年06月
現況/入居時期 空室 / 即入
賃料
70,000 円
共益費・管理費 8,000円
敷金 なし
礼金 1ヶ月
保証金 なし 償却・敷引 なし
更新料 なし
契約期間 定期借家 3年間
■フリーレント1ヶ月`;

const SUM = (name: string, extra = "") => `【1】${name}\n58,000円\n1K\n徒歩5分${extra ? `\n${extra}` : ""}\nAD 2ヶ月`;
const judge = (c: CustomerLike, text: string, summary = SUM("X"), eq?: ReturnType<typeof matchEquipment> | null) => {
  const profile = buildCustomerProfile(c, [], [], null, { today: TODAY });
  const facts = parsePropertyFacts(summary);
  const terms = T(text);
  const filled = fillFactsFromTerms(facts, terms);
  const j = judgeProperty(facts, profile, 0, { terms, today: TODAY, equipment: eq ?? null });
  return { j, filled, profile, terms };
};
const LOW: CustomerLike = { rent_max: 70_000, floor_plan: "1K", other_requests: "初期費用を抑えたい", created_at: "2026-09-10" };

console.log("■ 敷礼・築年は説明文に無い所だけ資料の表で埋める");
{
  const a = judge(LOW, IT61);
  t("説明文に敷礼なし＋資料が敷礼なし → ZERO_ZERO_MATCH（INITIAL_COST_UNKNOWN が消える）", a.j.reasonCodes.includes("ZERO_ZERO_MATCH") && !a.j.reasonCodes.includes("INITIAL_COST_UNKNOWN"), a.j.reasonCodes);
  t("埋めた項目 deposit・keyMoney・buildingAge", a.filled.join(",") === "deposit,keyMoney,buildingAge", a.filled);
  const b = judge(LOW, IT50);
  t("資料が礼1 → INITIAL_COST_NOT_ZERO（保留・外さない）", b.j.reasonCodes.includes("INITIAL_COST_NOT_ZERO") && b.j.verdict === "hold", { c: b.j.reasonCodes, v: b.j.verdict });
  const c = judge(LOW, IT61, SUM("X", "敷1ヶ月 礼1ヶ月"));
  t("説明文の値が先（説明文 敷1礼1・資料 敷礼なし → 敷礼あり）", c.j.reasonCodes.includes("INITIAL_COST_NOT_ZERO") && !c.filled.includes("deposit"), { c: c.j.reasonCodes, f: c.filled });
  const d = judge({ ...LOW, building_age: 15 }, IT50);
  // 2026-09-25: 築年の＋5年までは拡張の広げて検索の幅 → BUILDING_AGE_WIDE（+2・旧 少し超過 −3）
  t("築年を埋めて BUILDING_AGE_* の線のまま（築18年・希望15年 → 広げた検索の幅）", d.j.reasonCodes.includes("BUILDING_AGE_WIDE"), d.j.reasonCodes);
  const e = judge({ ...LOW, building_age: 15 }, IT50, SUM("X", "築3年"));
  t("説明文の築年が先（築3年 → OK）", e.j.reasonCodes.includes("BUILDING_AGE_OK"), e.j.reasonCodes);
}

console.log("■ 入居時期（希望日より 14日を超えて遅い時だけ LATE・相談/居住中は要確認・希望が決まっていなければ札なし）");
{
  const ok = judge({ ...LOW, move_in_time: "11月上旬" }, IT50);
  t("希望 11月上旬（11/10）× 資料 11月上旬（11/1）→ MOVE_IN_OK +5", ok.j.reasonCodes.includes("MOVE_IN_OK"), ok.j.reasonCodes);
  const late = judge({ ...LOW, move_in_time: "10月1日" }, IT50);
  t("希望 10/1 × 資料 11/1 → MOVE_IN_LATE（保留・外さない）", late.j.reasonCodes.includes("MOVE_IN_LATE") && late.j.flagCodes.includes("MOVE_IN_LATE") && late.j.verdict === "hold", { c: late.j.reasonCodes, v: late.j.verdict });
  const grace = judge({ ...LOW, move_in_time: "10月下旬" }, IT50);
  t("希望 10/31 × 資料 11/1（1日遅い）→ 猶予の内で OK", grace.j.reasonCodes.includes("MOVE_IN_OK"), grace.j.reasonCodes);
  const asap = judge({ ...LOW, move_in_time: "即入居" }, IT61);
  t("すぐ × 資料 9月下旬（9/21）→ OK", asap.j.reasonCodes.includes("MOVE_IN_OK"), asap.j.reasonCodes);
  const asapLate = judge({ ...LOW, move_in_time: "すぐにでも" }, IT50);
  t("すぐ × 資料 11月上旬 → LATE", asapLate.j.reasonCodes.includes("MOVE_IN_LATE"), asapLate.j.reasonCodes);
  const consult = judge({ ...LOW, move_in_time: "11月上旬" }, IT60);
  t("資料が相談（居住中）→ MOVE_IN_UNKNOWN 0点・保留にしない", consult.j.reasonCodes.includes("MOVE_IN_UNKNOWN") && !consult.j.flagCodes.includes("MOVE_IN_UNKNOWN"), consult.j.reasonCodes);
  const blank = judge({ ...LOW, move_in_time: "11月上旬" }, IT59);
  t("資料が「ー」→ MOVE_IN_UNKNOWN", blank.j.reasonCodes.includes("MOVE_IN_UNKNOWN"), blank.j.reasonCodes);
  for (const s of ["未定", "いつでも", "2ヶ月後くらい", "5月以降", ""]) {
    const n = judge({ ...LOW, move_in_time: s }, IT50);
    t(`希望「${s}」→ 入居時期の札なし`, !n.j.reasonCodes.some((c) => c.startsWith("MOVE_IN_")), n.j.reasonCodes);
  }
  const past = judge({ ...LOW, move_in_time: "7月", created_at: "2026-06-01" }, IT50);
  t("6月登録の「7月」（過ぎた日）→ 札なし", !past.j.reasonCodes.some((c) => c.startsWith("MOVE_IN_")), past.j.reasonCodes);
}

console.log("■ 契約・更新料・フリーレント");
{
  const f = judge({ rent_max: 80_000 }, RP_FIXED);
  t("定期借家 → CONTRACT_FIXED −5 保留（希望に語が無くても）", f.j.reasonCodes.includes("CONTRACT_FIXED") && f.j.verdict === "hold" && reasonPoints("CONTRACT_FIXED") === -5, f.j.reasonCodes);
  t("フリーレント（抑えたい希望なし）→ FREE_RENT 0点", f.j.reasonCodes.includes("FREE_RENT") && reasonPoints("FREE_RENT") === 0, f.j.reasonCodes);
  const fl = judge(LOW, RP_FIXED);
  t("フリーレント × 初期費用を抑えたい → FREE_RENT_MATCH +3", fl.j.reasonCodes.includes("FREE_RENT_MATCH") && reasonPoints("FREE_RENT_MATCH") === 3, fl.j.reasonCodes);
  const n = judge({ rent_max: 80_000 }, IT50);
  t("普通借家・更新料の語なし → 契約・更新料の札なし", !n.j.reasonCodes.some((c) => /^(CONTRACT|RENEWAL|FREE_RENT)/.test(c)), n.j.reasonCodes);
  const r = judge({ rent_max: 80_000, other_requests: "更新料なし", ng_points: "定期借家NG" }, IT50);
  t("更新料・定期借家の語あり × 更新1ヶ月・普通 → RENEWAL_FEE_SET・CONTRACT_NORMAL（0点）", r.j.reasonCodes.includes("RENEWAL_FEE_SET") && r.j.reasonCodes.includes("CONTRACT_NORMAL"), r.j.reasonCodes);
  const r2 = judge({ rent_max: 80_000, other_requests: "更新料なし、フリーレント", ng_points: "定期借家NG" }, IT59);
  t("更新料「ー」・契約「ー」・フリーレント記載なし → 要確認 0点", ["RENEWAL_FEE_UNKNOWN", "CONTRACT_UNKNOWN", "FREE_RENT_UNLISTED"].every((c) => r2.j.reasonCodes.includes(c)), r2.j.reasonCodes);
  const r3 = judge({ rent_max: 80_000, other_requests: "更新料なし" }, RP_FIXED);
  t("更新料なし → RENEWAL_FEE_NONE", r3.j.reasonCodes.includes("RENEWAL_FEE_NONE"), r3.j.reasonCodes);
}

console.log("■ 入居の条件（条件欄に語がある時だけ・不可は保留・相談/記載なしは 0点）");
{
  const c: CustomerLike = { rent_max: 80_000, preferences: "電子ピアノ（楽器可）", other_requests: "法人契約、外国籍可、事務所利用" };
  const a = judge(c, IT61);
  t("楽器不可 → CONDITION_INSTRUMENT_NG −10 保留", a.j.reasonCodes.includes("CONDITION_INSTRUMENT_NG") && a.j.verdict === "hold" && reasonPoints("CONDITION_INSTRUMENT_NG") === -10, a.j.reasonCodes);
  t("事務所使用不可 → CONDITION_OFFICE_NG", a.j.reasonCodes.includes("CONDITION_OFFICE_NG"), a.j.reasonCodes);
  t("外国籍の申込者は敷金2ヶ月 → CONDITION_FOREIGNER_ASK 0点", a.j.reasonCodes.includes("CONDITION_FOREIGNER_ASK") && reasonPoints("CONDITION_FOREIGNER_ASK") === 0, a.j.reasonCodes);
  t("法人の記載なし → CONDITION_CORPORATE_UNLISTED（要確認）", a.j.reasonCodes.includes("CONDITION_CORPORATE_UNLISTED") && reasonJa("CONDITION_CORPORATE_UNLISTED") === "要確認: 法人契約", a.j.reasonCodes);
  t("外さない（drop にしない）", a.j.verdict !== "drop");
  const b = judge(c, IT60);
  t("大手法人は礼金積み増し → CONDITION_CORPORATE_ASK", b.j.reasonCodes.includes("CONDITION_CORPORATE_ASK"), b.j.reasonCodes);
  const d = judge(c, IT50);
  t("外国籍可 → CONDITION_FOREIGNER_OK +3", d.j.reasonCodes.includes("CONDITION_FOREIGNER_OK") && reasonPoints("CONDITION_FOREIGNER_OK") === 3, d.j.reasonCodes);
  const none = judge({ rent_max: 80_000, other_requests: "楽器は使わない" }, IT61);
  t("「楽器は使わない」→ 楽器の札なし", !none.j.reasonCodes.some((x) => x.startsWith("CONDITION_INSTRUMENT")), none.j.reasonCodes);
  const plain = judge({ rent_max: 80_000 }, IT61);
  t("条件欄に語が無い → 入居の条件の札なし", !plain.j.reasonCodes.some((x) => x.startsWith("CONDITION_")), plain.j.reasonCodes);
}

console.log("■ 二人入居は設備の照合（two_person）と重ねない");
{
  const c: CustomerLike = { rent_max: 80_000, preferences: "二人入居可" };
  const wants = parseEquipmentWants(c);
  for (const [name, text] of [["IT59（二人入居可）", IT59], ["IT60（単身限定）", IT60], ["IT61（記載なし）", IT61]] as const) {
    const eq = matchEquipment(wants, parseListingEquipment(text));
    const j = judge(c, text, SUM("X"), eq).j;
    const fam = j.reasonCodes.filter((x) => /TWO_PERSON/.test(x));
    t(`${name}: 二人入居の札は1つだけ（${fam.join(",")}）`, fam.length === 1, j.reasonCodes);
  }
  // 設備の希望に拾われない言い方（カップル）は資料の表で照らす
  const cp: CustomerLike = { rent_max: 80_000, other_requests: "カップルで入居" };
  const eq2 = matchEquipment(parseEquipmentWants(cp), parseListingEquipment(IT60));
  const j2 = judge(cp, IT60, SUM("X"), eq2).j;
  t("「カップル」× 単身限定 → CONDITION_TWO_PERSON_NG（保留）", j2.reasonCodes.includes("CONDITION_TWO_PERSON_NG") && j2.verdict === "hold", j2.reasonCodes);
}

console.log("■ 50＋合計＝score（募集の条件の札込み・画像・設備の付け直しも）");
{
  const custs: CustomerLike[] = [
    { ...LOW, move_in_time: "10月1日", preferences: "電子ピアノ（楽器可）・二人入居可", other_requests: "法人契約、外国籍可、初期費用を抑えたい、更新料なし、フリーレント", ng_points: "定期借家NG", building_age: 10 },
    { rent_max: 60_000, move_in_time: "即入居", other_requests: "カップル、学生、子供あり" },
    { rent_max: 90_000, move_in_time: "未定" },
  ];
  const bad: unknown[] = [];
  for (const c of custs) for (const text of [IT50, IT61, IT60, IT59, RP_FIXED]) for (const s of [SUM("X"), SUM("Y", "敷なし 礼なし\n築30年")]) {
    const eq = matchEquipment(parseEquipmentWants(c), parseListingEquipment(text));
    const { j } = judge(c, text, s, eq);
    const raw = BASE_SCORE + j.reasonCodes.reduce((a, x) => a + reasonPoints(x), 0);
    let exp = Math.max(0, Math.min(SCORE_MAX, raw));
    if (j.reasonCodes.includes("EQUIP_MUST_NG_CAP")) exp = Math.min(exp, 20);
    if (exp !== j.score) bad.push({ codes: j.reasonCodes, raw, score: j.score });
    if (j.verdict === "drop") bad.push({ drop: j.reasonCodes });
    const re = applyEquipmentMatch(j, eq);
    const raw2 = Math.max(0, Math.min(SCORE_MAX, BASE_SCORE + re.reasonCodes.reduce((a, x) => a + reasonPoints(x), 0)));
    if (!re.reasonCodes.includes("EQUIP_MUST_NG_CAP") && raw2 !== re.score) bad.push({ re: re.reasonCodes, raw2, score: re.score });
    if (re.reasonCodes.filter((x) => /TWO_PERSON/.test(x)).length > 1) bad.push({ twoDup: re.reasonCodes });
    const img = applyImageFacts({ ...j, imageChecks: ["storage"] }, { storage: true });
    if (img.verdict !== j.verdict && j.verdict !== "pass") bad.push({ img: img.verdict, was: j.verdict });
  }
  t("全部で 50＋合計＝score・drop なし・二人入居の札は1つ", bad.length === 0, bad.slice(0, 3));
}

console.log("■ 資料の表を渡さない経路（拡張の judge API）は今まで通り");
{
  const profile = buildCustomerProfile({ ...LOW, move_in_time: "10月1日", other_requests: "楽器可、初期費用を抑えたい、更新料なし" }, [], [], null, { today: TODAY });
  const j = judgeProperty(parsePropertyFacts(SUM("X")), profile, 0);
  t("terms なし → MOVE_IN・CONTRACT・RENEWAL・FREE_RENT・CONDITION の札なし", !j.reasonCodes.some((c) => /^(MOVE_IN|CONTRACT|RENEWAL|FREE_RENT|CONDITION)_/.test(c)), j.reasonCodes);
}

console.log("■ 保存の形と画面の1行");
{
  const { profile, terms } = judge({ ...LOW, move_in_time: "10月1日", other_requests: "外国籍可、楽器可" }, IT50);
  const p = buildPickupTerms(terms, profile, { today: TODAY, filled: ["deposit"] });
  t("1行「💴 敷0/礼1ヶ月 築18年 入居:11月上旬 普通2年 更新1ヶ月」", p.line === "💴 敷0/礼1ヶ月 築18年 入居:11月上旬 普通2年 更新1ヶ月", p.line);
  t("入居時期の照合 late（希望 10/1まで）", p.want.moveIn?.result === "late" && p.want.moveIn?.label === "10/1まで", p.want.moveIn);
  t("条件の照合（外国籍 ok・楽器 unlisted）", JSON.stringify(p.want.conditions.map((c) => `${c.key}:${c.status}`)) === JSON.stringify(["instrument:unlisted", "foreigner:ok"]), p.want.conditions);
  t("記載のあった条件だけ保存（foreigner）", Object.keys(p.conditions).join(",") === "foreigner", p.conditions);
  t("filled を残す", p.filled.join(",") === "deposit");
  const f = buildPickupTerms(T(RP_FIXED), null, { today: TODAY });
  t("定期借家・更新料なし・フリーレント・即入居の1行", f.line === "💴 敷0/礼1ヶ月 築6年 入居:即入居 定期借家3年 更新料なし フリーレント1ヶ月", f.line);
  t("お客様が無い時は照合なし", f.want.moveIn === null && f.want.conditions.length === 0);
  t("書いていない項目は出さない（空の資料 → 空）", formatTermsLine(buildPickupTerms(T(""), null)) === "");
  const u = buildPickupTerms(T(IT59), null, { today: TODAY });
  t("「ー」ばかりの資料 → 敷礼と築年だけ", u.line === "💴 敷0/礼0 築18年", u.line);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
