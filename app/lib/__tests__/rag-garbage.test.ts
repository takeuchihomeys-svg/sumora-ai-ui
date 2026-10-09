// RAG の置き場のゴミの型（rag-garbage.ts）— 2026-10-08 竹内さん「RAG 検索を行う際のゴミデータが質を下げている可能性もあるので、その点も調査する」
// ⚠ 本文は監査 scripts/audit-rag-garbage.ts で出た実物（スタッフの送信・ナレッジ）をそのまま使う（お客様の名前は伏せた）。
// 実行: npx tsx app/lib/__tests__/rag-garbage.test.ts（全 PASS で exit 0）
import {
  exampleGarbageTypes, knowledgeGarbageTypes, residualHard, aixTurnReason, dupKey, coreLength, MOJIBAKE_RE, POST_APPLY_TEXT_RE,
  ragIntakeExcludeReason, inApplyWindow, PROPERTY_CARD_RE,
} from "../rag-garbage";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const has = (arr: readonly string[], x: string) => { if (!arr.includes(x)) throw new Error(`expected ${JSON.stringify(arr)} to include ${x}`); };
const not = (arr: readonly string[], x: string) => { if (arr.includes(x)) throw new Error(`expected ${JSON.stringify(arr)} NOT to include ${x}`); };
const eq = <T,>(a: T, b: T) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };

// 実物（line_reply）
const CARD = "🌟エグゼ天神橋 803号室\n（オススメポイント）\n・家賃68,000円・管理費10,000円（合計78,000円）\n・洋室7.1帖\n・Wi-Fi無料";
const ESTIMATE = "【アドバンス難波ラシュレ 602号室】\n初期費用さらに\n🌟70,000円割引させて頂き\n初期費用：276,000円";
const MEETING = "かしこまりました😊！！\n明日11:30にアーバネックス東梅田現地エントランス前お待ち合わせ何卒よろしくお願い致します！！";
const SLOTS = "かしこまりました！！\nお部屋ご案内させていただきます！！\n直近ですと\n9/21日(月曜) 12:00〜16:00\n9/22日(火曜) 12:00〜16:00にてご案内可能です😊！！";
const PROMISE_ESTIMATE = "かしこまりました！！\n2件とも最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！\n何卒よろしくお願い致します😌！！";
const PROMISE_CHECK = "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第ご連絡させて頂きます！！";
const OMATASE = "〇〇さんお待たせ致しました！！\nお送り頂きました物件の募集状況確認させて頂きましたところ募集終了しているお部屋となります。";
const EMPLOYEE = "かしこまりました！！\nお気に召されましたお部屋のオンライン内覧させていただきます！！\n〇〇さんの方でお気に召されましたお部屋はどちらになりますでしょうか😌！！";
const TAKEUCHI = "はい😊！！\n気になる点等出てきましたらいつでもお気軽にご連絡ください！！\n何卒よろしくお願い致します！！";
const POST_APPLY = "お送り頂きありがとうございます！！\nお申込完了させて頂きます！！\n明日管理会社営業次第無事1番手でお申込完了しているか確認出来次第ご連絡させて頂きます！！";
const VIEWING_DAY = "〇〇さんお世話になっております！！\n本日16時お部屋ご案内させて頂きます！\n本日は何卒よろしくお願い致します！！";
const MOJIBAKE = "�����b�ɂȂ��Ă���܂��I�I �����v���U�o�����Ǘ���Г";

describe("AIX の番の文（返信の手本に入っている資料・候補日時）", () => {
  it("物件カード", () => eq(aixTurnReason(CARD), "物件カード"));
  it("見積書の本体", () => eq(aixTurnReason(ESTIMATE), "見積書の本体"));
  it("待ち合わせ", () => eq(aixTurnReason(MEETING), "内覧の待ち合わせ"));
  it("内覧の候補日時", () => eq(aixTurnReason(SLOTS), "内覧の候補日時"));
  it("★ 御見積書を送る約束は返信の番（当てない）", () => eq(aixTurnReason(PROMISE_ESTIMATE), null));
  it("★ 確認の約束は返信の番（当てない）", () => eq(aixTurnReason(PROMISE_CHECK), null));
  it("★ 内覧当日の挨拶は当てない", () => eq(aixTurnReason(VIEWING_DAY), null));
  it("AIX の手本（aix_action）には aix_turn を付けない", () => not(exampleGarbageTypes({ sent_reply: CARD, entry_source: "aix_action" }), "aix_turn"));
  it("返信の手本には付ける", () => has(exampleGarbageTypes({ sent_reply: CARD, entry_source: "line_reply" }), "aix_turn"));
});

describe("お待たせ（返信では使わない・AIX は3時間空いた時だけ可）", () => {
  it("返信の手本は印", () => has(exampleGarbageTypes({ sent_reply: OMATASE, entry_source: "line_reply" }), "omatase"));
  it("★ AIX の手本は印を付けない", () => not(exampleGarbageTypes({ sent_reply: OMATASE, entry_source: "aix_action" }), "omatase"));
  it("今も効く hard に残る（注入の直前に直していない）", () => has(residualHard(exampleGarbageTypes({ sent_reply: OMATASE, entry_source: "line_reply" })), "omatase"));
});

