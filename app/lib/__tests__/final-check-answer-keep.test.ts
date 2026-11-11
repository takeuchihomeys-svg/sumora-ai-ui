// 2026-11-12 作業員15 最終チェックの書き直しがブレインの答え・約束を消さない関所（final-check-answer-keep.ts）
// 文は本番の下書き・書き直しの実物（ai_reply_examples の exitEdits・10/29〜11/11）。名前は YUMA に伏せた
// 実行: npx tsx app/lib/__tests__/final-check-answer-keep.test.ts
import { phaseBanKeepsAnswer, revisionAddedFactContradiction, MOVE_IN_TIMING_QUESTION_RE, fcKeepsBrainSentence, uketamawariKeeps, promiseKeeps, propertyNameVariantGrounded } from "../final-check-answer-keep";
import { runDeterministicChecks } from "../final-check";
import type { TurnContract, ContractAsk } from "../turn-contract";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const ON = { FC_ANSWER_KEEP: "on", FC_REVISION_NO_NEW_FACT: "on" };
const OFF = {};
const ask = (o: Partial<ContractAsk>): ContractAsk => ({ quote: "", topic: "other", kind: "question", route: "reply", answer: null, basis: null, aixKey: null, ...o });
const contract = (asks: ContractAsk[]): TurnContract => ({
  asks, leadWith: null, closeOnly: false, mustNot: [], proposals: [], alreadySaid: [], settled: [],
  feeling: { kind: null, acknowledge: false }, humanChecks: [], source: "brain",
});

// 57b3e676（11/04・ブレインの本質なし）: 「契約してからどのくらいで住めますか」への流れの説明が審査・契約の ban で書き直された
const D_PROC = "ありがとうございます😊！！\nお申込み後は保証会社の審査（3日〜10日程）、ご契約手続きを経て、空室で即入居できるお部屋でしたらお申込から最短2週間程でご入居頂けます！！";
const C_PROC = "ありがとうございます！\nこちらの部屋契約してからどのくらいで住めますでしょうか？";
const SCREEN_ISSUE = { code: "TIMING_VOCAB_MISMATCH", message: "【物件提案中】審査面・保証会社への自発的言及（挨拶テンプレと重複・物件未確定で保証会社は決まらない）: 「保証会社の」", evidence: "保証会社の" };
const CONTRACT_ISSUE = { code: "TIMING_VOCAB_MISMATCH", message: "【物件提案中】審査前の契約・重要事項説明への言及: 「ご契約手続き」", evidence: "ご契約手続き" };

it("①実物: 入居までの期間の質問への流れの説明は書き直しに渡さない（ブレインなし・お客様の質問の網）", () => {
  eq(phaseBanKeepsAnswer(SCREEN_ISSUE, { contract: null, draft: D_PROC, customerText: C_PROC, env: ON }), true);
  eq(phaseBanKeepsAnswer(CONTRACT_ISSUE, { contract: null, draft: D_PROC, customerText: C_PROC, env: ON }), true);
});
it("①既定 off は今までどおり渡す", () => {
  eq(phaseBanKeepsAnswer(SCREEN_ISSUE, { contract: null, draft: D_PROC, customerText: C_PROC, env: OFF }), false);
});
it("①決定論の段が本当にこの2つを出す（proposing の段・配線の確かめ）", () => {
  const issues = runDeterministicChecks(D_PROC, { lastCustomerMessage: C_PROC, phaseKey: "proposing", recentMessages: [{ sender: "customer", text: C_PROC }] } as never);
  const tv = issues.filter((i) => i.code === "TIMING_VOCAB_MISMATCH");
  eq(tv.length >= 1, true, `TIMING_VOCAB ${JSON.stringify(issues.map((i) => i.code))}`);
  for (const i of tv) eq(phaseBanKeepsAnswer(i, { contract: null, draft: D_PROC, customerText: C_PROC, env: ON }), true, i.message);
});

