// 2026-09-29 家賃は「安いほど良い」ではなく「条件の中で見る」（property-brain RENT_BAND_RULE）のテスト
// 実行: npx tsx app/lib/__tests__/rent-band.test.ts
// 物件は R さんの 9/29 のピックアップ（リアプロ・id 1772〜1798）の実物の家賃＋管理費、条件は R さんの登録（下限 70,000・上限 79,999・1LDK）。
// 目安の額は property_customers の条件欄の実物の言い回し（名前・電話・番地は無い）
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, rentPositionCodes, readRentTarget, setRentBandEnabled, rentBandEnabled, rentMinHoldRatio,
  RENT_BAND_RULE, RENT_BAND_POINTS, REASON_POINTS, HOLD_REASON_CODES, reasonJa, reasonPoints, BASE_SCORE, fitVerdictOf, ngHitCodes, type CustomerLike,
} from "../property-brain";
import { buildFitCells } from "../pickup-card-view";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

// リアプロの説明文の形（「46,000円 10,000円」＝家賃の後ろに管理費）
const L = (name: string, rent: string, adm: string, plan = "1K", extra = "") => `【1】${name}\n${rent} ${adm}\n${plan}\n敷なし 礼なし\n徒歩5分\nAD 2ヶ月${extra}`;
const R: CustomerLike = { rent_min: 70_000, rent_max: 79_999, floor_plan: "1LDK" };
const pR = buildCustomerProfile(R);

console.log("■ 表（1か所）");
{
  t("帯は上から 0.90・0.85・0.80・0", RENT_BAND_RULE.bands.map((b) => b.minRatio).join(",") === "0.9,0.85,0.8,0");
  t("帯の札は 0 か減点だけ（家賃の家族の最大は RENT_OK +15 のまま＝AD 2ヶ月 ÷1.3 を超えない）", RENT_BAND_RULE.bands.every((b) => b.points <= 0) && REASON_POINTS.RENT_OK === 15);
  t("REASON_POINTS に表の点が入る", Object.entries(RENT_BAND_POINTS).every(([k, v]) => REASON_POINTS[k] === v && reasonPoints(k) === v));
  t("下限未満は保留の札", HOLD_REASON_CODES.has("RENT_UNDER_MIN") && !HOLD_REASON_CODES.has("RENT_NEAR_MIN") && !HOLD_REASON_CODES.has("RENT_BELOW_MIN"));
  t("旧の RENT_BELOW_MIN は −3 のまま（保存済みの行の点を変えない）", REASON_POINTS.RENT_BELOW_MIN === -3);
  t("札の言葉（上限寄り・下限未満・目安）", reasonJa("RENT_BAND_UPPER").includes("上限寄り") && reasonJa("RENT_UNDER_MIN").includes("下限未満") && reasonJa("RENT_TARGET_NEAR").includes("目安"));
  t("既定で入っている", rentBandEnabled());
}

