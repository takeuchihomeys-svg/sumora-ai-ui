// 2026-09-11 竹内方針1: 必須要素・骨格系は「観測専用」（info）・修正ループに渡さない・後処理ゲートの安全弁は cellElementGaps の回帰テスト。
//   正解代表20件は、旧実装で観測専用コード（PAIR_ELEMENT_MISSING / REPLY_SKELETON_MISSING / CONCERN_UNADDRESSED / WE_DO_MISSING_DET /
//   GENERIC_ONLY_REPLY）と CONDITION_ECHO_MISSING だけで block されていたスタッフ実送信の型を、名前・物件名・住所を置き換えて匿名化したもの
// 実行: npx tsx app/lib/__tests__/skeleton-observe.test.ts（vitest 不要の自己完結ハーネス。全 PASS で exit 0）
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, isConditionFormMessage, MSG_SEP } from "../reply-context";
import { runDeterministicChecks, isRevisable, cellElementGaps, OBSERVE_ONLY_CODES, type FinalCheckContext, type CheckIssue } from "../final-check";
import { buildActionLedger } from "../action-ledger";

// ── ミニハーネス ──
let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}

/** 本番と同じ組み立て（未返信の顧客発言は MSG_SEP でつなぐ） */
function ctxOf(staff: string, cust: string[], name: string): FinalCheckContext {
  const messages = [
    ...(staff ? [{ sender: "staff", text: staff, createdAt: "2026-09-10T01:00:00Z" }] : []),
    ...cust.map((t, i) => ({ sender: "customer", text: t, createdAt: `2026-09-10T02:0${i}:00Z` })),
  ];
  const ledger = buildActionLedger({ messages, lastCustomerAt: messages[messages.length - 1].createdAt });
  const joined = cust.join(MSG_SEP);
  const st = classifyLastStaffTurn(staff, { lastStaffAt: staff ? "2026-09-10T01:00:00Z" : null, ledger });
  const sub = analyzeSubstance(joined, cust, { staffAskedQuestion: st.kind === "question_to_customer" });
  const customer = classifyCustomerResponse(sub, st, { ledger, isConditionPresented: isConditionFormMessage(joined) });
  const pair = resolveTurnPair(st, customer, sub, staff, { ledger, customerName: name });
  return { lastCustomerMessage: joined, recentMessages: messages, customerName: name, ledger, ledgerStrict: true, substance: sub, pairContext: pair };
}

const FORM = (area: string, rent: string, layout: string) =>
  `【お部屋お探し中！】\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒10月\n②【ご希望の家賃】⇒${rent}\n③【希望の広さ・間取り】⇒${layout}\n④【希望築年数】⇒なるべく浅い方\n⑤【ご希望のエリア・駅名】⇒${area}\n⑥【ご希望の駅徒歩分数】⇒特にないです\n⑦【初期費用の限度額】⇒15万程\n※審査に不安な事がある方お気軽にお伝えください😊 審査面柔軟にサポートさせて頂きます！`;
const PROP_SENT = "🌟テストハイツ 201号室\n家賃6.5万円\nお手隙の際にご査収ください😌！！";

