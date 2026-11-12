// app/lib/__tests__/conductor-our-side.test.ts — 入口の統括に渡す「こちら側の状態」（純関数）
// 実行: npx tsx app/lib/__tests__/conductor-our-side.test.ts
import { ourSideBlock, promiseKindOf, conductorOurSideOn, ourSideBrainOn, checkedFacts, ourSideCheckedOn, vacatingRoomsOf, ourSideComposeNote, ourSideToComposeOn, staffSinceLine, intakeStaffRefreshOn } from "../conductor-our-side";
import { readComposeContext, composeContextLines, handoffLeaks } from "../compose-sentence-plan";
import { secondPlanNote } from "../aix-second-brain-plan";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} → ${JSON.stringify(info)}`); } };
const now = Date.parse("2026-11-03T10:36:00Z");

t("既定 off・on で動く", !conductorOurSideOn({}) && conductorOurSideOn({ CONDUCTOR_OUR_SIDE: "on" }));
t("ブレインの側は 11/12 朝から既定 off・=on で入る・入口のスイッチとは別", !ourSideBrainOn({}) && !ourSideBrainOn({ CONDUCTOR_OUR_SIDE: "on" }) && ourSideBrainOn({ CONDUCTOR_OUR_SIDE_BRAIN: "on" }));
t("約束の種類", promiseKindOf("お送り頂きました新大阪グランドハイツの募集状況確認させて頂きます") === "確認" && promiseKindOf("最大限割引させて頂いた御見積書を作成しお送りさせて頂きます") === "見積"
  && promiseKindOf("浪速区周辺全域からピックアップしてお送りさせて頂きます") === "探す" && promiseKindOf("内覧の候補日お送りさせて頂きます") === "内覧");

// q371 の元の番（13分前の確認の約束・新しい1件）: 約束は開いている・結果はまだ
{
  const b = ourSideBlock({ nowMs: now, msgs: [
    { sender: "staff", text: "お送り頂きました新大阪グランドハイツと新大阪ステーションビルの募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😌！！", created_at: "2026-11-03T10:22:00Z" },
    { sender: "customer", text: "ART TENDOU WEST 1階", created_at: "2026-11-03T10:35:50Z" },
  ], aix: [
    { aix_type: "property_check_result", check_pattern: "unavailable", created_at: "2026-11-02T09:00:00Z", property_names: ["A", "B", "C"] },
    { aix_type: "property_send", created_at: "2026-11-03T09:06:00Z" },
  ] });
  t("q371: 確認の約束が開いている（14分前）", /開いている約束: 確認の約束「お送り頂きました新大阪グランドハイツと新大阪ステーションビルの募集状況確認させて頂きます！」（14分前/.test(b), b);
  t("q371: 直前の AIX は物件送付（束）・送った物件の回数", /直前の AIX: 物件送付（束）/.test(b) && /束 1回・1件のオススメ 0回/.test(b), b);
}
// 9758 型: 物件確認した（募集中・見積書同封）の後の「初期費用は」→ 約束は果たし済み・直前の AIX が見積書同封
{
  const b = ourSideBlock({ nowMs: Date.parse("2026-11-01T07:03:00Z"), msgs: [
    { sender: "staff", text: "お送り頂きました物件の募集状況確認させて頂きます！！", created_at: "2026-10-31T10:00:00Z" },
    { sender: "staff", text: "こちら2件現在募集中となります！！", created_at: "2026-11-01T02:44:00Z", is_aix_generated: true },
  ], aix: [{ aix_type: "property_check_result", check_pattern: "available", created_at: "2026-11-01T02:44:00Z", property_names: ["アーバネックス四ツ橋 1308", "アーバネックス四ツ橋 203", "X"], estimate_sent: true }] });
  t("9758: 約束は AIX で果たした＝なし", /開いている約束: なし/.test(b), b);
  t("9758: 直前の AIX の意味・ピッカー・物件名2件・見積書", b.includes("物件確認した（確かめた結果を送る＝空き・募集・入居日・室内写真／管理会社に確かめた条件・設備・交渉の結果は mgmt_* のピッカー）＝募集中（アーバネックス四ツ橋 1308・アーバネックス四ツ橋 203）・御見積書を同封（4時間前）"), b);
}
// 11932 型: 確認した（管理会社の設備）の意味・mgmt_ のピッカー
{
  const b = ourSideBlock({ nowMs: now, msgs: [], aix: [{ aix_type: "acknowledge_check", check_pattern: "mgmt_equipment", created_at: "2026-11-03T08:00:00Z" }] });
  t("確認します＝約束・mgmt_ は管理会社に確かめた結果", /確認します（これから確かめる・交渉する約束を AIX で送る）＝管理会社に確かめた結果（設備）/.test(b), b);
}
// 今より後の通・AIX は見ない（答えの漏れ）
{
  const b = ourSideBlock({ nowMs: now, msgs: [{ sender: "staff", text: "確認させて頂きます", created_at: "2026-11-03T11:00:00Z" }], aix: [{ aix_type: "estimate_sheet", created_at: "2026-11-03T11:30:00Z" }] });
  t("今より後は見ない", /開いている約束: なし/.test(b) && /直前の AIX: なし/.test(b) && /まだ無い/.test(b), b);
}
// 2026-11-11 弱い所 575: 確かめ済みの事実（竹内さんの実物の言い方）
{
  const msgs = [
    { sender: "staff", text: "BLANCOSTA SQUARE管理会社に確認しましたところ、11月2日からご内覧が出来そこからクリーニング工事がはいりますので、最短で11月中旬でのご入居となります！！", created_at: "2026-11-01T06:40:00Z" },
    { sender: "staff", text: "エスリード中之島クロスゲート募集状況確認させて頂きましたところ、現在お部屋お申込が入っており、2番手以降でのお申込となります！！", created_at: "2026-11-02T14:12:00Z", is_aix_generated: true },
    { sender: "staff", text: "管理会社に交渉させて頂きましたがこちらクリーニング費用必須となります。", created_at: "2026-11-03T09:01:00Z" },
    { sender: "staff", text: "お送り頂きました物件の募集状況確認させて頂きます！！", created_at: "2026-11-03T09:30:00Z" },
    { sender: "customer", text: "確認しましたところ大丈夫でした", created_at: "2026-11-03T09:40:00Z" },
  ];
  const f = checkedFacts({ msgs, nowMs: now });
  t("575: 結果の文だけ拾う（約束の文・お客様の文は拾わない）・新しい順", f.length === 3 && f[0].kind === "③交渉" && f[1].kind === "①募集状況" && f[2].kind === "②条件", f);
  t("575: 結果の1文を要点に（ところ の後の文も）", /2番手以降でのお申込/.test(f[1].gist) && /11月中旬/.test(f[2].gist), f);
  t("575: 既定 off（塊に出ない）・on で出る", !/確かめ済み/.test(ourSideBlock({ msgs, aix: [], nowMs: now })) && /確かめ済みの事実/.test(ourSideBlock({ msgs, aix: [], nowMs: now, withChecked: true })) && !ourSideCheckedOn({}) && ourSideCheckedOn({ OUR_SIDE_CHECKED: "on" }));
  t("575: 30日より古い・今より後は拾わない", checkedFacts({ msgs, nowMs: Date.parse("2026-12-20T00:00:00Z") }).length === 0 && checkedFacts({ msgs, nowMs: Date.parse("2026-11-01T00:00:00Z") }).length === 0);
}
// 2026-11-12 q057（作業員7 の切り分け）: 退去予定の部屋を「募集中」だけにしない・内見できるかの問いに内覧調整を勧めない
{
  const nowQ = Date.parse("2026-10-01T10:00:00Z");
  const msgs = [{ sender: "staff", text: "YUMAさんお送りいただきました物件の中で\nBLANCOSTA SQUARE 204号室現在募集中となります！！\n10月中旬退去予定のため、11月中旬ごろご入居可能なお部屋となります！！\n最大限割引しました御見積書同封させて頂きました！！", created_at: "2026-10-01T09:00:00Z", is_aix_generated: true }];
  const aix = [{ aix_type: "property_check_result", check_pattern: "available", created_at: "2026-10-01T09:00:00Z", property_names: ["BLANCOSTA SQUARE 204", "X 101"], prop_statuses: ["vacating", "unavailable"], estimate_sent: true }];
  const v = vacatingRoomsOf({ msgs, aix, nowMs: nowQ });
  t("q057: 退去予定の部屋を AIX の状態と文の両方から拾う", v[0] === "BLANCOSTA SQUARE 204" && v.some((x) => x.includes("10月中旬退去予定")), v);
  const b = ourSideBlock({ msgs, aix, nowMs: nowQ });
  t("q057: 直前の AIX に物件ごとの状態（退去予定）", b.includes("BLANCOSTA SQUARE 204＝退去予定"), b);
  t("q057: 退去予定の部屋の行と、内覧調整を勧めない読み方", b.includes("・退去予定の部屋（室内の内覧は退去後）") && b.includes("内覧調整の AIX を勧めず") && b.includes("内覧の日時が決まる番＝内覧調整・待ち合わせ"), b);
  t("q057: 30日より前・今より後は拾わない", vacatingRoomsOf({ msgs, aix, nowMs: Date.parse("2026-12-01T00:00:00Z") }).length === 0 && vacatingRoomsOf({ msgs, aix, nowMs: Date.parse("2026-09-01T00:00:00Z") }).length === 0);
}
// 2026-11-12 OUR_SIDE_TO_COMPOSE: 道が決まった後の文の統括と AIX の文だけへ（q057 の実物）
{
  const nowQ = Date.parse("2026-10-01T10:00:00Z");
  const msgs = [{ sender: "staff", text: "BLANCOSTA SQUARE 204号室現在募集中となります！！\n10月中旬退去予定のため、11月中旬ごろご入居可能なお部屋となります！！", created_at: "2026-10-01T09:00:00Z", is_aix_generated: true }];
  const aix = [{ aix_type: "property_check_result", check_pattern: "available", created_at: "2026-10-01T09:00:00Z", property_names: ["BLANCOSTA SQUARE 204"], prop_statuses: ["vacating"], estimate_sent: true }];
  const n = ourSideComposeNote({ msgs, aix, nowMs: nowQ, intakeLine: "【入口の統括の読み（11/12・参考・決めるのはブレイン）】主「内見はできないのか」・重点=answer・やる事: 本文で答える「退去前で室内不可と答える」" });
  t("compose: 既定 off", !ourSideToComposeOn({}) && ourSideToComposeOn({ OUR_SIDE_TO_COMPOSE: "on" }));
  t("compose: 状態の行だけ（読み方の長い行は入れない）・退去予定の文の材料・入口の読み", n.includes("BLANCOSTA SQUARE 204＝退去予定") && n.includes("室内を今は内覧できない") && n.includes("・入口の統括の読み: 主「内見はできないのか」") && !n.includes("読み方"), n);
  const ctx = readComposeContext({ our_side_note: n });
  const cl = composeContextLines(ctx);
  t("compose: 文の統括の文脈の行に出る", cl.some((l) => l.includes("こちら側の状態")) && cl.some((l) => l.includes("室内を今は内覧できない")), cl);
  t("compose: 受け渡しの表で漏れにならない（設計図の注記に出れば漏れ0）", handoffLeaks({ our_side_note: n }, cl.join("\n")).filter((x) => x.key === "our_side_note").length === 0 && handoffLeaks({ our_side_note: n }, "【✍️】何も無い").some((x) => x.key === "our_side_note"));
  t("compose: AIX の2通目の組み立てにも出る（道は変えない）", (secondPlanNote({ opening: "plain", openingNote: "-", axis: [], barrier: [], closing: "receipt", closingNote: "-", rules: [], ourSide: n.split("\n") }) ?? "").includes("室内を今は内覧できない"));
}
// 2026-11-12 CONDUCTOR_INTAKE_STAFF_REFRESH: 前のお客様の番の後にこちらがした事（q371 の元の会話の形）
{
  const nowS = Date.parse("2026-11-03T10:35:51Z");
  const msgs = [
    { sender: "customer", text: "新大阪ステーションビル 4階 こちらも物件に空きがあるか教えて欲しいです。", created_at: "2026-11-03T10:16:00Z" },
    { sender: "staff", text: "お送り頂きました新大阪グランドハイツと新大阪ステーションビルの募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😌！！", created_at: "2026-11-03T10:22:00Z" },
    { sender: "customer", text: "ART TENDOU WEST 1階", created_at: "2026-11-03T10:35:50Z" },
  ];
  const l = staffSinceLine({ msgs, aix: [], nowMs: nowS, prevTodos: [{ kind: "check", what: "2物件の募集状況を確認" }] });
  t("staff-refresh: 既定 off", !intakeStaffRefreshOn({}) && intakeStaffRefreshOn({ CONDUCTOR_INTAKE_STAFF_REFRESH: "on" }));
  t("staff-refresh: 前の番の後の文の約束と、前の読みのやる事が果たされたか", l.includes("文で約束「お送り頂きました新大阪グランドハイツと新大阪ステーションビルの募集状況") && l.includes("（前の読みのやる事「2物件の募集状況を確認」は果たした）"), l);
  const l2 = staffSinceLine({ msgs: [...msgs.slice(0, 2), { sender: "staff", text: "[画像]", created_at: "2026-11-03T10:30:00Z", is_aix_generated: true }, msgs[2]], aix: [{ aix_type: "property_check_result", check_pattern: "unavailable", created_at: "2026-11-03T10:30:00Z" }], nowMs: nowS, prevTodos: [{ kind: "aix", what: "結果を AIX で" }] });
  t("staff-refresh: AIX の種類とピッカー・AIX のやる事は果たした", l2.includes("AIX 物件確認した") && l2.includes("募集終了") && l2.includes("は果たした"), l2);
  t("staff-refresh: こちらの動きが無ければ空・今より後は見ない", staffSinceLine({ msgs: [msgs[0], msgs[2]], aix: [], nowMs: nowS }) === "" && staffSinceLine({ msgs, aix: [], nowMs: Date.parse("2026-11-03T10:20:00Z") }) === "");
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