console.log("■ R さんの回（下限 70,000・上限 79,999）");
{
  const city = judgeProperty(parsePropertyFacts(L("CityLifeディナスティ新大阪 602", "46,000円", "10,000円")), pR);
  t("CityLife 602（4.6万＋管理費1万＝5.6万）→ 下限未満の保留・RENT_OK なし", city.verdict === "hold" && city.reasonCodes.includes("RENT_UNDER_MIN") && !city.reasonCodes.includes("RENT_OK"));
  t("CityLife の AD は _HELD（保留の物件を AD で上げない）・全部合うも付かない", city.reasonCodes.includes("AD_HIGH_HELD") && !city.reasonCodes.some((c) => /^FIT_/.test(c)));
  t("CityLife は家賃の外れ（fitVerdictOf ng）＝ NG の札に数える", fitVerdictOf("RENT_UNDER_MIN")?.v === "ng" && ngHitCodes(city.reasonCodes).includes("RENT_UNDER_MIN"));
  const pro = judgeProperty(parsePropertyFacts(L("プロシード心斎橋東ヴァンターレ 704", "74,000円", "0円")), pR);
  t("プロシード 704（7.4万・0.93）→ 上限寄り（RENT_OK +15・帯 0）", pro.reasonCodes.includes("RENT_OK") && pro.reasonCodes.includes("RENT_BAND_UPPER") && pro.verdict === "pass");
  t("CityLife（旧 132点の1位）より プロシード（帯の中）が上", pro.score > city.score);
  const amour = judgeProperty(parsePropertyFacts(L("アムールセゾン 503", "64,000円", "5,000円", "2DK")), pR);
  t("アムールセゾン（6.4万＋5千＝6.9万・下限の98.6%）→ 保留にしない・下限を少し下回る知らせ", amour.reasonCodes.includes("RENT_NEAR_MIN") && amour.reasonCodes.includes("RENT_OK") && !amour.flagCodes.includes("RENT_NEAR_MIN"));
  const spot = judgeProperty(parsePropertyFacts(L("心斎橋SPOT21 604", "55,000円", "5,000円")), pR);
  // 2026-09-30 竹内「下限 95% を保留は強すぎる。85% 程までいける」→ 下限7万台の保留の線は 85%（59,500円）
  t("心斎橋SPOT21（6.0万・下限の86%）→ 保留にしない・下限を下回る軽い減点（RENT_UNDER_MIN_SOFT）", spot.reasonCodes.includes("RENT_UNDER_MIN_SOFT") && spot.reasonCodes.includes("RENT_OK") && !spot.flagCodes.some((c) => /^RENT_/.test(c)));
  t("心斎橋SPOT21 は上限の75%＝8割未満の札も付く（安いほど良いではない）", spot.reasonCodes.includes("RENT_BAND_LOW"));
  t("心斎橋SPOT21 は上限寄りの プロシード 704（7.4万）より下", spot.score < pro.score);
  const spotHalf = judgeProperty(parsePropertyFacts(L("心斎橋SPOT21 604", "55,000円", "5,000円")), pR);
  t("SPOT21 と上限寄りの差は 帯の点＋軽い減点（AD 等は同じ形の資料）", pro.score - spotHalf.score === RENT_BAND_POINTS.RENT_BAND_UPPER - RENT_BAND_POINTS.RENT_BAND_LOW - RENT_BAND_POINTS.RENT_UNDER_MIN_SOFT);
  const edge = judgeProperty(parsePropertyFacts(L("線の上", "59,500円", "0円")), pR), under = judgeProperty(parsePropertyFacts(L("線の下", "59,400円", "0円")), pR);
  t("下限7万: 59,500円（85%ちょうど）は保留にしない・59,400円は保留", edge.verdict === "pass" && edge.reasonCodes.includes("RENT_UNDER_MIN_SOFT") && under.reasonCodes.includes("RENT_UNDER_MIN") && under.verdict === "hold");
}