// 6fd93747（11/08）: ブレインが「いつから入居可能か」を返信で答えると決めた番
const D_MOVEIN = "べニール南堀江603号室は即入居可能なお部屋となりますので、審査と契約手続きが完了次第ご入居いただけます！！";
it("①実物: ブレインが入居の時期を返信で答える番は渡さない（お客様の文に時期の語が無くても）", () => {
  const c = contract([ask({ quote: "いつから入居可能か", topic: "move_in", route: "reply" }), ask({ quote: "白フローリングはあるか", topic: "equipment", route: "promise" })]);
  eq(phaseBanKeepsAnswer({ ...CONTRACT_ISSUE, evidence: "契約手続き" }, { contract: c, draft: D_MOVEIN, customerText: "べニール南堀江がいい印象です。", env: ON }), true);
});

// f8989a39（11/08）: 「他はないですか？？」→ ブレインは探す約束。約束の文の「独立系」を審査の ban が消した（スタッフは探す一文を送った）
const D_SEARCH = "独立系の保証会社で審査通過する可能性があるお部屋を中心に探させて頂きます！！";
it("①実物: ブレインの探す約束の文は渡さない", () => {
  const c = contract([ask({ quote: "他はないですか", topic: "pickup", route: "promise", answer: "条件に合う物件を探す" })]);
  eq(phaseBanKeepsAnswer({ ...SCREEN_ISSUE, evidence: "独立系" }, { contract: c, draft: D_SEARCH, customerText: "他はないですか？？", env: ON }), true);
});

// 渡す側（今までどおり）
it("対照: お客様が時期を聞いていない番の自発の審査の言及は渡す（ブレインなし）", () => {
  const d = "YUMAさんお世話になっております！！\n審査面もしっかりサポートさせて頂きます！！";
  eq(phaseBanKeepsAnswer({ ...SCREEN_ISSUE, evidence: "審査面" }, { contract: null, draft: d, customerText: "条件送りました！よろしくお願いします", env: ON }), false);
});
it("対照: ブレインがいて入居の項目が無く、文が約束でもない時は渡す", () => {
  const c = contract([ask({ quote: "駐車場はありますか", topic: "equipment", route: "promise" })]);
  const d = "保証会社はジェイリースとなります！！";
  eq(phaseBanKeepsAnswer({ ...SCREEN_ISSUE, evidence: "ジェイリース" }, { contract: c, draft: d, customerText: "駐車場はありますか？いつ住めますか", env: ON }), false);
});
// ebc323df（10/25）: ブレインが返信で答える番でも、時期の答えでない審査の文（会社の決まりと食い違うおそれ）は今までどおり渡す
it("対照: 実物「審査通過後…キャンセルは無料」は時期の答えでないので渡す", () => {
  const c = contract([ask({ quote: "一回だけ見たくて", topic: "contract", route: "reply" })]);
  const d = "保証会社の審査通過後、オーナー審査が始まるまでのキャンセルは無料となります。";
  eq(phaseBanKeepsAnswer({ ...SCREEN_ISSUE, evidence: "保証会社の" }, { contract: c, draft: d, customerText: "部屋が7畳しかないので一回だけ見たくて", env: ON }), false);
});
it("対照: 見積の ban（TIMING_VOCAB だが見積）は対象外", () => {
  const est = { code: "TIMING_VOCAB_MISMATCH", message: "【初回対応】お客様の費用質問・見積依頼…のいずれも無い見積書の作成・送付宣言: 「御見積書」", evidence: "御見積書" };
  eq(phaseBanKeepsAnswer(est, { contract: null, draft: "御見積書を作成しお送りさせて頂きます！！", customerText: "いつから住めますか", env: ON }), false);
});
it("対照: 他のコード（作り話・禁止語）は対象外", () => {
  eq(phaseBanKeepsAnswer({ code: "FABRICATED_DATE", message: "審査面・保証会社", evidence: "10/27" }, { contract: null, draft: D_PROC, customerText: C_PROC, env: ON }), false);
  eq(phaseBanKeepsAnswer({ code: "BANNED_WORD", message: "", evidence: "少々お待ちください" }, { contract: null, draft: D_PROC, customerText: C_PROC, env: ON }), false);
});
it("質問の網: 実物の聞き方に当たり、了承・条件の文に当たらない", () => {
  for (const s of ["こちらの部屋契約してからどのくらいで住めますでしょうか？", "べニール南堀江はいつから入居可能でしょうか", "審査って何日くらいかかりますか", "最短でいつ入居できますか"]) eq(MOVE_IN_TIMING_QUESTION_RE.test(s), true, s);
  for (const s of ["ありがとうございます！", "12月前半に入居したいです", "他はないですか？？", "1LDKで探してください"]) eq(MOVE_IN_TIMING_QUESTION_RE.test(s), false, s);
});

