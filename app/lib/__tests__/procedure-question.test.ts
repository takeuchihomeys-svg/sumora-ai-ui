// 手続きの質問（app/lib/procedure-question.ts）のテスト（自己完結ハーネス）
//
// 2026-09-30 竹内（みこと「本人確認書類がマイナンバー、パスポート両方あるのですが審査通るまでどのくらいの期間見といたらいいですか？」→ 画面は AIX【物件確認した】）
//   「この場合は AIX の確認したではない…申込から審査、入居までの期間と流れを説明する部分、返信すれば大丈夫」
//   「物件が退去予定か即入居可能かで入居日が変わる（物件資料から）。資料を読み取って分からなかったら AIX をそのまま送れるように。資料に記載があればそこで答えて大丈夫」
// 文はすべて実物（scripts/audit-procedure-question.ts・365日・広い候補380通・当たり22通はすべて本文で回答）。会話は id の先頭8文字。
// 資料の行も実物（property_pickups.image_lines・image_details.lines）。
// 実行: npx tsx app/lib/__tests__/procedure-question.test.ts
import {
  detectProcedureQuestion, isProcedureReplyText, procedureNeedsMoveIn, readMoveInMaterial, routeConfirmTopic, detectConfirmTopics,
  resolveProcedurePlan, buildProcedureAnswerNote, procedureReplyDirection, procedureTwoChoiceNote, buildConfirmTopicNote, confirmTopicsAllInMaterial,
} from "../procedure-question";
import { detectAixSceneEvidence } from "../aix-scene-evidence";
import { resolveTwoChoice } from "../two-choice";
import { matchCompanyFacts } from "../company-facts";
import { AIX_STAFF_NOTES } from "../aix-taxonomy";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };

const MIKOTO = "よろしくお願いします。\n本人確認書類がマイナンバー、パスポート両方あるのですが審査通るまでどのくらいの期間見といたらいいですか？";

describe("検出（実物・返信で答える）", () => {
  const hits: Array<[string, string, string[]]> = [
    ["8a77820b みこと 09-30", MIKOTO, ["screening_period", "id_doc"]],
    ["4a79a43e 09-15", "ちなみに審査通るのって何日ぐらいになりますか？", ["screening_period"]],
    ["9b9b81ba 09-12", "いつぐらいまで審査かかるでしょうか？？", ["screening_period"]],
    ["affa98c7 07-28", "審査通ってから最短何日入居ですか？", ["screening_period", "move_in_lead"]],
    ["79f057b5 07-07", "ありがとうございます。\nこちらですと、審査等含め　最短でどれくらいに住むことができますか？", ["screening_period", "move_in_lead"]],
    ["b771af1f 07-29", "前と同じくパスポートでも大丈夫でしょうか？(T ^ T)", ["id_doc"]],
    ["d9d1f3c5 06-01", "パスポートの写真でしたらすぐ用意できるのですが、運転免許証かマイナンバーのみでしょうか？", ["id_doc"]],
    ["2cecfce6 08-24", "初めまして。\n審査に必要なものて、何がありますか？", ["docs"]],
    ["dc35a540 06-04", "すみません、必要書類を今まとめて全て教えて貰っても良いでしょうか。", ["docs"]],
    ["5254182a 07-15", "後は流れはどんな感じですすむかんじでしょうか？", ["flow"]],
  ];
  for (const [name, text, kinds] of hits) it(name, () => { eq(detectProcedureQuestion(text)?.kinds, kinds); ok(isProcedureReplyText(text)); });
});

describe("検出しない・返信に倒さない（実物）", () => {
  const miss: Array<[string, string]> = [
    ["通りやすさ 06-03", "色々言ってすいません。マンションサンパールは審査通りやすいですか？在日韓国人いけますか？"],
    ["通りやすさ 07-13", "こちらの物件他の不動産のTikTokで流れてきて気になってて審査厳しかったりしますか？"],
    ["申込後の進み具合 08-21", "審査結果今日でますかね？"],
    ["オーナー審査 08-02", "オーナー審査は休日明けてからになりますか？🥺"],
    ["入居日の延長 08-17", "最長はいつ入居まで伸ばせますか？"],
    ["費用のかかる順 09-08 d3f7f5f3", "ラグゼのオーナー審査OKなら入居、ダメならオルフェア(審査通れば)、グラン(審査通れば)、ウルバーノと費用のかかる順に進めるのはありですか"],
    ["質問でない 07-14 6fc6828c", "承知しました\nマイナンバーカード、保険証が家に置いていて何時に帰宅できるかわからないので最悪、明日申し込みさせて頂きます。すみません"],
    ["保証会社そのもの みこと 09-30", "保証会社はどこですか？"],
    ["アリバイ会社 みこと 09-30", "夜職なのですがアリバイ会社使えますか？"],
    ["画像の書き起こし", "[画像] 御見積書\n御契約完了までの払い込み、ならびに必要書類を下記の通り御準備頂きますよう"],
    ["内覧したい", "レジュールアッシュ内見可能ですか？"],
  ];
  for (const [name, text] of miss) it(name, () => eq(isProcedureReplyText(text), false));
  it("通りやすさが混ざる（滞納があった場合厳しい流れに）は検出しても返信に倒さない", () => {
    const t = "保証会社の日本セーフティーに関しまして審査の際もし以前ほかのCGO加盟の保証会社で滞納があった場合厳しい流れになりますでしょうか？";
    eq(detectProcedureQuestion(t)?.passability, true);
    eq(isProcedureReplyText(t), false);
  });
});