console.log("■ 下限の保留の線（下限の家賃帯ごと・2026-09-30）");
{
  t("線の表: 〜7万台 0.85・8〜9万台 0.80・10万以上 0.75", [50_000, 60_000, 79_999, 80_000, 99_999, 100_000, 150_000].map(rentMinHoldRatio).join(",") === "0.85,0.85,0.85,0.8,0.8,0.75,0.75");
  t("高い帯ほど低い割合まで許す（線は下がるだけ）", RENT_BAND_RULE.minHoldTiers.every((x, i, a) => i === 0 || a[i - 1].minFrom > x.minFrom && a[i - 1].holdRatio <= x.holdRatio));
  t("軽い減点は保留の札ではない・点は 0 か減点", !HOLD_REASON_CODES.has("RENT_UNDER_MIN_SOFT") && REASON_POINTS.RENT_UNDER_MIN_SOFT === RENT_BAND_RULE.softMinPoints && RENT_BAND_RULE.softMinPoints <= 0);
  t("軽い減点の札の言葉", reasonJa("RENT_UNDER_MIN_SOFT").includes("下限を下回る"));
  const codes = (total: number, p: CustomerLike) => rentPositionCodes(total, buildCustomerProfile(p)).map((r) => `${r.code}${r.hold ? "(保留)" : ""}`).join(",");
  // 6万台: 実物（当て直し pool 0860f578・6540cd7d: スタッフが選んで送った）エステムコート難波WEST-SIDE大阪ドーム前 55,000円・下限 60,000・上限 70,000（AD 2）
  const p6 = { rent_min: 60_000, rent_max: 70_000 };
  t("6万台: エステムコート難波WEST-SIDE（5.5万・下限の92%・スタッフが選んだ）→ 保留にしない（前の直しでは保留）", codes(55_000, p6) === "RENT_OK,RENT_BAND_LOW,RENT_UNDER_MIN_SOFT");
  t("6万台: 下限の98%（5.9万）→ 少し下回る（0点の知らせ）", codes(59_000, p6) === "RENT_OK,RENT_BAND_LOWER,RENT_NEAR_MIN");
  t("6万台: シャトレ下新庄（4.8万・下限の80%）→ 保留", codes(48_000, p6) === "RENT_UNDER_MIN(保留)");
  // 8〜9万台: 実物の🌟 グランパシフィック長橋スクエア 82,000円（下限 90,000・上限 100,000）／フォーラム池田・渋谷 73,000円（下限 80,000・上限 90,000）
  t("9万台: グランパシフィック長橋スクエア（8.2万・下限の91%・🌟）→ 保留にしない", codes(82_000, { rent_min: 90_000, rent_max: 100_000 }) === "RENT_OK,RENT_BAND_LOWER,RENT_UNDER_MIN_SOFT");
  t("8万台: フォーラム池田・渋谷（7.3万・下限の91%・🌟）→ 保留にしない", codes(73_000, { rent_min: 80_000, rent_max: 90_000 }) === "RENT_OK,RENT_BAND_LOWER,RENT_UNDER_MIN_SOFT");
  t("8万台: 下限の80%（6.4万）は保留にしない・6.3万は保留（7万台より幅が広い）", codes(64_000, { rent_min: 80_000, rent_max: 90_000 }).endsWith("RENT_UNDER_MIN_SOFT") && codes(63_000, { rent_min: 80_000, rent_max: 90_000 }) === "RENT_UNDER_MIN(保留)");
  t("同じ 85% 未満でも 7万台は保留・8万台は保留にしない（家賃帯による）", codes(59_000, { rent_min: 70_000, rent_max: 80_000 }) === "RENT_UNDER_MIN(保留)" && !codes(67_000, { rent_min: 80_000, rent_max: 90_000 }).includes("保留"));
  // 10万以上: 下限 100,000・上限 110,000（実物の🌟 ル・レーヴ今津サウス 80,000円・クリエオーレ西郷通 97,000円）
  const p10 = { rent_min: 100_000, rent_max: 110_000 };
  t("10万: クリエオーレ西郷通（9.7万・下限の97%）→ 少し下回る", codes(97_000, p10) === "RENT_OK,RENT_BAND_MID,RENT_NEAR_MIN");
  t("10万: ル・レーヴ今津サウス（8.0万・下限の80%）→ 保留にしない", codes(80_000, p10) === "RENT_OK,RENT_BAND_LOW,RENT_UNDER_MIN_SOFT");
  t("10万: 下限の75%（7.5万）は保留にしない・7.4万は保留", codes(75_000, p10).endsWith("RENT_UNDER_MIN_SOFT") && codes(74_000, p10) === "RENT_UNDER_MIN(保留)");
  t("上限が無い人も同じ線（下限だけを見る）", codes(76_000, { rent_min: 100_000 }) === "RENT_UNDER_MIN_SOFT" && codes(74_000, { rent_min: 100_000 }) === "RENT_UNDER_MIN(保留)" && codes(98_000, { rent_min: 100_000 }) === "RENT_NEAR_MIN");
}

