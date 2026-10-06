// 会社として答えが決まっている事実を、聞かれた時だけ渡す関数のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/company-facts.test.ts
import { buildCompanyFactsNote, matchCompanyFacts, COMPANY_FACTS } from "../company-facts";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const falsy = (a: unknown, m = "") => { if (a) throw new Error(`expected falsy ${m}`); };
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ids = (t: string) => matchCompanyFacts(t).map((f) => f.id);

// AI が実際に作文していた実物（通常返信の大幅書き直しから）
describe("AI が作文していた場面で、事実が渡る", () => {
  it("店舗へ伺いたい → 店舗の事実", () =>
    truthy(ids("当日はそちらの店舗へ伺い、ご相談させていただきながら、ほかの物件もご紹介いただければと思います").includes("store")));
  it("緊急連絡先は必ず必要ですか → 緊急連絡先の事実", () =>
    truthy(ids("緊急連絡先は必ず必要ですか？").includes("emergency_contact")));
  it("室内写真が欲しい → 写真の事実", () =>
    truthy(ids("これ室内写真欲しいです").includes("room_photo")));
  it("キャンセルできるか → キャンセルの事実", () =>
    truthy(ids("キャンセル料はかかりますか？").includes("cancel")));
  it("遠方で行けない → 内覧方法の事実", () =>
    truthy(ids("東京在住なのですが内見はどうすればいいですか").includes("viewing_method")));
  it("申込に何が必要か → 申込の事実", () =>
    truthy(ids("申込には何が必要ですか？").includes("apply_docs")));
  it("月末入居の家賃 → 日割の事実", () =>
    truthy(ids("月末に入居したら家賃はどうなりますか？").includes("prorated_rent")));
});

// 2026-10-02 竹内「仮押さえ 会社の事実として入れる・保証会社審査通過まで」: お客様の実際の言い方（365日・scripts/audit-hold-room-fact.ts）
describe("仮押さえ（お申込みでお部屋を抑える・保証会社の審査通過まではキャンセル料なし）", () => {
  for (const t of [
    "おはようございます エスリード長居の件ですが、仮おさえしてもらうのは、可能でしょうか？？",
    "KANOASIAってもし部屋止めして欲しいって言ったら部屋止めとかできるんでしょうか？",
    "抑えるだけ抑えててもいいんですか？",
    "どのくらいの期間抑えておくこと可能ですか？？",
    "こちらの物件、念の為抑えていただく事可能でしょうか？🙇‍♂️",
    "サンメゾンをキープできるならキープしたいです。",
  ]) it(`当たる: ${t.slice(0, 24)}`, () => truthy(ids(t).includes("hold_room")));
  for (const t of [
    "初期費用なるべく抑えたいです",
    "旭区周辺で家賃もう少し抑えたいです。",
    "こちらの初期費用は抑えること厳しいですか？",
    "⑦【初期費用の限度額】⇒特に決まっては無いけどなるべく安い方が早く入居できるので安く抑えられるところで",
  ]) it(`費用を抑える話には当てない: ${t.slice(0, 24)}`, () => falsy(ids(t).includes("hold_room")));
  it("事実は『管理会社に確認』で返さず本文で答える・保証会社の審査通過まで", () => {
    const f = COMPANY_FACTS.find((x) => x.id === "hold_room")!;
    truthy(/お申込み/.test(f.fact) && /保証会社の審査が通過するまで/.test(f.fact) && /管理会社に確認します」ではなく/.test(f.fact));
  });
});

// ⚠ 誤爆0の確認: 関係ない会話には一切出さない（設計知見「当たらない会話には影響しない」）
describe("関係ない発言では出さない", () => {
  const none = [
    "ありがとうございます！",
    "この物件の初期費用が知りたいです",
    "もう少し駅に近いお部屋はありますか？",
    "9月中に引っ越したいです",
    "ペット可のお部屋でお願いします",
    "はい、よろしくお願いします",
  ];
  for (const t of none) it(`「${t}」→ 空`, () => eq(buildCompanyFactsNote(t), ""));
  it("空文字・null", () => { eq(buildCompanyFactsNote(""), ""); eq(buildCompanyFactsNote(null), ""); });
});

