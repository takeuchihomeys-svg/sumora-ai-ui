// 2026-09-24 竹内「改善する。DeepSeek でテストする」: AIX【物件ピックアップした】の入口（今回の物件の事実・履歴の印）と出口（注意）
// 実行: npx tsx app/lib/__tests__/pickup-send-facts.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 本文は YUMA（テスト用の会話）の実物をそのまま使う
import {
  extractLayouts, parsePickupFact, buildPickupFactsNote, labelHistoryTextForAix, isInternalPropertyCard, isPastPickupSend,
  findPickupSendConflicts, findUncheckedClaimInPickupLine, INTERNAL_CARD_PLACEHOLDER, PAST_PICKUP_SEND_LABEL, labelsPastPickupFor,
} from "../pickup-send-facts";
import { DEADLINE_SUPPORT_LINE, INSERTED_PROMISE_LINES } from "../property-send-match";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: boolean, msg = "expected true") { if (!v) throw new Error(msg); }

// ── 実物（YUMA・2026-09-24 の売上サポのピックアップ行）──
const ROW_DAIRE = { summary_text: "【2🌟★】ダイレ・エヌ\n80,000円 10,500円\n1LDK 39.23㎡\nAD 1ヶ月", image_lines: ["間取り: 1LDK", "所在階: 1階", "ペット: ペット相談・小型犬1匹飼育可"] };
const ROW_SERENITY = { summary_text: "【1🌟】セレニティ照ヶ丘矢田A棟\n75,000円 5,000円\n1LDK 35.19㎡", image_lines: ["間取り: 1LDK", "所在階: 3階部分"] };
const ROW_ABELIA = { summary_text: "【3🌟】Abelia(アベリア)\n83,000円 8,000円\n1LDK 39.13㎡\n", image_lines: ["間取り: 1LDK[LDK11.9 x 洋4.4]", "所在階: 3階部分"] };
// 旧 UI が YUMA に送った社内の説明文（AD 入り）
const CARD_SENT = "【1🌟★】ダイレ・エヌ\n80,000円 10,500円\n1LDK 39.23㎡\nAD 1ヶ月";
// DeepSeek が 9/22 に作って送った前回の送付の文（今回それを写した）
const PAST_SEND = "YUMAさんお待たせ致しました！！\n\n大阪市西区・浪速区周辺から1K・家賃7万円以内でYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお気に召されたお部屋ございましたら、駐車場の空き状況も含めて確認させて頂きます！！\n\nお手隙の際にご査収ください😌！！";
// 2026-09-24 の DeepSeek 生成（会話を合わせる）＝前回の文の写し
const GEN_COPIED = PAST_SEND;
// 2026-09-24 の DeepSeek 生成（通常）＝問題なし
const GEN_OK = "YUMAさんお待たせ致しました！！\n\nご希望のご条件に合ったお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";

console.log("\n■ 事実を読む（AD・利益・🌟は読まない）");
it("間取りは画像の読み取りから・家賃は説明文の2行目の1つ目", () => {
  eq(parsePickupFact(ROW_DAIRE), { layout: "1LDK", rentYen: 80000 });
  eq(parsePickupFact(ROW_SERENITY), { layout: "1LDK", rentYen: 75000 });
  eq(parsePickupFact(ROW_ABELIA), { layout: "1LDK", rentYen: 83000 });
});
it("画像の読み取りが無ければ説明文の3行目の間取り", () => {
  eq(parsePickupFact({ summary_text: ROW_DAIRE.summary_text, image_lines: null }), { layout: "1LDK", rentYen: 80000 });
});
it("行が空なら何も読まない", () => { eq(parsePickupFact({}), { layout: null, rentYen: null }); });
it("AD の行（AD 50,000円）を家賃と読まない", () => {
  eq(parsePickupFact({ summary_text: "【1】X\nAD 50,000円\n1K 20㎡" }).rentYen, null);
});
it("間取りの抜き出し（全角・ワンルーム）", () => {
  eq(extractLayouts("１ＬＤＫと1K、2SLDK・ワンルーム"), ["1LDK", "1K", "2SLDK", "1R"]);
  eq(extractLayouts("11.9帖・DK"), []);
});

console.log("\n■ 生成に渡すブロック");
it("3件の間取り・家賃の範囲が入り、AD・🌟・利益・物件名は入らない", () => {
  const note = buildPickupFactsNote([ROW_SERENITY, ROW_DAIRE, ROW_ABELIA].map(parsePickupFact));
  ok(note.includes("3件"), note);
  ok(note.includes("1LDK"), note);
  ok(note.includes("家賃7.5万円〜8.3万円"), note);
  for (const bad of ["AD", "🌟", "★", "ダイレ", "セレニティ", "利益", "10,500"]) ok(!note.includes(bad), `含んではいけない: ${bad}\n${note}`);
});
it("事実が無ければ空", () => { eq(buildPickupFactsNote([{ layout: null, rentYen: null }]), ""); eq(buildPickupFactsNote([]), ""); });