type Fx = { id: string; staff: string; cust: string[]; name: string; sent: string };
const GOLD: Fx[] = [
  { id: "G01 条件フォーム初回（全力サポート＋初期費用割引）", staff: "", cust: [FORM("難波に行きやすい路線", "6.5万前後", "1K")], name: "高木",
    sent: "高木さん、はじめまして😊！！\nこの度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n\n最大限の割引をさせていただきますので初期費用抑えれるお部屋メインでお送りさせていただきます😊！！\n\n審査面につきましても、審査通過しやすいお部屋中心でオススメ物件ピックアップさせていただきます😌！！" },
  { id: "G02 有無の質問にピックアップ宣言", staff: "かしこまりました！！\n現在ご条件のお部屋は募集がございません！！\n\n希望エリアを広げること可能でしたら再度ピックアップ可能です！！", cust: ["浪速区とかでありますか？"], name: "中村",
    sent: "かしこまりました！！\n浪速区周辺全域から独立系保証会社対応物件をピックアップしお送りさせて頂きます！！\n出来次第ご連絡させて頂きます😊！！" },
  { id: "G03 費用の質問に見積宣言（金額は答えない）", staff: PROP_SENT, cust: ["こちらの物件いいですね。\n初期費用はいくらほどになりますか？"], name: "大野",
    sent: "かしこまりました！！\n最大限割引させて頂いた初期費用の御見積書お送りさせて頂きます😊！！\n御見積書出来次第お送りさせて頂きます😌！！" },
  { id: "G04 事実回答だけで終える", staff: PROP_SENT, cust: ["内見行きたいのと、9月か10月に入居することは可能ですか？"], name: "森",
    sent: "7/16日に内装工事が完了するお部屋となりますので、ご入居の時期延ばせれても8月の末ごろとなります！！" },
  { id: "G05 条件回答（ご条件お礼＋復唱のピックアップ宣言）", staff: "よろしければ私の方でオススメ出来るお部屋ピックアップさせていただきます😊！！\n①ご入居時期\n②ご希望家賃\n③ご希望間取り\n④ご希望エリア", cust: ["①7月末\n②9万以内\n③27㎡以上\n④十三付近"], name: "岡田",
    sent: "かしこまりました！！\n十三付近から家賃管理費込9万円以内・27㎡以上のご条件に合ったお部屋ピックアップしお送りさせて頂きます😊！！" },
  { id: "G06 条件回答（伴走締めなし）", staff: "よろしければ私の方でオススメ出来るお部屋ピックアップさせていただきます😊！！\n①ご入居時期\n②ご希望家賃\n③ご希望間取り\n④ご希望エリア", cust: ["①8〜9月\n②13万以下\n③1DK以上\n④四ツ橋・堀江付近"], name: "林",
    sent: "ご条件お送りいただきありがとうございます😊！！\n四ツ橋、堀江周辺のエリア全域からペット飼育可能な1DK以上のお部屋ピックアップさせていただきます😌！！" },
  { id: "G07 前向き（内見の明言）に条件節なしのご案内", staff: "お世話になっております！！\nテストハイツ 201号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！", cust: ["ありがとうございます！\nテストハイツの内見したいです！"], name: "久保",
    sent: "かしこまりました！！\nお部屋ご案内させて頂きます😊！！\n\n久保さんのご都合よろしいお日にちをお聞かせください！！" },
  { id: "G08 複数の物件URLに募集状況と初期費用の確認", staff: "募集状況が確認できませんでした！！", cust: ["https://example.jp/a\nhttps://example.jp/b\nこの2件も初期費用と内覧できるか知りたいです！"], name: "小林",
    sent: "小林さんお世話になっております！！\n2件の募集状況と初期費用、管理会社に確認させていただきます！！確認出来次第ご連絡させて頂きます！！" },
  { id: "G09 物件画像に募集状況確認と見積の用意", staff: "", cust: ["[画像]\nここの物件の見積もりと内見がしたいです"], name: "西田",
    sent: "西田さん、はじめまして😊！！\nこの度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n\nお送り頂きました物件の募集状況確認と最大限割引しました初期費用の御見積書をご用意させて頂きます！！" },
  { id: "G10 断りの締め（全力サポートは扉として）", staff: "テストハイツ201号室が敷金礼金なしでかなりオススメ出来るお部屋となります！！", cust: ["今回は他のところに決定しそうです。\nまた機会がありましたらよろしくお願いいたします！"], name: "松本",
    sent: "松本さん\nお世話になっております！！\n\nご連絡頂きありがとうございます😊！！\nまたご縁がございましたら全力でサポートさせて頂きますので、その際はお気軽にご連絡ください！！" },
  { id: "G11 第一希望の指定に「探させて頂きます」", staff: "本町・難波周辺全域からご希望のご条件に合ったお部屋全てピックアップしお送りさせて頂きます！！", cust: ["本町が第一希望でお願いします。"], name: "山口",
    sent: "かしこまりました！！\n\n本町周辺を中心にお部屋探させていただきます！！" },
  { id: "G12 審査の不安に全力サポートと扉", staff: "ほとんどのお部屋がお申込みから1ヶ月以内でご入居日を設定いただく必要がございます😌！！", cust: ["また8月中旬ごろにご連絡させていただく形でもよろしいでしょうか\n夜職のみなので審査も不安です😭"], name: "吉川",
    sent: "吉川さん\nお世話になっております！！\n\nもちろんです😊！！\n\n審査通過できるよう全力でサポートさせて頂きます！！\n\n8月末のお申込みに向けて、気になる点や不安な点がございましたらいつでもお気軽にご連絡ください😌！！" },
  { id: "G13 条件の整理に復唱のピックアップ宣言", staff: "テストハイツ現在建設中のお部屋となりますので、室内写真が出ていない物件となります！！", cust: ["条件を整理させてください！！\n大阪市内\n1LDK\n敷金礼金なし\n駅徒歩10分以内\n家賃＋共益費10万円以内"], name: "石田",
    sent: "かしこまりました！！\nお送り頂きありがとうございます😊！！\n\n大阪市内全域から1LDK・敷金礼金なし・駅徒歩10分以内・家賃管理費込10万円以内のご条件に合ったお部屋ピックアップしてお送りさせて頂きます😌！！" },
  { id: "G14 エリア変更の連投に復唱のピックアップ宣言", staff: "お申込情報と本人確認書類お送り頂きありがとうございます😊！！", cust: ["審査不安ですね！！", "やっぱり大国でお願いします🙏", "今宮近くで！！"], name: "上田",
    sent: "上田さん\nお世話になっております！！\n\nかしこまりました！！\n大国町・今宮周辺全域から上田さんのご希望のご条件に合ったお部屋ピックアップしてお送りさせて頂きます😊！！" },
  { id: "G15 明細の送付に管理会社への共有", staff: "個人事業主から転職という形で管理会社に共有させていただきます！！", cust: ["確定申告自体を、妻の名義でしていまして💦\nそれでは難しいですよね💦\n業務委託先より振込の明細ならあります！\n[画像]"], name: "藤井",
    sent: "振込明細お送り頂きありがとうございます😊！！\n管理会社へ共有し、審査していただけるよう交渉させていただきます！！" },
  { id: "G16 画像の物件に募集状況確認だけ", staff: "お仕事面は弊社でサポートさせていただきますので、ご安心ください！！", cust: ["同居人の分の仕事の用意お願い致します🙇‍♀️\n[画像]\nここの初期費用見積もりお願いできますか？"], name: "原田",
    sent: "お部屋お送りいただきありがとうございます😊！！\n募集状況確認させていただきます！！" },
  { id: "G17 詳細依頼に確認しお送り", staff: "家賃を9.5万円までご条件広げさせていただきましたが、現在募集中のお部屋3部屋のみとなっております！！\nお手隙の際にご査収ください😌！！", cust: ["こちらの詳細教えてもらえませんか\nこちらも教えて欲しいです"], name: "村上",
    sent: "はい！！\nお送りさせて頂きました2件それぞれの詳細、確認しお送りさせて頂きます！！\n出来次第ご連絡させて頂きます😊！！" },
  { id: "G18 条件の依頼に復唱のピックアップ宣言", staff: "ご内覧他社さんでしていただき弊社でお申込みも可能ですのでお気軽にお知らせください！！", cust: ["1K、1DK\nオートロック･築浅･バストイレ別\n家賃6万円におさまる所\n立花駅、甲子園駅周辺でも大丈夫です。\nこちらの条件でいくつか探して頂けますか？"], name: "近藤",
    sent: "かしこまりました！！\n立花駅・甲子園駅周辺全域から近藤さんご希望の1K・1DK・オートロック・バストイレ別・家賃管理費込み6万円以内のお部屋ピックアップしお送りさせて頂きます😊！！" },
  { id: "G19 物件URLの見積依頼に見積の予告", staff: "テストハイツの管理会社より審査の進捗あり次第ご連絡させていただきます！！", cust: ["日本橋 1DK 6階\nhttps://example.jp/c\nこの物件取り扱いあれば初期費用見積もりお願いします！"], name: "三浦",
    sent: "お部屋お送りいただきありがとうございます！！\n募集状況確認出来次第、最大限割引しました初期費用御見積書と合わせてご連絡させていただきます😊！！" },
  { id: "G20 保証会社の条件追加に復唱のピックアップ宣言", staff: "かしこまりました！！\n浪速区周辺全域から独立系保証会社対応物件をピックアップしお送りさせて頂きます！！\n出来次第ご連絡させて頂きます😊！！", cust: ["A社\nB社\nとかも審査落ちしています\nよろしくお願いいたします。"], name: "竹下",
    sent: "かしこまりました！！\nA社・B社以外の独立系保証会社対応物件で浪速区周辺全域からピックアップしお送りさせて頂きます！！\n出来次第ご連絡させて頂きます😊！！" },
];