console.log("■ 下限の無いお客様（上限 80,000）: 帯");
{
  const p = buildCustomerProfile({ rent_max: 80_000, floor_plan: "1K" });
  const code = (total: number) => rentPositionCodes(total, p).map((r) => r.code).join(",");
  t("78,000（0.975）→ 上限寄り", code(78_000) === "RENT_OK,RENT_BAND_UPPER");
  t("72,000（0.90）→ 上限寄り（線の上）", code(72_000) === "RENT_OK,RENT_BAND_UPPER");
  t("70,000（0.875）→ 85〜90%", code(70_000) === "RENT_OK,RENT_BAND_MID");
  t("66,000（0.825）→ 80〜85%", code(66_000) === "RENT_OK,RENT_BAND_LOWER");
  t("56,000（0.70）→ 8割未満", code(56_000) === "RENT_OK,RENT_BAND_LOW");
  t("上限を超えた物は帯を付けない（今まで通り RENT_WIDE 等で見る）", code(83_000) === "");
  const hi = judgeProperty(parsePropertyFacts(L("A", "76,000円", "2,000円")), p), lo = judgeProperty(parsePropertyFacts(L("B", "50,000円", "6,000円")), p);
  t("同じ条件で 7.8万 が 5.6万 より上（安いほど良いではない）", hi.score > lo.score);
  t("点の差は帯の点の差だけ", hi.score - lo.score === RENT_BAND_POINTS.RENT_BAND_UPPER - RENT_BAND_POINTS.RENT_BAND_LOW);
  t("8割未満は保留にしない（下限が無い人は減点だけ）", lo.verdict === "pass");
  const over = judgeProperty(parsePropertyFacts(L("C", "83,000円", "0円")), p);
  t("上限を少し超えた 8.3万 は今まで通り RENT_WIDE", over.reasonCodes.includes("RENT_WIDE") && !over.reasonCodes.some((c) => /^RENT_BAND_/.test(c)));
}

console.log("■ 目安の額（readRentTarget）");
{
  const tg = (o: CustomerLike) => { const p = buildCustomerProfile(o); return readRentTarget(o, p.rentMin ?? null, p.rentMax); };
  const a = tg({ rent_max: 70_000, other_requests: "できれば60000円程度" });
  t("「できれば60000円程度」（上限7万）→ 6万・家賃だけ", a?.yen === 60_000 && a.withAdmin === false);
  const b = tg({ rent_min: 80_000, rent_max: 120_000, other_requests: "家賃10万くらい(管理費込みで12万上限)" });
  t("「家賃10万くらい(管理費込みで12万上限)」→ 10万（12万は上限の言い方）", b?.yen === 100_000 && b.withAdmin === false);
  t("「基本家賃10万位、駐車場込みなら12万まで」→ 10万", tg({ rent_max: 120_000, other_requests: "理想は2LDK45平米以上。基本家賃10万位、駐車場込みなら12万まで。" })?.yen === 100_000);
  t("「共益費込で7万円くらい」（上限8万）→ 7万・管理費込み", (() => { const x = tg({ rent_max: 80_000, preferences: "共益費込で7万円くらい" }); return x?.yen === 70_000 && x.withAdmin; })());
  t("「本来の希望は5.6万程度」（上限5.6万）→ なし（上限そのもの）", tg({ rent_max: 56_000, other_requests: "本来の希望は5.6万程度" }) === null);
  t("「共益費込み9.5万くらいまで上げておk」→ なし（まで＝上限の言い方）", tg({ rent_min: 50_000, rent_max: 120_000, other_requests: "共益費込み9.5万くらいまで上げておk" }) === null);
  t("「家賃+管理費で月10万円前後まで」→ なし", tg({ rent_max: 120_000, other_requests: "家賃+管理費で月10万円前後まで" }) === null);
  t("「8万以内が理想」→ なし（以内）", tg({ rent_max: 90_000, other_requests: "8万以内が理想" }) === null);
  t("「7〜8万円くらい」→ なし（幅の上）", tg({ rent_min: 70_000, rent_max: 90_000, other_requests: "7〜8万円くらい" }) === null);
  t("「駐車場代込みで8万ぐらい」→ なし（駐車場の節）", tg({ rent_max: 100_000, preferences: "駐車場代込みで8万ぐらい" }) === null);
  t("「初期費用20万くらい」→ なし（初期費用の節）", tg({ rent_max: 90_000, other_requests: "初期費用20万くらい" }) === null);
  t("「家賃11〜12万で30m2前後」→ なし", tg({ rent_min: 80_000, rent_max: 120_000, other_requests: "家賃11〜12万で30m2前後" }) === null);
  t("下限より下の額は読まない", tg({ rent_min: 65_000, rent_max: 80_000, other_requests: "できれば6万くらい" }) === null);
  // 2026-09-30 反証: 実物（c46fe3b6）は「共益費込み」が前の節。節だけ見ると家賃だけになっていた
  const real = tg({ rent_max: 70_000, other_requests: "共益費込み、できれば60000円程度、部屋は広い方が良い(希望は7畳前後)、独立洗面所、オートロック" });
  t("実物「共益費込み、できれば60000円程度」→ 6万・管理費込み（前の節の「共益費込み」）", real?.yen === 60_000 && real.withAdmin === true);
  t("別の行の「管理費込み」は効かない", tg({ rent_max: 70_000, other_requests: "管理費込みで7万まで\nできれば6万くらい" })?.withAdmin === false);
  const pr = buildCustomerProfile({ rent_max: 70_000, other_requests: "共益費込み、できれば60000円程度" });
  const jr = (rent: string, adm: string) => judgeProperty(parsePropertyFacts(L("X", rent, adm)), pr);
  t("実物: 家賃 55,000＋共益費 5,000（計 6万）→ 目安に近い", jr("55,000円", "5,000円").reasonCodes.includes("RENT_TARGET_NEAR"));
  t("実物: 家賃 60,000＋共益費 5,000（計 6.5万）→ 少し離れる", jr("60,000円", "5,000円").reasonCodes.includes("RENT_TARGET_MID"));
}