// ② 61845054（11/10）: 書き直しが「お振込での一括のみ」を足した（会社の事実＝カード払い可・3.24%。スタッフはカード可で送った）
const D_CARD = "全然大丈夫です😊\nプレジオ阿波座1308号室の初期費用、カード決済可能か管理会社に確認させて頂きます！！\n本日営業時間外の為、明日確認出来次第ご連絡させて頂きます！！";
const R_CARD = "全然大丈夫です😊\n初期費用のお支払い方法はお振込での一括のみでの対応となります！！\n内覧につきましては、日程のご案内をお送りさせて頂きます！！";
it("②実物: 書き直しが足した会社の事実に反する断定を見つける", () => {
  const hit = revisionAddedFactContradiction(D_CARD, R_CARD, ON);
  eq(!!hit && /一括のみ/.test(hit), true, String(hit));
});
it("②既定 off は見ない", () => { eq(revisionAddedFactContradiction(D_CARD, R_CARD, OFF), null); });
it("②元の下書きにあった文は見ない（1回目の検査の役目）", () => {
  eq(revisionAddedFactContradiction(R_CARD, R_CARD.replace("全然大丈夫です😊\n", ""), ON), null);
});

// ② 正しかった書き直し（実物）は全部通る＝誤って捨てない
const GOOD: Array<[string, string]> = [
  ["かしこまりました！！\nYUMAさんがご満足頂けるお部屋が見つかるまで、全力でサポートさせて頂きます😌！！", "かしこまりました！！\n芦原橋・天王寺の間のエリア全域からオススメできるお部屋ピックアップさせて頂きます！！\nピックアップ出来次第ご連絡させて頂きます😌！！"],
  ["本日は管理会社の営業時間が終了しておりますので、明日一番で確認しご連絡させて頂きます😌！！", "確認出来次第ご連絡させて頂きます😌！！"],
  ["グラン寝屋川101号室の初期費用は、室内清掃費を除いた約11万円となります！！", "室内清掃費は初期費用に含まれておりません！！\nお送りしました見積書の内容が、ご入居時にお支払い頂く初期費用となります！！"],
  ["1Kより家賃は上がる傾向ですが、YUMAさんのご希望の家賃8万円前後に近いお部屋を探させて頂きます！！", "収納が狭いとのこと、広めのお部屋を探させて頂きます😊！！\n1LDKは1Kと比べて1〜2万円ほど上がることが多いです！！"],
  ["今回も仲介手数料0円・初期費用も最大限割引させて頂いておりますのでご安心ください！！", "今回も仲介手数料0円・初期費用も最大限割引させて頂いております！！"],
  ["ベニール南堀江603号室は即入居可能なお部屋となりますので、審査と契約手続きが完了次第ご入居いただけます！！", "ベニール南堀江603号室は資料上、即入居可能なお部屋となっております！！"],
  ["少々お待ちください！！", "そのままお待ちください！！"],
];
it("②正しかった書き直し 7件は捨てない（誤って捨てる 0）", () => {
  for (const [b, a] of GOOD) eq(revisionAddedFactContradiction(b, a, ON), null, a.slice(0, 30));
});