const OBS_OR_ECHO = (i: CheckIssue) => OBSERVE_ONLY_CODES.has(i.code) || i.code === "CONDITION_ECHO_MISSING";

describe("正解代表20件で観測専用コードと ECHO の block が 0件", () => {
  for (const g of GOLD) {
    it(g.id, () => {
      const iss = runDeterministicChecks(g.sent, ctxOf(g.staff, g.cust, g.name));
      const bad = iss.filter((i) => OBS_OR_ECHO(i) && i.severity === "block").map((i) => i.code);
      expect(bad).toEqual([]);
    });
  }
});

describe("修正ループの入口（isRevisable）", () => {
  it("R1 観測専用コード・表示のみ・誤字・info は修正ループに渡さない", () => {
    const mk = (code: string, severity: "block" | "warning" | "info"): CheckIssue => ({ pass: "context_check", severity, code, message: "", evidence: "", suggestion: "" });
    for (const c of [...OBSERVE_ONLY_CODES]) expect(isRevisable(mk(c, "warning"))).toBe(false);
    expect(isRevisable(mk("CONDITION_ECHO_MISSING", "warning"))).toBe(false);
    expect(isRevisable(mk("CLOSER_MISSING", "warning"))).toBe(false);
    expect(isRevisable(mk("TYPO_KANA_DROP", "warning"))).toBe(false);
    expect(isRevisable(mk("EMPTY_CLOSER", "info"))).toBe(false);
  });
  it("R2 block で残る骨格系（EMPTY_CLOSER / SPLIT_ACK_REPLY）と事実系 block は修正ループに渡す", () => {
    const mk = (code: string): CheckIssue => ({ pass: "context_check", severity: "block", code, message: "", evidence: "", suggestion: "" });
    for (const c of ["EMPTY_CLOSER", "SPLIT_ACK_REPLY", "BANNED_WORD", "NAME_MISMATCH", "CONFIRM_NO_OBJECT"]) expect(isRevisable(mk(c))).toBe(true);
  });
});

describe("後処理ゲートの安全弁（cellElementGaps は severity 非依存）", () => {
  it("S1 セルの必須要素を満たす文を消すと欠落ラベルが増える（PAIR_ELEMENT_MISSING が info でも検知できる）", () => {
    const g = GOLD[4]; // G05 条件回答
    const ctx = ctxOf(g.staff, g.cust, g.name);
    const before = cellElementGaps(g.sent, ctx);
    const after = cellElementGaps("かしこまりました！！", ctx);
    expect(before.length).toBe(0);
    expect(after.length > before.length).toBe(true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