console.log("■ 目安の額がある人: 目安の近くが一番");
{
  const p = buildCustomerProfile({ rent_max: 70_000, other_requests: "家賃はできるだけ安く。できれば60000円程度" });
  t("目安 6万・安さの希望も読める", p.rentTarget === 60_000 && !!p.written?.rentCheap);
  const j = (rent: string, adm: string) => judgeProperty(parsePropertyFacts(L("X", rent, adm)), p);
  const near = j("60,000円", "3,000円"), mid = j("66,000円", "3,000円"), far = j("48,000円", "0円");
  t("6.0万（管理費は別）→ 目安に近い", near.reasonCodes.includes("RENT_TARGET_NEAR"));
  t("6.6万 → 少し離れる", mid.reasonCodes.includes("RENT_TARGET_MID"));
  t("4.8万（目安より2割安い）→ 離れている", far.reasonCodes.includes("RENT_TARGET_FAR"));
  t("目安の近くが一番高い", near.score > mid.score && near.score > far.score);
  t("目安がある人には安さの札（RENT_CHEAP_*）を付けない", ![near, mid, far].some((x) => x.reasonCodes.some((c) => /^RENT_CHEAP_/.test(c))));
  t("目安がある人には帯の札を付けない", ![near, mid, far].some((x) => x.reasonCodes.some((c) => /^RENT_BAND_/.test(c))));
}

console.log("■ 目安の額の無い「家賃は安い方が良い」の人（cheapWithoutTarget）");
{
  const p = buildCustomerProfile({ rent_max: 80_000, other_requests: "家賃は安い方が良い" });
  const lo = judgeProperty(parsePropertyFacts(L("Y", "60,000円", "0円")), p);
  t("安さの札（RENT_CHEAP_W80）はそのまま", lo.reasonCodes.includes("RENT_CHEAP_W80"));
  t(`帯の札は ${RENT_BAND_RULE.cheapWithoutTarget === "neutral" ? "付けない（neutral）" : "付ける（band）"}`, RENT_BAND_RULE.cheapWithoutTarget === "neutral" ? !lo.reasonCodes.some((c) => /^RENT_BAND_/.test(c)) : lo.reasonCodes.includes("RENT_BAND_LOW"));
}

console.log("■ 切り替え（戻す時）");
{
  setRentBandEnabled(false);
  const city = judgeProperty(parsePropertyFacts(L("CityLifeディナスティ新大阪 602", "46,000円", "10,000円")), pR);
  t("切ると旧の決まり（RENT_OK +15 一律・下限の85%未満で RENT_BELOW_MIN −3・保留にしない）", city.reasonCodes.includes("RENT_OK") && city.reasonCodes.includes("RENT_BELOW_MIN") && city.verdict === "pass");
  t("切ると帯の札は付かない", !city.reasonCodes.some((c) => /^RENT_(?:BAND|TARGET|UNDER|NEAR)_/.test(c)));
  setRentBandEnabled(null);
  t("戻すと新しい決まり", judgeProperty(parsePropertyFacts(L("CityLife", "46,000円", "10,000円")), pR).reasonCodes.includes("RENT_UNDER_MIN"));
}