// ⚠ 竹内「物件によって保証会社に違いあるから適当に答えない」
describe("物件によって変わる事を事実にしない", () => {
  it("保証会社の名前を持たない", () => {
    for (const f of COMPANY_FACTS) falsy(/(エポス|全保連|GTN|ジャックス|オリコ|日本セーフティ|LICC|独立系|信販系)/.test(f.fact), f.id);
  });
  it("金額を持たない（仲介手数料はブランドで違うので入れない。手数料率3.24%は全物件共通なので可）", () => {
    for (const f of COMPANY_FACTS) falsy(/[0-9０-９][0-9０-９,，]{2,}\s*円|仲介手数料.{0,6}(無料|0円)/.test(f.fact), `${f.id}: ${f.fact}`);
  });
  it("物件名・号室を持たない", () => {
    for (const f of COMPANY_FACTS) falsy(/\d{3,4}号室|[ァ-ヶー]{5,}\s*\d/.test(f.fact), f.id);
  });
  it("「物件によって変わる事は言い切らない」を必ず添える", () =>
    truthy(buildCompanyFactsNote("緊急連絡先は必要ですか").includes("物件によって変わる")));
  it("連帯保証人と緊急連絡先を分けて書く（竹内さんのルール）", () =>
    truthy(buildCompanyFactsNote("緊急連絡先について").includes("連帯保証人")));
  // 2026-09-26 竹内さん決定（保証会社の知識を直す）
  it("緊急連絡先は確認の電話だけ・支払い義務は無い", () => {
    const f = COMPANY_FACTS.find((x) => x.id === "emergency_contact")!.fact;
    truthy(/確認のお電話が入るだけ/.test(f), f);
    truthy(/支払い義務は無い/.test(f), f);
  });
  it("審査期間は「3日〜10日」（旧「3〜5日」「3日〜1週間」を持たない）", () => {
    const all = COMPANY_FACTS.map((x) => x.fact).join("\n");
    truthy(all.includes("3日〜10日"), "3日〜10日");
    falsy(/3〜5日|3日〜5日|3日〜1週間/.test(all), all);
  });
  // 2026-09-26 竹内さん決定: 種類は3つ（独立系・信販系・信用系・LICC の会社は信用系）で、会社ごとの種類は guarantor-companies.ts のマスタ1本。
  //   会社の事実（company-facts）には種類を入れない（入れると取り違えがマスタと食い違う＝fd989546 で信用系を信販系と書いた事故の再発を防ぐ）
  it("保証会社の種類名（独立系・信販系・信用系・旧の LICC系）を持たない（種類はマスタ1本）", () => {
    for (const f of COMPANY_FACTS) falsy(/独立系|LICC系|信販系|信用系/.test(f.fact), f.id);
  });
});

// ── 2026-09-23 S6 の実測（今月の当たり76通を全部読んだ）: 当たりの50%が [画像] の書き起こし ──
describe("[画像] の書き起こしには当てない（誤当たりの50%）", () => {
  const tiktok = "[画像] 初期費用ゼロ（前家賃だけ）\n1LDK 6万円 ペット可\n無料 お問い合わせ";
  const suumo = "[画像] 取り扱い店舗\n受付店舗\n間取り/画像一覧・室内写真\n7.9万円/管理費 -";
  it("TikTok の「初期費用ゼロ（前家賃だけ）」→ 日割に当てない", () => eq(ids(tiktok).length, 0));
  it("SUUMO の「取り扱い店舗」「室内写真」→ 店舗・写真に当てない", () => eq(ids(suumo).length, 0));
  it("配列: 画像の通は外し、文の通だけ当てる（brain-core の3通）", () =>
    eq(ids([tiktok, "キャンセル料はかかりますか？", suumo].join("\n")).length, 0),
  );
  it("配列で渡すと文の通は当たる", () => {
    const hit = matchCompanyFacts([tiktok, "キャンセル料はかかりますか？", suumo]).map((f) => f.id);
    truthy(hit.includes("cancel"));
    falsy(hit.includes("prorated_rent"));
    falsy(hit.includes("store"));
  });
  it("通の区切り（MSG_SEP）でも画像の通だけ外れる", () => {
    const hit = matchCompanyFacts(`${tiktok}\n⁣\n店舗に伺えますか？`).map((f) => f.id);
    truthy(hit.includes("store"));
    falsy(hit.includes("prorated_rent"));
  });
});

