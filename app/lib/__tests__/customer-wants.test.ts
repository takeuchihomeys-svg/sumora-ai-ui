// app/lib/__tests__/customer-wants.test.ts
// お客様の要望を項目（設備／NG／その他）にする純関数（customer-wants.ts）と、リビングの帖数の札（LDK_JO_*）のテスト。
// 実行: npx tsx app/lib/__tests__/customer-wants.test.ts
//
// 2026-09-29 竹内「拡張の検索条件には入らないけど加点条件として、その他の項目で1つ1つまとめる（ガスコンロ・カウンターキッチン・
//   リビング○帖以上・初期費用○円以内 等）…設備系は設備のところにまとめる。抜けがないように」
// 文は property_customers の条件欄の実物（2026-09-29・直近180日）そのまま。お客様の名前・電話は入れていない
import { itemizeWants, routeConditionText, routeChanges, kindOfClause, splitWantText, additionalHopes, formOtherWants, initialCostLimitFromText, AUDIT_WANT_WORDS } from "../customer-wants";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, ldkJoFromText, ldkJoCodes, fitVerdictOf, reasonJa, HOLD_REASON_CODES, REASON_POINTS, detectWantsLowInitialCost, type CustomerLike } from "../property-brain";
import { extractImageWants, dedupeWantsByTopic, imageAnalysisNeed } from "../image-wants";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}
const labels = (c: Record<string, unknown>) => itemizeWants(c as never).map((w) => `${w.kind}:${w.label}`);
const byKey = (c: Record<string, unknown>, key: string) => itemizeWants(c as never).find((w) => w.key === key);

console.log("■ 設備の項目（listing-equipment の読み取りを正にする）");
{
  const c = { other_requests: "同棲するため。猫飼育可。保証人無し可能。できれば収納多め。木造以外。" };
  const l = labels(c);
  t("同棲→二人入居可（設備）", l.includes("設備:二人入居可"), l);
  t("猫飼育可→ペット（設備・検索に入る）", byKey(c, "equip:pet")?.search === true, l);
  t("保証人無し可能→保証人不要（設備）", l.includes("設備:保証人不要"), l);
  t("木造以外→木造NG（NG・構造は検索に入る）", byKey(c, "equip:structure")?.kind === "NG" && byKey(c, "equip:structure")?.search === true, l);
  const st = byKey(c, "free:できれば収納多め");
  t("できれば収納多め→その他（画像で分析が足す・画像で確かめる・できれば）", !!st && st.kind === "その他" && st.scoring === "IMAGE_STORAGE（画像で分析）" && st.image && st.soft, st);
}
{
  const c = { other_requests: "築浅、近くにレンタカー、白貴重、オートロック" };
  const l = labels(c);
  t("オートロック→設備", l.includes("設備:オートロック"), l);
  t("築浅→その他（築年の文の札 BUILDING_AGE_TEXT）", byKey(c, "other:age_text")?.scoring === "BUILDING_AGE_TEXT", l);
  t("近くにレンタカー・白貴重→その他（採点外）", byKey(c, "free:近くにレンタカー")?.scoring === null && byKey(c, "free:白貴重")?.scoring === null, l);
}
{
  const c = { preferences: "カウンターキッチン" };
  const w = byKey(c, "equip:counter_kitchen");
  t("カウンターキッチン→設備 対面キッチン（EQUIP_COUNTER_KITCHEN・画像で確かめる）", w?.kind === "設備" && w.scoring === "EQUIP_COUNTER_KITCHEN" && w.image === true, w);
}
{
  const c = { ng_points: "1階、木造、ロフト", preferences: "オートロック[必須]・独立洗面・7畳以上の部屋" };
  const l = labels(c);
  t("NG欄の 1階→NG「1階 → 2階以上」", l.includes("NG:1階 → 2階以上"), l);
  t("NG欄の ロフト→NG ロフトNG（EQUIP_LOFT_NOT）", byKey(c, "equip:loft:ng")?.scoring === "EQUIP_LOFT_NOT", l);
  t("オートロック[必須]→必須", byKey(c, "equip:autolock")?.strong === true, l);
  t("7畳以上の部屋→その他 洋室7帖以上（ROOM_JO・画像）", byKey(c, "other:room_jo")?.label === "洋室7帖以上" && byKey(c, "other:room_jo")?.image === true, l);
  t("並びは 設備 → NG → その他", l.findIndex((x) => x.startsWith("NG:")) > l.findIndex((x) => x.startsWith("設備:")) && l.findIndex((x) => x.startsWith("その他:")) > l.findIndex((x) => x.startsWith("NG:")), l);
}