console.log("■ 点は 50＋札の合計（表と判定がずれない）");
{
  const p = buildCustomerProfile({ rent_min: 60_000, rent_max: 80_000 });
  for (const [rent, adm] of [["76,000円", "2,000円"], ["62,000円", "4,000円"], ["58,000円", "0円"], ["50,000円", "0円"]] as const) {
    const j = judgeProperty(parsePropertyFacts(L("Z", rent, adm)), p);
    t(`${rent}＋${adm}: 50＋合計＝点`, j.score === Math.max(0, Math.min(200, BASE_SCORE + j.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0))));
  }
}

console.log("■ 画面の家賃の欄（pickup-card-view）");
{
  const cell = (codes: string[]) => buildFitCells(codes, {}).find((c) => c.key === "rent");
  const up = cell(["RENT_OK", "RENT_BAND_UPPER"]), low = cell(["RENT_OK", "RENT_BAND_LOW"]), under = cell(["RENT_UNDER_MIN"]);
  t("上限寄り → 「予算・上限寄り（相場に見合う）」・緑", !!up && (up.note ?? "").includes("上限寄り（相場に見合う）") && up.tone === "ok");
  t("8割未満 → 緑にしない", !!low && low.tone !== "ok");
  t("下限未満 → 「下限未満」・赤", !!under && (under.note ?? "").includes("下限未満") && under.tone === "ng");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// 2026-10-02 ⑫ 竹内さんの決定「上限しか無い時もおおよその下限（10万の上限で5万の部屋は質が下がる）」
import { implicitRentMin, searchRentMinOf, buildCustomerProfile as bcp, judgeProperty as jp, parsePropertyFacts as ppf } from "../property-brain";
{
  const ok = (name: string, c: boolean, x = "") => { if (c) console.log(`  OK  ${name}`); else { console.log(`  NG  ${name} ${x}`); process.exitCode = 1; } };
  ok("上限10万 → おおよその下限 7万", implicitRentMin(100_000) === 70_000);
  ok("安さの希望がある人は出さない", implicitRentMin(100_000, { cheap: true }) === null);
  ok("目安の額がある人は出さない", implicitRentMin(100_000, { target: 60_000 }) === null);
  const prof = bcp({ rent_max: 100_000, floor_plan: "1K" });
  ok("顧客の行に下限なし → 型の rentMinImplicit=70000・rentMin は null のまま", prof.rentMin == null && prof.rentMinImplicit === 70_000, JSON.stringify([prof.rentMin, prof.rentMinImplicit]));
  const cheapRoom = jp(ppf("【1】安い\n50,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 1ヶ月"), prof);
  ok("上限10万で5万の部屋 → 保留（RENT_UNDER_MIN）", cheapRoom.verdict === "hold" && cheapRoom.reasonCodes.includes("RENT_UNDER_MIN"), JSON.stringify([cheapRoom.verdict, cheapRoom.reasonCodes]));
  const nearTop = jp(ppf("【1】上限寄り\n92,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 1ヶ月"), prof);
  ok("上限10万で9.2万の部屋は保留にしない", nearTop.verdict !== "hold" || !nearTop.reasonCodes.includes("RENT_UNDER_MIN"));
  const s = searchRentMinOf({ rent_max: 100_000 });
  ok("検索の下限: おおよその下限 7万 × 保留の線 0.85 → 5.9万（採点で保留になる所より下は探さない）", !!s && s.implicit && s.yen === 59_000, JSON.stringify(s));
  const s2 = searchRentMinOf({ rent_max: 100_000, rent_min: 80_000 });
  ok("書いた下限があればそれ", !!s2 && !s2.implicit && s2.yen === 80_000, JSON.stringify(s2));
}