describe("書き手（竹内さん＝A 基準）", () => {
  it("従業員の書き方は writer_b（soft＝hard には入らない）", () => {
    const t = exampleGarbageTypes({ sent_reply: EMPLOYEE, entry_source: "line_reply" });
    has(t, "writer_b"); eq(residualHard(t).length, 0);
  });
  it("竹内さんの書き方は付けない", () => not(exampleGarbageTypes({ sent_reply: TAKEUCHI, entry_source: "line_reply" }), "writer_b"));
});

describe("申込以降（期間＋中身の語の両方）", () => {
  it("期間内で申込の語あり → post_apply", () => has(exampleGarbageTypes({ sent_reply: POST_APPLY }, { isPostApply: true }), "post_apply"));
  it("★ 期間内でも内覧当日の挨拶は付けない", () => not(exampleGarbageTypes({ sent_reply: VIEWING_DAY }, { isPostApply: true }), "post_apply"));
  it("★ 期間外なら申込の語があっても付けない（申込の案内は申込前の番にもある）", () => not(exampleGarbageTypes({ sent_reply: POST_APPLY }, { isPostApply: false }), "post_apply"));
  it("語の線: 緊急連絡先・審査", () => { eq(POST_APPLY_TEXT_RE.test("緊急連絡先情報でお申込み進めさせて頂きます"), true); eq(POST_APPLY_TEXT_RE.test("お部屋ご案内させて頂きます"), false); });
});

describe("テスト会話・文字化け・空・重複", () => {
  it("テスト会話の id", () => has(exampleGarbageTypes({ sent_reply: TAKEUCHI }, { isTestConv: true }), "test_conv"));
  it("会話の id が無い古い行の YUMA 宛て", () => has(exampleGarbageTypes({ sent_reply: "YUMAさん、ご希望のご条件お送り頂きありがとうございます😊！！", conversation_id: null }), "test_conv"));
  it("★ 会話の id がある行は名前だけで付けない", () => not(exampleGarbageTypes({ sent_reply: "YUMAさん、ご希望のご条件お送り頂きありがとうございます😊！！", conversation_id: "x" }), "test_conv"));
  it("文字化け", () => { eq(MOJIBAKE_RE.test(MOJIBAKE), true); has(exampleGarbageTypes({ sent_reply: MOJIBAKE }), "mojibake"); });
  it("★ 普通の文は文字化けにしない", () => { eq(MOJIBAKE_RE.test(TAKEUCHI), false); eq(MOJIBAKE_RE.test(CARD), false); eq(MOJIBAKE_RE.test(SLOTS), false); });
  it("空", () => has(exampleGarbageTypes({ sent_reply: "  " }), "empty"));
  it("重複の正規化は絵文字・記号・呼びかけの揺れを吸収", () => eq(dupKey("〇〇さん はい😊！！何卒よろしくお願い致します！！"), dupKey("はい！！ 何卒よろしくお願い致します😌")));
  it("coreLength は絵文字・記号を数えない", () => eq(coreLength("はい😊！！"), 2));
});

describe("ナレッジ（言い回しとして写る部分だけ見る）", () => {
  it("phrase のお待たせ", () => has(knowledgeGarbageTypes({ category: "phrase", content: "〇〇さんお待たせ致しました！！淀川区周辺全域から〇〇さんご希望のご条件にあったお部屋を探させて頂きました！！" }), "omatase_pos"));
  it("pattern の「」の中のお待たせ", () => has(knowledgeGarbageTypes({ category: "pattern", content: "「〇〇さんお待たせ致しました！！」で開始し、地域名と条件を明記した上で物件をピックアップした旨を伝える" }), "omatase_pos"));
  it("★ 禁止を説明する原則は当てない", () => not(knowledgeGarbageTypes({ category: "pattern", content: "「お待たせ致しました」は返信では使わない" }), "omatase_pos"));
  it("★ pattern の説明の「お客様」は当てない（「」の外）", () => not(knowledgeGarbageTypes({ category: "pattern", content: "「かしこまりました！！」で受け止め、お客様のペースを尊重する一言を添えて締める。" }), "okyaku_pos"));
  it("pattern の「」の中の夜分", () => has(knowledgeGarbageTypes({ category: "pattern", content: "「〇〇さん夜分遅くに失礼致します！！」等の時間帯に応じた挨拶から入る" }), "night_pos"));
  it("答え合わせで外れが多い", () => has(knowledgeGarbageTypes({ category: "phrase", content: "その間気になる点出てきましたら、いつでもお気軽にご連絡ください！！", wrong_count: 3, correct_count: 1 }), "wrong_more"));
  it("★ 外れ1回だけは付けない", () => not(knowledgeGarbageTypes({ category: "phrase", content: "その間気になる点出てきましたら、いつでもお気軽にご連絡ください！！", wrong_count: 1, correct_count: 0 }), "wrong_more"));
});