console.log("\n■ 入口: 履歴の印");
it("社内の説明文（旧 UI が送った実物）は中身ごと伏せる", () => {
  ok(isInternalPropertyCard(CARD_SENT));
  eq(labelHistoryTextForAix("staff", CARD_SENT), INTERNAL_CARD_PLACEHOLDER);
  ok(isInternalPropertyCard("【1】ダイレ・エヌ 80,000円 10\nAD 1ヶ月"), "番号だけの見出し＋AD の行");
});
it("前回の物件送付の文には印を付け、本文は残す", () => {
  ok(isPastPickupSend("staff", PAST_SEND));
  const l = labelHistoryTextForAix("staff", PAST_SEND);
  ok(l.startsWith(PAST_PICKUP_SEND_LABEL), l);
  ok(l.includes("大阪市西区・浪速区周辺"), l);
});
it("お客様の行は触らない（お客様が貼った資料の OCR に AD があっても）", () => {
  eq(labelHistoryTextForAix("customer", CARD_SENT), CARD_SENT);
  eq(labelHistoryTextForAix("customer", PAST_SEND), PAST_SEND);
});
it("ふつうのスタッフの文は触らない", () => {
  const t = "YUMAさん\nお手隙の際にこちらの電話をかけるボタンよりお電話お願い致します😊！！";
  eq(labelHistoryTextForAix("staff", t), t);
  const cost = "今回の物件は管理会社様から広告料として家賃1ヶ月分頂けるため、その分を初期費用から還元させて頂きます！！";
  eq(labelHistoryTextForAix("staff", cost), cost);
  const promise = "かしこまりました！！\n明日管理会社に確認させて頂きます！！";
  eq(labelHistoryTextForAix("staff", promise), promise);
});

console.log("\n■ 出口: 注意だけ（本文は書き換えない）");
const FACTS = [ROW_SERENITY, ROW_DAIRE, ROW_ABELIA].map(parsePickupFact);
const ALLOWED = [DEADLINE_SUPPORT_LINE, ...INSERTED_PROMISE_LINES];
it("今回の実物（会話を合わせる）: 1K・家賃7万円以内・駐車場の約束の写しを3つとも注意", () => {
  const notes = findPickupSendConflicts(GEN_COPIED, FACTS, [PAST_SEND], ALLOWED);
  eq(notes.length, 3);
  ok(notes[0].includes("1K") && notes[0].includes("1LDK"), notes[0]);
  ok(notes[1].includes("家賃7万円以内") && notes[1].includes("7.5万円"), notes[1]);
  ok(notes[2].includes("駐車場の空き状況"), notes[2]);
});
it("今回の実物（通常）: 注意なし", () => { eq(findPickupSendConflicts(GEN_OK, FACTS, [PAST_SEND], ALLOWED), []); });
it("正しい間取り・家賃の上限は注意しない", () => {
  eq(findPickupSendConflicts("西区から1LDK・家賃9万円以内でYUMAさんにオススメできるお部屋ピックアップさせて頂きました！！", FACTS, [], ALLOWED), []);
});
it("事実が無い時（売上サポ以外）は間取り・家賃を見ない", () => {
  eq(findPickupSendConflicts(GEN_COPIED, [], [], ALLOWED), []);
});
it("決定論で差し込む約束（代理契約・間に合う）は前回と同じでも注意しない", () => {
  const past = `〇〇さん\n\n${INSERTED_PROMISE_LINES[0]}\n${DEADLINE_SUPPORT_LINE}\nお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！`;
  const gen = `〇〇さん\n\n${DEADLINE_SUPPORT_LINE}\n\nお部屋ピックアップさせて頂きました！！\n\n${INSERTED_PROMISE_LINES[0]}\nお手隙の際にご査収ください😌！！`;
  eq(findPickupSendConflicts(gen, [], [past], ALLOWED), []);
});

it("ピックアップ行の「駐車場の空き状況も含めて」（DeepSeek 実物・pickup_ids なし）を注意", () => {
  const gen = "YUMAさんお待たせ致しました！！\n\n駐車場の空き状況も含めて、YUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";
  eq(findUncheckedClaimInPickupLine(gen), "駐車場の空き状況も含め");
  eq(findPickupSendConflicts(gen, [], [], ALLOWED).length, 1);
});
it("「駐車場空きあり」「ペット可」等の条件の言い方は注意しない", () => {
  eq(findUncheckedClaimInPickupLine("梅田周辺から駐車場空きありのペット可のお部屋ピックアップさせて頂きました！！"), null);
  eq(findUncheckedClaimInPickupLine("審査通過しやすいお部屋ピックアップさせて頂きました！！"), null);
});
// 2026-09-24 反証: 前回の送付の印は物件ピックアップ・物件オススメだけ。物件確認した等は前回の物件が話題なので付けない。社内の説明文はどの AIX でも伏せる
it("前回の送付の印は property_send / property_recommendation だけ", () => {
  eq(labelsPastPickupFor("property_send"), true);
  eq(labelsPastPickupFor("property_recommendation"), true);
  eq(labelsPastPickupFor("property_check_result"), false);
  eq(labelsPastPickupFor("viewing_invite"), false);
  eq(labelsPastPickupFor("estimate_sheet"), false);
});
it("印を付けない AIX でも、社内の説明文は伏せる・前回の送付の文はそのまま", () => {
  const past = "YUMAさんお待たせ致しました！！\n\n大阪市西区・浪速区周辺から1K・家賃7万円以内でYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";
  eq(labelHistoryTextForAix("staff", past, { labelPastPickup: false }), past);
  ok(labelHistoryTextForAix("staff", past, { labelPastPickup: true }).startsWith(PAST_PICKUP_SEND_LABEL));
  eq(labelHistoryTextForAix("staff", ROW_DAIRE.summary_text, { labelPastPickup: false }), INTERNAL_CARD_PLACEHOLDER);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