// ── 2026-09-23 S6 の当たり漏れ（お客様が聞き、スタッフが事実で答えたのに当たらなかった3通）──
describe("当たり漏れを拾う", () => {
  it("オンラインで内覧などは可能でしょうか？ → 内覧方法", () =>
    truthy(ids("オンラインで内覧などは可能でしょうか？").includes("viewing_method")));
  it("写真お願いできますか？ → 写真", () => truthy(ids("写真お願いできますか？").includes("room_photo")));
  // 2026-09-23 竹内: 写真の判定はブレインの場面と同じ isRoomPhotoRequest（反証で見つかった書類の写真の誤当たりを外す）
  it("申込書類の記入箇所の写真・明細書の画像・内定通知の画像 → 写真の事実を渡さない", () => {
    falsy(ids("記入が必要な箇所の写真もう一度送っていただけないでしょうか").includes("room_photo"));
    falsy(ids("初期費用の明細書を\nこのよう形で画像でもお送りいただくことは可能でしょうか…？").includes("room_photo"));
    falsy(ids("内定通知の画像をテンプしないといけないみたいなんですが、もらえますか？").includes("room_photo"));
    falsy(ids("この写真のような、物件があれば幸いです").includes("room_photo"));
  });
  it("写真の事実は AIX【物件確認した→室内写真を確認した】から送る流れ・撮影の約束もしない", () => {
    const s = buildCompanyFactsNote("お部屋の画像ありますでしょうか？");
    truthy(s.includes("AIX【物件確認した→室内写真を確認した】")); truthy(s.includes("撮影して送るとも約束しない"));
  });
  it("親と縁切れてる場合でも親の連絡先いりますか？ → 緊急連絡先", () =>
    truthy(ids("親と縁切れてる場合でも親の連絡先いりますか？").includes("emergency_contact")));
  it("緊急連絡先欄の記入そのもの（改行あり）は渡さない", () =>
    falsy(ids("緊急連絡先\n氏名: 山田太郎\nフリガナ: ヤマダタロウ\n続柄: 父\n生年月日: 1960/1/1").includes("emergency_contact")));
});

// ── 2026-09-23 S7 の実測: 埋もれた質問「クレカ払いはできますか」に答えない／事実違い ──
describe("クレジットカード払い（実送信25通で一貫: 対応・手数料3.24%・分割はカードのみ）", () => {
  it("あとクレカ払いはできますか？ → 事実が渡る", () => truthy(ids("あとクレカ払いはできますか？").includes("credit_card")));
  it("初期費用カード決済可能ですか → 渡る", () => truthy(ids("初期費用カード決済可能ですか？").includes("credit_card")));
  it("分割払いはできますか → 渡る（答えはカードの分割のみ）", () => truthy(ids("初期費用の分割払いはできますか？").includes("credit_card")));
  it("保証会社の話（クレカ系は控えたい・クレカブラック）には渡さない", () => {
    falsy(ids("保証会社はクレカ系は控えたいです").includes("credit_card"));
    falsy(ids("クレカブラックなのと、夜職なので給料明細だせませんが").includes("credit_card"));
  });
  it("事実に手数料と「対応していないと断定しない」がある", () => {
    const s = buildCompanyFactsNote("クレカ払いはできますか？");
    truthy(s.includes("3.24%"));
    truthy(s.includes("対応していない」と断定しない"));
  });
});

// ── 2026-09-30 竹内（みこと・内覧調整中）: 「初期費用分割は難しいですよね🥲」に事実が届かず AI「分割払いは難しいですが」 ──
describe("初期費用の分割・支払い方法（竹内: 分割はカード支払いのみ・カード手数料として合計金額に3.24%）", () => {
  // 実物（お客様の発言・365日）＋依頼の例文
  const yes = [
    "ありがとうございます。\n初期費用分割は難しいですよね🥲", // みこと（旧は当たらなかった）
    "分割できますか",
    "カード払いできますか",
    "一括じゃないと無理ですか",
    "初期費用なしとかいけますか？分割とか？",
    "分割にしていただけますか？",
    "カード支払いで手続きの方法を、教えてください。",
    "分割とか",
    "お世話になっております。 そうですよね、初期費用の分割、フリーレントはどんな感じでしたか？",
    "クレジットがない場合は一括ですよね？",
    "初期費用分割とかできないですよね？",
    "カード支払いは一括しかできないのでしょうな？ 分割が可能でしたら何回払いからできますか？",
    "初期費用の支払方法は振込のみですか？",
    "スムーズと言う家賃分割サービスは使用できますか？",
    "クレジットカード支払いの場合デビットカードは使えますか？",
    "⑦【初期費用の限度額】⇒13万程 ⑧【その他ご要望あれば】⇒初期費 用の分割や家賃に組み込んでお支払いは可能でしょうか？", // 07-07 条件フォーム
    "⑦【初期費用の限度額】⇒10万まで（分割可） ⑧【その他ご要望あれば】⇒風呂トイレ別", // 09-02 条件フォーム
  ];
  for (const t of yes) it(`「${t.replace(/\n/g, "／")}」→ 渡る`, () => truthy(ids(t).includes("credit_card")));
  const no = [
    "おそらくですが、エポスカードの限度額までリボや分割で使ってるからと推測してます。滞納はありません。", // 審査の話
    "こちらこそありがとうございます。 分割の件よろしくお願いします。", // 交渉中の特例の続き
    "明日お伺いしたいのですが、代理人で母親がカード決済していただきますので、僕は同行しなくてもよろしいでしょうか？",
    "カードローンなどまだ完済していないので不安なのですが大丈夫でしょうか💦",
    "外国人登録説明書は在留カードのコピーは大丈夫でしょうか？",
    "キャッシュカードはなくても大丈夫ですか？",
    "滞納はクレジットです😓",
    "メッセージ分割して送ります",
  ];
  for (const t of no) it(`「${t.slice(0, 30)}」→ 渡さない`, () => falsy(ids(t).includes("credit_card")));
  it("事実の文が竹内さんの言葉のまま（分割はカード支払いのみ・合計金額に3.24%）", () => {
    const s = buildCompanyFactsNote("初期費用分割は難しいですよね");
    truthy(s.includes("分割はクレジットカード支払いのみ可能"));
    truthy(s.includes("カード手数料として合計金額に3.24%が別途必要"));
    truthy(s.includes("「分割は難しい／出来ない」"));
  });
});