// ─── 2026-10-09 入口の歯止め（save-reply-example）: 監査 scripts/audit-rag-intake-guard.ts で誤外しだった実物 ───
describe("入口の歯止め ragIntakeExcludeReason", () => {
  const R = (sent: string, inWin = false, env: Record<string, string> = {}) => ragIntakeExcludeReason({ entrySource: "line_reply", sentReply: sent, inPostApplyWindow: inWin }, env);
  it("物件カード", () => eq(R(CARD), "aix_turn:物件カード"));
  it("見積書の本体（【号室】＋初期費用）", () => eq(R(ESTIMATE), "aix_turn:見積書の本体"));
  it("待ち合わせ（時刻あり）", () => eq(R(MEETING), "aix_turn:内覧の待ち合わせ"));
  it("候補日時", () => eq(R(SLOTS), "aix_turn:内覧の候補日時"));
  it("物件オススメ", () => eq(R("お送りさせて頂きましたお部屋の中でもパークフラッツ安堂寺町が築年数も新しく家賃管理費込147,000円で費用を抑える事ができ、〇〇さんにかなりオススメ出来るお部屋となります！！"), "aix_turn:物件オススメ"));
  it("当日の到着の連絡", () => eq(R("〇〇さん 現地エントランス前到着しております！！ ご状況いかがでしょうか😌！！"), "aix_turn:内覧の待ち合わせ"));
  it("★ 23364ddb 会社の FAX・住所（【】の時刻・電話番号は物件カードにしない）", () => eq(R("かしこまりました！！\nもしよろしければFAXでお送りいただく事も可能となります！！\nFAX番号が【06-6732-8378】となります。"), null));
  it("★ e4632e65 【13:30】の時刻", () => eq(PROPERTY_CARD_RE.test("※【13:30】までにご返信がない場合本日のご内覧キャンセルとなります。"), false));
  it("★ 1519f025 現地集合かの質問への答え（時刻なし）", () => eq(R("はい！！ご内覧現地お待ち合わせとなります！！"), null));
  it("★ 1d92b3a4 現地お待ち合わせでのご内覧の誘い（時刻なし）", () => eq(R("〇〇さんよろしければ現地お待ち合わせでお部屋ご内覧頂く事も出来ます！！"), null));
  it("★ 7bdb6f3c お客様の額の復唱＋確認の約束", () => eq(R("かしこまりました😊！！\n他社で家賃＋共益費合計90,000円でのご対応が可能ですと弊社でも必ず出来ますので\n明日念の為管理会社に確認させて頂きます！！"), null));
  it("★ fd3b4a87 初回の挨拶（家賃の幅＋ピックアップの約束）", () => eq(R("〇〇さん、はじめまして😊！！この度ご連絡頂きありがとうございます！！\n杉本町周辺全域から家賃45,000円〜50,000円・1LDKで〇〇さんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！"), null));
  it("★ eff0f875 強調の🌟（条件の聞き取り）", () => eq(R("🌟ご希望の地域や駅御座いますでしょうか😌！！"), null));
  it("★ 6290452b 強調の🌟（入居時期の答え）", () => eq(R("こちら退去後クリーニング、鍵交換完了後ご入居可能です！！\n2週間〜3週間程必要となりますので\n🌟10月中旬以降のご入居となります！！"), null));
  it("★ 約束の文は返信の番", () => { eq(R(PROMISE_ESTIMATE), null); eq(R(PROMISE_CHECK), null); });
  it("申込以降の期間＋申込の状況の連絡 → post_apply", () => eq(R(POST_APPLY, true), "post_apply"));
  it("★ 期間外なら付けない", () => eq(R(POST_APPLY, false), null));
  it("★ 8cc1845c 申込の誘い（お気に召されましたらお申込み）", () => eq(R("お気に召されましたらお部屋のお申込みさせていただきます😊！！", true), null));
  it("★ 1c44a633 お部屋探しのフォーマットご入力", () => eq(R("お手隙の際にお部屋探しフォーマットご入力ください😌！！", true), null));
  it("★ c9da048c 保証会社の説明（審査通過の可能性）", () => eq(R("同居人様が滞納などしていませんでしたら、審査通過の可能性ございます！！", true), null));
  it("★ 6e567524 審査期間の説明は返信の番", () => eq(R("審査期間3日間程となります！！", true), null));
  it("AIX の手本は対象外", () => eq(ragIntakeExcludeReason({ entrySource: "aix_action", sentReply: CARD, inPostApplyWindow: false }, {}), null));
  it("RAG_INTAKE_GUARD=off で戻る", () => eq(R(CARD, false, { RAG_INTAKE_GUARD: "off" }), null));
  it("inApplyWindow", () => {
    eq(inApplyWindow([{ applied_at: "2026-09-01T00:00:00Z", ended_at: null }], "2026-09-10T00:00:00Z"), true);
    eq(inApplyWindow([{ applied_at: "2026-09-01T00:00:00Z", ended_at: "2026-09-05T00:00:00Z" }], "2026-09-10T00:00:00Z"), false);
    eq(inApplyWindow([{ applied_at: "2026-09-12T00:00:00Z", ended_at: null }], "2026-09-10T00:00:00Z"), false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  ✗ " + f); process.exit(1); }