describe("場面の証拠（S3 審査・保証会社の確認にしない）", () => {
  it("みこと: 証拠なし（物件確認の依頼ではない）", () => {
    eq(detectAixSceneEvidence({ latestCustomerTurn: MIKOTO, hasCustomerImage: false, sentPropertyCount: 5 }), null);
  });
  it("「この物件の審査通るまでどのくらいかかりますか」は S3 にしない", () => {
    eq(detectAixSceneEvidence({ latestCustomerTurn: "この物件の審査通るまでどのくらいかかりますか？", hasCustomerImage: false, sentPropertyCount: 1 })?.scene ?? null, null);
  });
  it("「保証会社の審査はどのくらいかかりますか」は 保証会社について にしない", () => {
    eq(detectAixSceneEvidence({ latestCustomerTurn: "保証会社の審査はどのくらいかかりますか？", hasCustomerImage: false, sentPropertyCount: 1 })?.candidateAction ?? null, null);
  });
  it("「パスポートでも大丈夫でしょうか？」（07-29 b771af1f）は条件の変更（S7）にしない", () => {
    eq(detectAixSceneEvidence({ latestCustomerTurn: "前と同じくパスポートでも大丈夫でしょうか？(T ^ T)", hasCustomerImage: false, sentPropertyCount: 5 }), null);
  });
  it("従来どおり: 「家賃8万でも大丈夫です」は条件の変更（S7）", () => {
    eq(detectAixSceneEvidence({ latestCustomerTurn: "家賃8万でも大丈夫です", hasCustomerImage: false, sentPropertyCount: 5 })?.scene, "S7_condition_change");
  });
  it("従来どおり: 「保証会社はどこですか？」は 保証会社について", () => {
    eq(detectAixSceneEvidence({ latestCustomerTurn: "保証会社はどこですか？", hasCustomerImage: false, sentPropertyCount: 1 })?.candidateAction, "guarantor_info");
  });
  it("従来どおり: 「この物件審査厳しいですか」は S3（保証会社・審査面）", () => {
    eq(detectAixSceneEvidence({ latestCustomerTurn: "この物件審査厳しいですか？", hasCustomerImage: false, sentPropertyCount: 1 })?.reasonCode, "screening_question");
  });
});

// 資料の行（実物）
const LEAVING_DATE = ["間取り: 1K", "現況: 退去予定(9/30)", "入居可能日: 2026年10月下旬", "駐車場: 空車確認は管理組合", "ペット: 不可", "保証会社: 保証会社利用必須"]; // レジュールアッシュ梅田レジデンス 1106
const IMMEDIATE = ["間取り: 1LDK", "現況: 空室", "入居可能日: 即入", "ペット: 相談", "保証会社: 利用必須"]; // レジュールアッシュ谷町四丁目グランクラス 0703
const OCCUPIED_DATE = ["間取り: 1K", "現況: 居住中", "入居可能日: 2026年11月15日", "保証会社: 利用必須, ジェイリース"]; // シャトレ下新庄 302（みことに送った画像の読み取り）
const PET_CONSULT = ["現況: 退去予定", "入居可能日: 2026年11月中旬", "駐車場: 敷地内駐車場 駐車場", "ペット: ペット飼育相談可(小型犬または猫2匹まで)"]; // レジュールアッシュ難波MINAMI-II 809
const PDF_CONSULT = ["現況/入居時期 空室 / 相談", "※入居可能日未定"]; // aix-material-facts の実物（YUMA の徹底テスト）

