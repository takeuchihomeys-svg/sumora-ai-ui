// 見張り専用の場面（app/lib/line-watch-turn.ts の watchSceneFromTpo・watchSceneFromCustomer・sceneKeyOf の watchScenes）
// 実行: npx tsx app/lib/__tests__/line-watch-scene-v2.test.ts（自己完結。全 PASS で exit 0）
// 材料: 2026-11-11 本番の「返信:意図:〜」に落ちた番の実物20番（line_watch_turns の id・TPO・お客様の文。お客様の名前は入っていない）
import { sceneKeyOf, watchSceneFromCustomer } from "../line-watch-turn";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq(a: unknown, b: unknown, msg = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} 期待 ${JSON.stringify(b)} 実際 ${JSON.stringify(a)}`); }

const TPO_VIEW = "内見調整（日時・場所の確認・調整。顧客名先頭の簡潔な返し。30〜80字）";
const TPO_CONCERN = "提案後の懸念（往復: ピックアップ約束（宣言のみ・未履行） → 物件への懸念（懸念: 家賃・費用の高さ「高い」）｜台帳: 物件送付0件。100〜160字）";
const TPO_POSITIVE = "前向き反応（物件送付後・内覧のご案内提案）（往復: 物件送付 → 前向き｜台帳: 物件送付13件。60〜130字）";
const TPO_RESULT = "確認結果報告後の応答（往復: 募集状況の確認結果報告 → その他｜台帳: 物件送付13件。60〜130字）";
const TPO_BRING = "持込予告（ピックアップ約束中）（往復: ピックアップ約束（宣言のみ・未履行） → 後日物件を送る予告。80〜160字）";
const TPO_APPLY = "申込後説明（申込・審査・契約手続き中。書類受領／審査進捗／契約案内のいずれかに直接回答し、別物件提案・再ピックアップ・条件ヒアリング・内覧提案は書かない。60〜150字）";
const TPO_WORRY = "不安対応（顧客が審査・費用・手続きに不安。まず不安を受け止め、具体的な安心材料を1つだけ添える。100〜150字以内）";

// [id, TPO, お客様の文, 意図, 期待の場面の鍵]
const CASES: Array<[number, string | null, string, string, string]> = [
  [12993, TPO_VIEW, "大丈夫ですありがとうございます", "positive", "返信:内覧調整"],
  // 残り: 送った物件への不満＋質問（物件への反応）だが TPO が空・文の型が広い＝今まで通り意図に落とす（誤って質問・反応に寄せない）
  [12864, null, "ありがとうございます！\nオートロックはないんですね…。\n\n管理費込10万でも\nこれ以上の物件はなさそうですか？", "desire", "返信:意図:desire"],
  [12717, null, "かしこまりました🙇‍♀️", "chat", "返信:短い了承・お礼"],
  [12648, null, "[画像] 【物件の写真】\n青いシートが物件の上部に設置されている。\n日中の撮影で、曇り空が見える。", "question", "返信:持ち込み物件"],
  // 残り: 来店の頼み（事務所を開けておいて）＝短い礼にしない・意図のまま
  [12536, null, "ありがとうございます！\n開けといてほしいです事務所！", "decision", "返信:意図:decision"],
  [12413, TPO_RESULT, "16:30大丈夫ですよ🙆", "positive", "返信:内覧調整"],
  [12400, null, "よろしくお願いいたします！", "positive", "返信:短い了承・お礼"],
  [12292, null, "イーリス　ウィステリア 1階\nhttps://suumo.jp/chintai/bc_100512347243/\nby SUUMO\nありがとうございます。\nよろしくお願い致します。\n上記物件のお取扱いはございますでしょうか。", "question", "返信:持ち込み物件"],
  [12196, TPO_CONCERN, "プレサンス立売堀アーバンスタイルが\n場所的にちょっと高いかと\n色々と紹介頂ける案件を\nお待ちしております。", "desire", "返信:物件への反応"],
  [12164, TPO_POSITIVE, "長居東のとこめっちゃいいですね", "positive", "返信:物件への反応"],
  [12148, TPO_BRING, "ご丁寧にありがとうございます😊\n\n毎日SUUMOとかみてるので\nまたいいところあったら\n送らせていただきます🙏", "chat", "返信:持ち込み物件"],
  [12062, TPO_VIEW, "ありがとうございます。\nお手数をおかけしてすみません。", "chat", "返信:内覧調整"],
  [11885, null, "申し訳ございません。\nありがとうございます。\nお願いしたいです。", "desire", "返信:短い了承・お礼"],
  [11691, null, "よろしくお願いいたします", "chat", "返信:短い了承・お礼"],
  [11652, TPO_VIEW, "大変申し訳ございません\n忘れていました🙇‍♀️", "chat", "返信:内覧調整"],
  [11390, TPO_CONCERN, "(お願いします)\nTMSノルド 4階\nhttps://suumo.jp/chintai/bc_100534084874/\nby SUUMO\n\nこの物件も礼金が高すぎますが、部屋の\nWEALTH JOTO 1階\nhttps://suumo.jp/chintai/bc_100529095536/\nby SUUMO", "negative", "返信:持ち込み物件"],
  [10930, null, "似たような物件ありますか\n場所は問いません", "desire", "返信:条件提示"],
  [10863, TPO_APPLY, "お願いします！\nお願いします！\n保証会社なんでしたっけお名前\nなるほどわかりました！", "chat", "対象外:申込以降"],
  [10832, TPO_WORRY, "もし3階の1番手の方が否決になってわたしが8階で審査通ったら8階キャンセルして3階とかはできるんですか？", "question", "返信:質問"],
  [10475, null, "[画像] 【物件の画面（ポータル）】\n【空き部屋あり】ヒラソール恵美須【2階】の賃貸\n\n外観\n\n1/20", "question", "返信:持ち込み物件"],
];

// 2026-11-11 監査（scripts/audit-watch-scene-v2.ts・28日・付け替わった全番を目で読んだ）で直した型
CASES.push(
  [5647, null, "少し部屋が狭いのと少し駅から遠いのですみません🙇‍♀️", "negative", "返信:意図:negative"],
  [7913, null, "滞納まだあるのでセーフティ以外やと大変かと思いますがよろしくお願いいたします", "consultation", "返信:意図:consultation"],
  [5335, null, "調べて頂きありがとうございます✨\n\nシャーメゾン田川もよろしくお願いいたします🙇‍♀️", "decision", "返信:意図:decision"],
  [8890, TPO_RESULT, "ご確認ありがとうございます🙇‍♂️\nお待たせして申し訳ございません。\nあと2分ほどで到着します。", "chat", "返信:内覧調整"],
  [6828, TPO_RESULT, "調べて頂きありがとうございます🙇‍♂️", "chat", "返信:短い了承・お礼"],
);
// 2026-11-11 統括役（竹内さんの決まり「申込以降は対象外・申込の意思を言った番までは対象」）: TPO 申込後説明でも申込の手前の言葉だけなら対象
CASES.push(
  [10199, TPO_APPLY, "ありがとうございます！\n承知しました！\n\n2件とも希望通りなので、\n明日のラグゼ新大阪5の入居可能日の確認次第、申し込みさせていただきたいと思っております。\n\n返答いただき次第すぐに決めさせていただきますので、引き続きよろしくお願いいたします。", "decision", "返信:意図:decision"],
  [13260, TPO_APPLY, "かしこまりました、追加します。", "positive", "対象外:申込以降"],
  [0, TPO_APPLY, "申し込みたいです！書類はどれを送ればいいですか？", "question", "対象外:申込以降"],
);
console.log("実物20番＋監査の5番＋申込の手前");
for (const [id, tpo, text, intent, want] of CASES) {
  it(`${id} → ${want}`, () => eq(sceneKeyOf({ tpoLabel: tpo, intent, customerText: text, watchScenes: true }).key, want));
}
console.log("生成側（watchScenes を渡さない）は今まで通り");
for (const [id, tpo, text, intent] of CASES.slice(0, 6)) {
  it(`${id} は 返信:意図:${intent} のまま`, () => eq(sceneKeyOf({ tpoLabel: tpo, intent, customerText: text }).key, `返信:意図:${intent}`));
}
console.log("決まり");
it("今までの6つの場面は TPO のまま（お客様の文で変えない）", () => {
  eq(sceneKeyOf({ tpoLabel: "条件提示（ご条件の受け取り）", customerText: "https://suumo.jp/chintai/bc_1/", watchScenes: true }).key, "返信:条件提示");
});
it("AIX の番は場面を変えない", () => { eq(sceneKeyOf({ brainAction: "property_check_result", customerText: "https://suumo.jp/x", watchScenes: true }).key, "AIX:property_check_result"); });
it("LINE_WATCH_SCENE_V2=off で今まで通り", () => {
  process.env.LINE_WATCH_SCENE_V2 = "off";
  try { eq(sceneKeyOf({ tpoLabel: TPO_VIEW, intent: "positive", watchScenes: true }).key, "返信:意図:positive"); } finally { delete process.env.LINE_WATCH_SCENE_V2; }
});
it("質問の文は短い礼にしない", () => { eq(watchSceneFromCustomer("ありがとうございます、何時からですか？"), null); });
it("長い礼（40字超）は短い礼にしない", () => { eq(watchSceneFromCustomer("ありがとうございます。週末に家族とも相談してみて、また改めてこちらから連絡させてもらいますね。よろしくお願いします"), null); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