console.log("■ その他の項目（決定論）");
{
  const c = { preferences: "バストイレ別", other_requests: "ガスコンロ、カウンターキッチン、リビング8帖以上、初期費用15万円以内、収納多め", floor_plan: "1K、1LDK" };
  const l = labels(c);
  t("YUMA の要望: ガスコンロ・カウンターキッチンが設備", l.includes("設備:ガスコンロ") && l.includes("設備:対面キッチン"), l);
  t("リビング8帖以上→その他（LDK_JO・画像で確かめる）", byKey(c, "other:ldk_jo")?.scoring === "LDK_JO" && byKey(c, "other:ldk_jo")?.image === true, l);
  const ic = byKey(c, "other:initial_cost_text");
  t("初期費用15万円以内（列が空）→その他・採点外（列 initial_cost_limit に入っていない事が見える）", ic?.label === "初期費用15万円以内" && ic.scoring === null, ic);
  t("収納多め→その他（画像）", byKey(c, "free:収納多め")?.image === true, l);
  t("バス・トイレ別は1つ（重複しない）", l.filter((x) => x.includes("バス・トイレ別")).length === 1, l);
  const c2 = { ...c, initial_cost_limit: 150000 };
  t("列に 15万円が入れば 初期費用15万円以内（INITIAL_COST）", byKey(c2, "other:initial_cost_limit")?.scoring === "INITIAL_COST" && byKey(c2, "other:initial_cost_text")?.scoring === "INITIAL_COST", labels(c2));
}
{
  const c = { other_requests: "初期費用はできるだけおさえたい" };
  const w = byKey(c, "other:low_initial_cost");
  t("初期費用はできるだけおさえたい→その他 初期費用を抑えたい（ZERO_ZERO・検索の敷礼には入らない）", w?.scoring === "ZERO_ZERO" && w.search === false, w);
  const c2 = { preferences: "敷金礼金無し" };
  t("敷金礼金無し→敷礼0（初期費用を抑えたい）", byKey(c2, "other:low_initial_cost")?.label === "敷礼0（初期費用を抑えたい）", labels(c2));
  const c3 = { preferences: "敷礼なし" };
  t("敷礼なし→検索の敷金・礼金なしに入る（popup の detectShikireiFlag と同じ語）", byKey(c3, "other:low_initial_cost")?.search === true, labels(c3));
}
{
  const c = { preferences: "25平米以上\n梅香、大開、海老江、鷺洲、吉野1丁目、玉川1、2丁目、野田1丁目以外の地域" };
  const l = labels(c);
  t("25平米以上→その他 25㎡以上（SQM・検索に入る）", byKey(c, "other:sqm_text")?.search === true, l);
  t("地名の並び＋以外の地域→1つの NG（エリア）にまとめる（地名を1つずつにしない）", l.filter((x) => x.startsWith("NG:")).length === 1 && !l.some((x) => x === "その他:梅香"), l);
}
{
  const c = { preferences: "駅近・楽器可・家賃は安い方が良い", walk_minutes: null };
  const l = labels(c);
  t("駅近→その他 駅近（WALK_TEXT）", byKey(c, "other:walk_text")?.scoring === "WALK_TEXT", l);
  t("楽器可→その他 楽器（入居の条件・CONDITION_INSTRUMENT）", byKey(c, "other:cond_instrument")?.scoring === "CONDITION_INSTRUMENT", l);
  t("家賃は安い方が良い→その他 家賃は安め（RENT_CHEAP）", byKey(c, "other:rent_cheap")?.scoring === "RENT_CHEAP", l);
}
{
  const c = { additional_conditions: "[9/11 12:02|format] 希望: 宅配BOX・追い焚き エリア: 難波", preferences: null };
  t("additional_conditions の「希望:」だけ読む（エリアは読まない）", additionalHopes(c.additional_conditions) === "宅配BOX・追い焚き", additionalHopes(c.additional_conditions));
  const l = labels(c);
  t("記録の希望から 宅配ボックス・追い焚き（設備）", l.includes("設備:宅配ボックス") && l.includes("設備:追い焚き"), l);
}
t("空のお客様は項目なし", itemizeWants(null).length === 0 && itemizeWants({}).length === 0);
t("「特になし」は項目にしない", itemizeWants({ preferences: "特になし", other_requests: "なし" } as never).length === 0);