describe("資料の入居時期を読む", () => {
  it("退去予定＋入居可能日の日付 → date（資料の文字のまま）", () => {
    const m = readMoveInMaterial(LEAVING_DATE);
    eq(m.kind, "date"); eq(m.lines, ["現況: 退去予定(9/30)", "入居可能日: 2026年10月下旬"]);
  });
  it("即入 → immediate", () => eq(readMoveInMaterial(IMMEDIATE).kind, "immediate"));
  it("居住中＋日付 → date", () => eq(readMoveInMaterial(OCCUPIED_DATE).kind, "date"));
  it("空室 / 相談・入居可能日未定 → unknown（空室だけでは即入居ではない）", () => eq(readMoveInMaterial(PDF_CONSULT).kind, "unknown"));
  it("退去予定だけ（物件確認の結果）→ leaving", () => eq(readMoveInMaterial(["現況: 退去予定（物件確認の結果）"]).kind, "leaving"));
  it("居住中なのに即入居可（食い違い）→ 即入居にしない", () => eq(readMoveInMaterial(["現況: 居住中", "入居可能日: 即入居可"]).kind, "leaving"));
  it("行が無い → unknown・行は空", () => eq(readMoveInMaterial(["間取り: 1K", "所在階: 2階"]), { lines: [], kind: "unknown" }));
  it("「入居可能日: ー」は記載なし", () => eq(readMoveInMaterial(["入居可能日: ー"]).kind, "unknown"));
});

describe("「確認した」系: 資料に記載あり→資料／無し→AIX【確認した】", () => {
  it("入居可能日: 日付あり → 資料", () => eq(routeConfirmTopic("move_in", LEAVING_DATE).route, "material"));
  it("入居可能日: 即入 → 資料", () => eq(routeConfirmTopic("move_in", IMMEDIATE).route, "material"));
  it("入居可能日: 相談・未定 → 確認", () => eq(routeConfirmTopic("move_in", PDF_CONSULT).route, "confirm"));
  it("入居可能日: 記載なし → 確認", () => eq(routeConfirmTopic("move_in", []).route, "confirm"));
  it("ペット: 不可 → 資料", () => eq(routeConfirmTopic("pet", LEAVING_DATE).route, "material"));
  it("ペット: 相談 → 確認", () => eq(routeConfirmTopic("pet", IMMEDIATE).route, "confirm"));
  it("ペット: 相談可(小型犬または猫2匹まで) → 確認（種類・頭数は確認が要る）", () => eq(routeConfirmTopic("pet", PET_CONSULT).route, "confirm"));
  it("ペット: 記載なし → 確認", () => eq(routeConfirmTopic("pet", OCCUPIED_DATE).route, "confirm"));
  it("駐車場: 空車確認は管理組合 → 確認", () => eq(routeConfirmTopic("parking", LEAVING_DATE).route, "confirm"));
  it("駐車場: 敷地内駐車場 → 確認（空きは確認が要る）", () => eq(routeConfirmTopic("parking", PET_CONSULT).route, "confirm"));
  it("駐車場: 無 → 資料", () => eq(routeConfirmTopic("parking", ["駐車場: 無"]).route, "material"));
  it("全部資料にある時だけ返信に倒す", () => {
    eq(confirmTopicsAllInMaterial([routeConfirmTopic("move_in", LEAVING_DATE), routeConfirmTopic("pet", LEAVING_DATE)]), true);
    eq(confirmTopicsAllInMaterial([routeConfirmTopic("move_in", LEAVING_DATE), routeConfirmTopic("parking", LEAVING_DATE)]), false);
    eq(confirmTopicsAllInMaterial([]), false);
  });
  it("聞いた項目の検出", () => {
    eq(detectConfirmTopics("ペットは飼えますか？"), ["pet"]);
    eq(detectConfirmTopics("駐車場ありますか？あと猫飼っても大丈夫ですか"), ["pet", "parking"]);
    eq(detectConfirmTopics("駐車場付きの物件でお願いします"), []);
    eq(detectConfirmTopics("いつから入居できますか？", { moveInAsked: true }), ["move_in"]);
  });
  it("材料の文: 資料の文字がそのまま入る・2つの AIX の区別が入る", () => {
    const n = buildConfirmTopicNote({ name: "レジュールアッシュ梅田レジデンス", roomNo: "1106" }, [routeConfirmTopic("move_in", LEAVING_DATE), routeConfirmTopic("parking", LEAVING_DATE)]);
    ok(n.includes("入居可能日: 2026年10月下旬")); ok(n.includes("現況: 退去予定(9/30)"));
    ok(n.includes("AIX【確認した（条件・交渉）→駐車場】")); ok(n.includes("物件そのもの"));
  });
});