// ─── 11/12 統括役の続き: 承り・ご都合・約束・物件名の表記ゆれ ───
const ON2 = { FC_UKETAMAWARI_BRAIN: "on", FC_GOCHOUGO_RESCHEDULE: "on", FC_PROMISE_KEEP: "on", FC_PROPERTY_NAME_NORMALIZE: "on" };
it("承り 実物 f6bcf7c4: ブレインが内覧を扱う番の「ご内覧のご希望、承りました」は渡さない", () => {
  const c = contract([ask({ quote: "本日の6時半は空いてないでしょうか", topic: "viewing", route: "aix" })]);
  const i = { code: "UKETAMAWARI_OBJECT_UNANCHORED", message: "「ご内覧のご希望」をお客様は伝えていないのに「本日18:30のご内覧のご希望、承りました」", evidence: "本日18:30のご内覧のご希望、承りました" };
  eq(fcKeepsBrainSentence(i, { contract: c, draft: "本日18:30のご内覧のご希望、承りました😊！！", customerText: "本日の6時半は空いてないでしょうか？", env: ON2 }), true);
  eq(fcKeepsBrainSentence(i, { contract: c, draft: "本日18:30のご内覧のご希望、承りました😊！！", customerText: "", env: OFF }), false, "off");
});
it("承り 対照: ブレインの項目に無い目的語（キャンセル料）は渡す・ブレインなしも渡す", () => {
  const c = contract([ask({ quote: "本日の6時半は空いてないでしょうか", topic: "viewing", route: "aix" })]);
  const i = { code: "UKETAMAWARI_OBJECT_UNANCHORED", message: "「家賃の値下げ」をお客様は伝えていないのに「家賃の値下げのご希望承りました」", evidence: "家賃の値下げのご希望承りました" };
  eq(uketamawariKeeps(i, { contract: c, env: ON2 }), false);
  eq(uketamawariKeeps({ ...i, message: "「ご内覧」…" }, { contract: null, env: ON2 }), false);
});
it("ご都合 実物 23837532: お客様が日の変更を頼んだ番の GOCHOUGO_AFTER_FIXED は渡さない", () => {
  const i = { code: "GOCHOUGO_AFTER_FIXED", message: "内覧日時が確定済みなのに再度「ご都合よろしいお日にち」を尋ねています", evidence: "11/11（水）でYUMAさんのご都合よろしいお時間をお知らせ頂けますでしょうか！！" };
  const cust = "お世話になっております\n本日の内見なんですが仕事が入ってしまって明日休みなので明日でもよろしいでしょうか？";
  eq(fcKeepsBrainSentence(i, { contract: contract([ask({ quote: "明日でもよろしいでしょうか", topic: "viewing", route: "reply" })]), draft: i.evidence, customerText: cust, env: ON2 }), true);
  eq(fcKeepsBrainSentence(i, { contract: null, draft: i.evidence, customerText: "本日よろしくお願いします", env: ON2 }), false, "変更なし");
});
it("約束 実物 7d8086d1: ブレインの探す約束の文を DOUBLE_DECLARATION で消さない", () => {
  const c = contract([ask({ quote: "引き続きどうぞよろしくお願いいたします", topic: "pickup", route: "promise", answer: "2LDKのお部屋を引き続き探して送る" })]);
  const s = "引き続きオススメできる2LDKのお部屋をピックアップしてお送りさせて頂きますので、何卒よろしくお願い致します😌！！";
  eq(fcKeepsBrainSentence({ code: "DOUBLE_DECLARATION", message: "直前と同じ約束", evidence: "ピックアップしてお送りさせて頂きます" }, { contract: c, draft: s, customerText: "", env: ON2 }), true);
  eq(promiseKeeps({ code: "DOUBLE_DECLARATION", evidence: "ピックアップしてお送りさせて頂きます" }, { contract: { ...c, alreadySaid: ["引き続きオススメできる2LDKのお部屋をピックアップしてお送り"] }, draft: s, env: ON2 }), false, "ブレインがもう言ったとした");
});
it("約束 実物 ece1900f: ブレインの提案（撮影）の写真と動画の約束を消さない", () => {
  const c = { ...contract([ask({ quote: "忘れていました", topic: "other", route: "reply" })]), proposals: ["室内の写真と動画を撮影して送る"] };
  eq(promiseKeeps({ code: "DOUBLE_DECLARATION", evidence: "室内写真と動画撮影出来次第お送りさせて頂きます" }, { contract: c, draft: "室内写真と動画撮影出来次第お送りさせて頂きます！！", env: ON2 }), true);
});
it("約束 対照: 安全の線のコードは対象外", () => {
  const c = contract([ask({ quote: "他は", topic: "pickup", route: "promise" })]);
  for (const code of ["FABRICATED_PROPERTY", "BANNED_WORD", "NG_PROPERTY_MENTION", "AIX_BOUNDARY_PROPERTY", "COMPANY_FACT_CONTRADICTION"])
    eq(fcKeepsBrainSentence({ code, message: "審査面・保証会社", evidence: "ピックアップしてお送りさせて頂きます" }, { contract: c, draft: "ピックアップしてお送りさせて頂きます！！", customerText: "いつ住めますか", env: { ...ON, ...ON2 } }), false, code);
});
it("物件名 実物 f60ee58d: 全角空白・号室の有無だけの違いは作り話でない", () => {
  const ground = ["[画像]【物件の資料】物件名：メゾン　ソレイユ 202 所在地：大阪市"];
  eq(propertyNameVariantGrounded("FABRICATED_PROPERTY", "メゾン ソレイユ 202号室", ground, ON2), true);
  eq(propertyNameVariantGrounded("FABRICATED_PROPERTY", "メゾン ソレイユ 203号室", ground, ON2), false, "号室が違う");
  eq(propertyNameVariantGrounded("FABRICATED_PROPERTY", "メゾン ルミエール 202号室", ground, ON2), false, "名前が違う");
  eq(propertyNameVariantGrounded("FABRICATED_AMOUNT", "メゾン ソレイユ 202号室", ground, ON2), false, "金額は対象外");
  eq(propertyNameVariantGrounded("FABRICATED_PROPERTY", "メゾン ソレイユ 202号室", ground, OFF), false, "off");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" -", f); process.exit(1); }