console.log("■ 画像で確かめたい希望（image-wants）に項目化した要望が入る");
{
  const wants = dedupeWantsByTopic(extractImageWants({ conditions: { preferences: "バストイレ別", other_requests: "ガスコンロ、カウンターキッチン、リビング8帖以上、初期費用15万円以内、収納多め" } }));
  const texts = wants.map((w) => w.text);
  t("カウンターキッチン・収納多め・リビング8帖以上・ガスコンロが画像の希望に入る", ["カウンターキッチン", "収納多め", "リビング8帖以上", "ガスコンロ"].every((x) => texts.includes(x)), texts);
  t("初期費用15万円以内は画像の希望に入らない（画像で決めない）", !texts.includes("初期費用15万円以内"), texts);
  t("画像で分析を勧める（対面キッチン・収納・帖数）", imageAnalysisNeed(wants).level === "recommended", imageAnalysisNeed(wants));
}

console.log("■ 書く側の振り分け（routeConditionText）");
{
  const r = routeConditionText({ other_requests: "バストイレ別・オートロック・初期費用抑えたい・1階NG・猫飼育可" });
  t("設備は preferences へ", r.preferences === "バストイレ別・オートロック・猫飼育可", r);
  t("1階NG は ng_points へ", r.ng_points === "1階NG", r);
  t("初期費用抑えたい は other_requests に残る", r.other_requests === "初期費用抑えたい", r);
  t("バス・トイレ別の「・」は割らない", routeConditionText({ other_requests: "バス・トイレ別、宅配ボックス" }).preferences === "バス・トイレ別・宅配ボックス", routeConditionText({ other_requests: "バス・トイレ別、宅配ボックス" }));
  t("ng_points の節は動かさない（角部屋希望が NG 欄に来ても人が直す）", routeConditionText({ ng_points: "角部屋希望" }).ng_points === "角部屋希望");
  t("同じ節は1つ", routeConditionText({ preferences: "オートロック", other_requests: "オートロック・ペット可" }).preferences === "オートロック・ペット可");
  t("空は null", JSON.stringify(routeConditionText({})) === JSON.stringify({ preferences: null, ng_points: null, other_requests: null }));
  t("木造以外 は NG（構造）", kindOfClause("木造以外", "other_requests") === "NG");
  t("ユニットバスでもOK は NG ではない（受け入れ）", kindOfClause("ユニットバスでもOK", "other_requests") !== "NG");
  t("ロフトNG は NG", kindOfClause("ロフトNG", "preferences") === "NG");
  t("リビング8帖以上 は その他", kindOfClause("リビング8帖以上", "other_requests") === "その他");
  t("routeChanges: other_requests の設備は preferences へ動く", JSON.stringify(routeChanges({ other_requests: "バストイレ別・オートロック" })) === JSON.stringify([{ from: "other_requests", to: "preferences", clause: "バストイレ別" }, { from: "other_requests", to: "preferences", clause: "オートロック" }]));
  t("splitWantText: 。、,/改行で割る", JSON.stringify(splitWantText("a。b、c,d/e\nf")) === JSON.stringify(["a", "b", "c", "d", "e", "f"]));
}