describe("形", () => {
  it("当たった数だけ行が出る", () => {
    const s = buildCompanyFactsNote("店舗に行けますか？あと緊急連絡先は必要ですか？");
    truthy(s.includes("オンライン専門"));
    truthy(s.includes("3親等以内"));
  });
  it("質問に必ず答えるよう優先を宣言する（埋もれた質問の穴・2026-09-23）", () =>
    truthy(buildCompanyFactsNote("店舗に行けますか").includes("先に、この質問へ本文で必ず答える")));
  it("見出しが付く", () => truthy(buildCompanyFactsNote("店舗ありますか").includes("【🏢 会社として答えが決まっている事実")));
  it("1回あたり 900字以内（当たるのは普通1〜2件）", () =>
    truthy(buildCompanyFactsNote("緊急連絡先は必ず必要ですか？").length < 1000));
  it("すべての事実に根拠の通数がある", () => { for (const f of COMPANY_FACTS) truthy(f.n > 0, f.id); });
});

// 2026-10-01 YUMA の再生（本番 ab7ea742・365日の質問10通）
describe("初期費用を払う時期", () => {
  it("「初期費用の支払いはいつですか？」→ payment_timing", () => truthy(ids("初期費用の支払いはいつですか？").includes("payment_timing")));
  it("「初期費用はいつ払えばいいんですかね💦」→ payment_timing", () => truthy(ids("初期費用はいつ払えばいいんですかね💦").includes("payment_timing")));
  it("「10/11から入居ってなった場合、そのお金はいつ払う感じなんですか？」→ payment_timing", () => truthy(ids("10/11から入居ってなった場合、そのお金はいつ払う感じなんですか？").includes("payment_timing")));
  it("保険料の後払い・家賃がいつからは渡さない", () => {
    falsy(ids("初回保険料はいくらになるんですか？ 後払いっていつ支払いになるんですか？").includes("payment_timing"));
    falsy(ids("家賃支払いいつからですか？").includes("payment_timing"));
  });
});

// 2026-10-06 ⑫ 朱莉（スモラ）: 審査だけ先に試す＝そのお部屋にお申込み（可能・確認の約束にしない）
describe("審査を先に出す（screening_first）", () => {
  it("審査通るかだけ試してもらう → screening_first", () => truthy(ids("審査通るかだけ試してもらうことって可能でしょうか？").includes("screening_first")));
  it("住吉区の物件 審査通るかどうか試して → screening_first", () => truthy(ids("ちなみに住吉区の物件 審査通るかどうか試してもらうことできるんですか？").includes("screening_first")));
  it("審査は何日かかりますか → screening_first は出さない", () => falsy(ids("審査は何日かかりますか？").includes("screening_first")));
});

// 2026-10-06 ⑫ 見積書の後の「これ以上安くなるのは厳しいですか？」→ 最安値の事実（ゆいと 9/24・R 10/04 の実物）
describe("最安値（cheapest_estimate）", () => {
  it("これ以上安くなるのは厳しいですか → cheapest_estimate", () => truthy(ids("こちらはこれ以上安くなるのは厳しいですか？").includes("cheapest_estimate")));
  it("もっと安くなる可能性はありますか → cheapest_estimate", () => truthy(ids("他のところで見積もりをだしてもらって、28万くらいやったんですけどもっと安くなる可能性はありますか？").includes("cheapest_estimate")));
  it("もっと初期費用安くなる物件ないですか（物件探し）→ 出さない", () => falsy(ids("もっと初期費用安くなる物件ないですか？").includes("cheapest_estimate")));
  it("広告の画像の「初期費用最安値に」→ 出さない", () => falsy(ids("[画像] 関西SUMORAで見つける / 初期費用最安値に / 初期費用2,980円").includes("cheapest_estimate")));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