// ─── 11/12 ③ カードの即答の向き（reply-context card_pay）・「カードで決済」の拾い（company-facts）───
import("../reply-context").then(async ({ resolveAnswerability }) => {
  const { isPaymentMethodQuestion } = await import("../company-facts");
  const q = "返事が遅くなりすいません！\n初期費用はカードで決済できますか？";
  const save = { ...process.env };
  try {
    delete process.env.KNOWN_FACT_CARD_FIX; delete process.env.COMPANY_FACT_PAYMENT_LUMP; delete process.env.COMPANY_FACT_CARD_KESSAI;
    it("③既定（本番の今）は一括のみ＝逆向きの再現", () => eq(/一括のみ/.test(resolveAnswerability(q)?.answer ?? ""), true));
    it("③既定は「カードで決済」を支払いの質問と拾わない（再現）", () => eq(isPaymentMethodQuestion(q), false));
    process.env.KNOWN_FACT_CARD_FIX = "on"; process.env.COMPANY_FACT_CARD_KESSAI = "on";
    it("③on はカード可・3.24%（竹内さん側の実送信の形）", () => eq(/カードでの決済も可能.*3\.24%/.test(resolveAnswerability(q)?.answer ?? ""), true));
    it("③on で「カードで決済」を拾う・マイナンバーカードは拾わない", () => { eq(isPaymentMethodQuestion(q), true); eq(isPaymentMethodQuestion("マイナンバーカードで決済"), false); });
    process.env.COMPANY_FACT_PAYMENT_LUMP = "on";
    it("③on＋一括の決まり on は一括のみ（company-facts と同じ向き）", () => eq(/一括のみ/.test(resolveAnswerability(q)?.answer ?? ""), true));
  } finally { process.env = save; }
  console.log(`\n(③込み) ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