console.log("■ リビングの帖数の札（LDK_JO_*・property-brain）");
{
  t("資料の文字「1LDK[LDK11.9 x 洋4.4]」→ LDK 11.9", ldkJoFromText("間取タイプ 1LDK[LDK11.9 x 洋4.4]") === 11.9);
  t("「LDK11.2帖・洋室6帖」→ 11.2", ldkJoFromText("LDK11.2帖・洋室6帖") === 11.2);
  t("「1DK[DK:7.2畳 洋:4.3畳]」の DK は数えない（null）", ldkJoFromText("1DK[DK:7.2畳 洋:4.3畳]") === null);
  t("「1K[洋:6.5畳]」は null", ldkJoFromText("1K[洋:6.5畳]") === null);
  const customer: CustomerLike = { rent_max: 90000, floor_plan: "1LDK", other_requests: "リビング8帖以上", preferences: "バストイレ別" };
  const profile = buildCustomerProfile(customer, [], []);
  t("プロフィールに ldkJoWant 8", profile.ldkJoWant?.jo === 8, profile.ldkJoWant);
  t("希望なしの人は札なし", ldkJoCodes(null, 10).length === 0);
  t("8帖の希望に 11.9 → LDK_JO_OK", ldkJoCodes(profile.ldkJoWant, 11.9)[0] === "LDK_JO_OK");
  t("8帖の希望に 7 → LDK_JO_NG（保留の札）", ldkJoCodes(profile.ldkJoWant, 7)[0] === "LDK_JO_NG" && HOLD_REASON_CODES.has("LDK_JO_NG"));
  t("読めない → LDK_JO_UNKNOWN", ldkJoCodes(profile.ldkJoWant, null)[0] === "LDK_JO_UNKNOWN");
  const ok = judgeProperty(parsePropertyFacts("メゾン本庄東 203\n賃料 80,000円 管理費 5,000円\n間取タイプ 1LDK[LDK11.9 x 洋4.4] 40.2㎡\n築10年 徒歩5分\nAD 200%", null), profile, 0);
  t("判定: 資料の LDK11.9 で LDK_JO_OK（+3）", ok.reasonCodes.includes("LDK_JO_OK") && ok.facts.ldkJo === 11.9, ok.reasonCodes);
  const ng = judgeProperty(parsePropertyFacts("メゾン本庄東 203\n賃料 80,000円 管理費 5,000円\n間取タイプ 1LDK[LDK7.0 x 洋4.4] 30.2㎡\n築10年 徒歩5分\nAD 200%", null), profile, 0);
  t("判定: LDK7.0 で LDK_JO_NG・保留", ng.reasonCodes.includes("LDK_JO_NG") && ng.verdict === "hold", { codes: ng.reasonCodes, verdict: ng.verdict });
  const un = judgeProperty(parsePropertyFacts("メゾン本庄東 203\n賃料 80,000円 管理費 5,000円\n1LDK 40.2㎡\n築10年 徒歩5分\nAD 200%", null), profile, 0);
  // 点は比べない（要確認の札が増えると全部合う（FIT_ALL→FIT_ALL_HALF）の札も変わる）＝札の点が 0 である事だけ見る
  t("判定: 帖数なしで LDK_JO_UNKNOWN（0点・要確認）", un.reasonCodes.includes("LDK_JO_UNKNOWN") && REASON_POINTS.LDK_JO_UNKNOWN === 0, { codes: un.reasonCodes, ok: ok.score, un: un.score });
  t("札の日本語と条件の家族", reasonJa("LDK_JO_NG") === "リビングの帖数が希望より狭い" && fitVerdictOf("LDK_JO_NG")?.fam === "リビングの帖数" && fitVerdictOf("LDK_JO_UNKNOWN")?.v === "unread");
  const none = judgeProperty(parsePropertyFacts("メゾン本庄東 203\n賃料 80,000円 管理費 5,000円\n間取タイプ 1LDK[LDK7.0 x 洋4.4] 30.2㎡\n築10年 徒歩5分\nAD 200%", null), buildCustomerProfile({ rent_max: 90000, floor_plan: "1LDK" }, [], []), 0);
  t("希望を書いていない人には LDK の札が付かない（今まで通り）", !none.reasonCodes.some((c) => c.startsWith("LDK_JO_")), none.reasonCodes);
}

console.log("■ フォームの「その他」の行（決定論）・受け入れの言い方");
{
  const form = "①【ご入居時期】⇒10月\n⑧【その他ご要望あれば】⇒ 1階の物件希望、保証人不要(保証会社だけでいい)、バストイレ別、お風呂が汚くないor古くない";
  t("【その他ご要望あれば】⇒ の値を取る", formOtherWants(form) === "1階の物件希望、保証人不要(保証会社だけでいい)、バストイレ別、お風呂が汚くないor古くない", formOtherWants(form));
  t("値が無い・特になし は null", formOtherWants("⑧【その他ご要望あれば】⇒") === null && formOtherWants("⑧【その他こだわりご要望】⇒特になし") === null);
  const r = routeConditionText({ other_requests: formOtherWants(form) });
  t("フォームの行を振り分け: 保証人不要・バストイレ別は設備", r.preferences === "保証人不要(保証会社だけでいい)・バストイレ別", r);
  t("鶴見区以外も検討可能 は NG ではない（受け入れ）", kindOfClause("鶴見区以外も検討可能", "other_requests") === "その他");
  t("木造でもいい は NG ではない", kindOfClause("木造でもいい", "other_requests") !== "NG");
  t("収納多め は画像で分析が採点に足す（IMAGE_STORAGE）", byKey({ other_requests: "収納多め" }, "free:収納多め")?.scoring === "IMAGE_STORAGE（画像で分析）");
}