describe("答え方（返信／2択）", () => {
  const q = detectProcedureQuestion(MIKOTO)!;
  const target = { name: "レジュールアッシュ北大阪 GRAND STAGE", roomNo: "206" };
  it("みこと（資料に入居時期なし）→ 2択・入居日は断言しない", () => {
    const p = resolveProcedurePlan({ question: q, target, materialLines: [] });
    eq(p.mode, "two_choice");
    const n = buildProcedureAnswerNote(p);
    ok(n.includes("3日〜10日程")); ok(n.includes("マイナンバーカードがあればそれでお申込みして審査をかけられる"));
    ok(n.includes("断言しない")); ok(n.includes("AIX【確認した→入居可能日】"));
    ok(!n.includes("最短で2週間程がご入居の目安"), "資料で分からない時は『最短2週間』を材料に入れない");
    ok(procedureTwoChoiceNote(p).includes("管理会社からの回答が届いた場面ではありません"));
    ok(procedureReplyDirection(p).includes("このお部屋の入居可能日は断言しない"));
  });
  it("退去予定＋入居可能日（資料あり）→ 返信・資料の値のまま", () => {
    const p = resolveProcedurePlan({ question: q, target, materialLines: LEAVING_DATE });
    eq(p.mode, "reply");
    const n = buildProcedureAnswerNote(p);
    ok(n.includes("現況: 退去予定(9/30)／入居可能日: 2026年10月下旬")); ok(n.includes("資料の入居可能日のとおり"));
    ok(!n.includes("最短で2週間程がご入居の目安"), "退去予定の物件に『最短2週間』を渡さない");
  });
  it("即入居（資料あり）→ 返信・最短2週間程", () => {
    const p = resolveProcedurePlan({ question: q, target, materialLines: IMMEDIATE });
    eq(p.mode, "reply");
    ok(buildProcedureAnswerNote(p).includes("資料に即入居の記載あり")); ok(buildProcedureAnswerNote(p).includes("最短で2週間程"));
  });
  it("対象のお部屋が無い → 返信（一般の流れ）", () => {
    const p = resolveProcedurePlan({ question: q, target: null, materialLines: [] });
    eq(p.mode, "reply"); eq(p.moveIn, null);
  });
  it("必要書類・本人確認書類だけ → 返信（入居時期は見ない）", () => {
    const d = detectProcedureQuestion("前と同じくパスポートでも大丈夫でしょうか？")!;
    eq(procedureNeedsMoveIn(d), false);
    eq(resolveProcedurePlan({ question: d, target, materialLines: [] }).mode, "reply");
  });
  it("2択の判定: 手続きの質問で入居時期が分からない時は段階を問わず2択", () => {
    eq(resolveTwoChoice({ customerText: MIKOTO, checkpointStage: "viewing", sentPropertyCount: 5, finalAix: "property_check_result", conditionChangeType: null, customerIntent: "question", procedureMoveInUnknown: true }),
      { two: true, reason: "procedure_move_in_unknown" });
    eq(resolveTwoChoice({ customerText: MIKOTO, checkpointStage: "viewing", sentPropertyCount: 5, finalAix: null, conditionChangeType: null, customerIntent: "question" }).two, false);
  });
});

describe("会社の事実・説明の帯", () => {
  it("みこと: screening_flow が当たる（3日〜10日・マイナンバーカード）", () => {
    const f = matchCompanyFacts(MIKOTO).find((x) => x.id === "screening_flow");
    ok(f); ok(f!.fact.includes("3日〜10日程")); ok(f!.fact.includes("マイナンバーカードがあれば"));
  });
  it("必要書類だけは apply_docs（screening_flow は渡さない）", () => {
    eq(matchCompanyFacts("申込に必要な書類は何ですか？").map((x) => x.id), ["apply_docs"]);
  });
  it("通りやすさ・保証会社の質問には渡さない", () => {
    eq(matchCompanyFacts("こちらの物件審査厳しかったりしますか？").some((x) => x.id === "screening_flow"), false);
    eq(matchCompanyFacts("保証会社はどこですか？").some((x) => x.id === "screening_flow"), false);
  });
  it("物件確認したの帯は「回答が届いた場面」と言い切らない・2つの AIX の区別を書く", () => {
    const n = AIX_STAFF_NOTES.property_check_result;
    ok(!n.includes("回答が届いた場面です")); ok(n.includes("物件そのもの")); ok(n.includes("管理会社に確認が要る事"));
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