console.log("■ 監査の語の一覧");
t("監査の語は 30 以上・鍵は equip:/other:/free:/column: のどれか", AUDIT_WANT_WORDS.length >= 30 && AUDIT_WANT_WORDS.every((w) => /^(?:equip|other|free|column):/.test(w.key)));
{
  const room = AUDIT_WANT_WORDS.find((w) => w.word === "洋室○帖以上")!;
  t("監査: 「リビング10帖以上」は洋室の語に当たらない（旧は「0帖以上」に当たっていた）", !room.re.test("リビング10帖以上") && room.re.test("7畳以上で探してます") && room.re.test("8畳以上の広いワンルームでもいいかな"));
}

console.log("■ 発言の「初期費用○万以内」→ 列 initial_cost_limit（P4 で LLM が返さなかった時だけ・9/29 監査の実物）");
{
  const cases: Array<[string, number | null]> = [
    ["初期費用10万以下で探して欲しいです", 100000],
    ["初期費用10万以下の物件はないですか💦", 100000],
    ["ただ、初期費用は10万円前後を希望しているため、17万円台だと少し予算オーバーです。", 100000],
    ["初期費用20万以内", 200000],
    ["       初期費用10万以内", 100000],
    ["初期費用23万くらいで探しです", 230000],
    ["できれば初期費用20万くらいがいいです。", 200000],
    ["初期費用30万まで", 300000],
    ["承知しました!ありがとうございます!\n初期費用30万位内で他に収納が多くて狭すぎない、新地が近い物件ありますか?", 300000],
    ["独立洗面台、駅から徒歩10分圏内でなるべく綺麗な部屋で初期費用5万くらいのところないですか?", 50000],
    // この物件の値引きの相談は上限ではない
    ["気持ちはラグゼなのですが、ここ初期費用7万まで行けませんか?", null],
    ["こちら、初期費用20万に抑えることはできないでしょうか?", null],
    ["初期費用はいくらですか", null],
    ["家賃7万以内でお願いします", null],
  ];
  for (const [s, want] of cases) t(`「${s.replace(/\n/g, "⏎").slice(0, 34)}」→ ${want}`, initialCostLimitFromText(s) === want, initialCostLimitFromText(s));
  t("1通に2つある時は後の値（言い直し）", initialCostLimitFromText("初期費用20万以内\nやっぱり初期費用15万以内で") === 150000);
}

console.log("■ 「初期費用を抑えたい」の否定は節ごと（property-brain.detectWantsLowInitialCost）");
{
  t("「できるだけ初期費用抑えたい。築年数はこだわらない」→ 抑えたい（旧は別の節の「こだわらない」で消えていた・f56dfd70）", detectWantsLowInitialCost({ other_requests: "できるだけ初期費用抑えたい。築年数はこだわらない", initial_cost_limit: 200000 }) === true);
  t("「敷金礼金の負担がさらに増えてもよいので、もっと多くの候補物件を見たい」→ 抑えたいではない", detectWantsLowInitialCost({ other_requests: "敷金礼金の負担がさらに増えてもよいので、もっと多くの候補物件を見たい" }) === false);
  t("「初期費用は特になし、0円なら嬉しい」→ 今まで通り抑えたいではない", detectWantsLowInitialCost({ other_requests: "初期費用は特になし、0円なら嬉しい" }) === false);
  t("「敷金・礼金なし、洗濯機置き場あり」→ 抑えたい（「・」で割らない）", detectWantsLowInitialCost({ preferences: "敷金・礼金なし、洗濯機置き場あり、保証人不要" }) === true);
  t("「初期費用・家賃はできるだけ安いほうが良い」→ 抑えたい（「・」で割らない）", detectWantsLowInitialCost({ other_requests: "初期費用・家賃はできるだけ安いほうが良い" }) === true);
  const it = itemizeWants({ other_requests: "できるだけ初期費用抑えたい。築年数はこだわらない" } as never);
  t("項目: 「できるだけ初期費用抑えたい」が 初期費用を抑えたい（ZERO_ZERO）になり自由の塊に残らない", it.some((w) => w.key === "other:low_initial_cost" && w.scoring === "ZERO_ZERO") && !it.some((w) => w.key === "free:できるだけ初期費用抑えたい"), it.map((w) => w.key));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
