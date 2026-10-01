// 実行: npx tsx app/lib/__tests__/estimate-second-message.test.ts
// 2026-10-01 竹内「物件オススメのところが改善されたように、見積書や他のよく使うAIXテンプレートの部分も改善する」
//   YUMA の生成（直す前・DeepSeek）と、スタッフが自分で書いて送った2通目（名前だけ置き換え）をそのまま使う。
import {
  isEstimateCard, estimatePropertiesOf, resolveEstimateClosing, buildEstimateSecondNote,
  findEstimateSecondProblems, ensureEstimateClosing, ESTIMATE_SECOND_EXAMPLES, ESTIMATE_RECEIPT_LINE, ESTIMATE_VIEWING_LINE,
} from "../estimate-second-message";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }

const CARD1 = "【エステムコート大阪WEST 805号室】\n\n初期費用さらに\n🌟124,050円割引させて頂き\n初期費用：137,980円\n\nスモラなら一般的な不動産業者より269,570円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。";
const CARD2 = "①【レオンコンフォート難波クレア 503号室】\n\n初期費用さらに\n🌟40,000円割引させて頂き\n初期費用：102,000円\n\nイエヤスなら一般的な不動産業者より120,300円節約出来ます！！\n\n②【Luxe難波西2 1103号室】\n\n初期費用さらに\n🌟63,000円割引させて頂き\n初期費用：79,300円\n\nイエヤスなら一般的な不動産業者より140,000円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。";

// ── 1通目（見積書の本体）を読む ──
t("見積書の本体と分かる", isEstimateCard(CARD1) && isEstimateCard(CARD2));
t("物件オススメの1通目は見積書の本体ではない", !isEstimateCard("🌟S-RESIDENCE福島玉川Deux 208\n\n家賃管理費込81,000円・玉川駅徒歩4分、YUMAさんにかなりオススメ出来るお部屋となります！！"));
t("【物件 号室】を読む（1件）", JSON.stringify(estimatePropertiesOf(CARD1)) === JSON.stringify(["エステムコート大阪WEST 805号室"]));
t("【物件 号室】を読む（2件・①②の印は外にある）", estimatePropertiesOf(CARD2).length === 2 && estimatePropertiesOf(CARD2)[1] === "Luxe難波西2 1103号室");

// ── 締めの決め方 ──
t("内覧の前・前向き → 内覧のご案内", resolveEstimateClosing({ viewed: false, reactionKind: "positive" }).closing === "viewing");
t("内覧の前・質問だけ → ご査収", resolveEstimateClosing({ viewed: false, reactionKind: "question" }).closing === "receipt");
t("内覧の後 → ご査収（申込はブレインが決める）", resolveEstimateClosing({ viewed: true, reactionKind: "positive" }).closing === "receipt");
t("スタッフが申込を選んだ時だけ申込", resolveEstimateClosing({ viewed: false, reactionKind: null, ctaPreference: "apply" }).closing === "apply");
t("スタッフが内覧を選んだ → 内覧（内覧の後でも）", resolveEstimateClosing({ viewed: true, ctaPreference: "viewing" }).closing === "viewing");

// ── 指示（最後に置く形）──
{
  const n = buildEstimateSecondNote({ name: "YUMA", properties: ["エステムコート大阪WEST 805号室"], closing: "receipt", staffSentToday: true });
  t("名前を入れる（伏せ字を残さない）", n.includes("YUMAさん") && !n.includes("{{NAME}}"));
  t("ご査収の時は申込の実物を見せない", !/お申込みしお部屋抑え/.test(n));
  t("ご査収の時は締めの指示がご査収", n.includes(`「${ESTIMATE_RECEIPT_LINE}」の1文だけ`));
  t("今日送っている時は挨拶の行を書かない指示", n.includes("挨拶の行（お世話になっております）は書かない"));
  const nm = buildEstimateSecondNote({ name: "", properties: ["A 101号室", "B 202号室"], closing: "viewing", staffSentToday: false });
  t("名前が分からない時は呼びかけごと落とす", !nm.includes("{{NAME}}") && !/^さん/m.test(nm));
  t("2件の時は「2部屋の」", nm.includes("2部屋の"));
}
t("手本は全部スタッフの文（お待たせを含まない）", ESTIMATE_SECOND_EXAMPLES.every((e) => !/お待たせ/.test(e.text)));

// ── 出口の検査（YUMA の生成・直す前）──
{
  const yuma1 = "YUMAさん\n\nエステムコート大阪WEST 805号室の最大限割引しました初期費用の御見積書となります！！\n\nお気に召されましたらお申込みしお部屋抑えさせて頂きます😊！！\n\nお手隙の際にご査収ください😌！！";
  t("申込の誘い（ご査収と決めた時）", findEstimateSecondProblems(yuma1, { closing: "receipt", first: CARD1 }).some((h) => h.key === "apply"));
  t("スタッフが申込を選んだ時は当てない", !findEstimateSecondProblems(yuma1, { closing: "apply", first: CARD1 }).some((h) => h.key === "apply"));
  const yuma3 = "YUMAさん\n\n805号室、本当に良いお部屋ですよね😊！！\n\nお気に召されましたらお申込みでお部屋抑えさせて頂きます！！\n\nお手隙の際にご査収ください😌！！";
  const h3 = findEstimateSecondProblems(yuma3, { closing: "receipt", first: CARD1 }).map((h) => h.key);
  t("評する一文・号室だけ・申込", h3.includes("eval") && h3.includes("room") && h3.includes("apply"), h3.join(","));
  t("総額の言い直し", findEstimateSecondProblems("初期費用137,980円となります！！\nお手隙の際にご査収ください😌！！", { closing: "receipt", first: CARD1 }).some((h) => h.key === "amount"));
  // スタッフの文（実送信・当てない）
  const staff = [
    "2部屋の最大限割引させていただいたお見積書をお送りさせていただきました😊！！\n\nご費用面もお気に召されましたらお部屋のお申込みもさせていただきます！！\n\nお手隙の際にご確認ください！！",
    "〈名〉さん\nお待たせいたしました！！\n\n代表から特別に許可をいただき追加で¥20,000円割引が出来ましたので最大限割引させていただいたお見積書お送りさせていただきました😌！！\n\nお手隙の際にご査収ください！！",
    "602号室が既にお申込みが入ってしまい、3LDKのお部屋302号室、202号室、702号室が募集中となります！！\n202号室、702号室に関しても",
  ];
  t("スタッフの文: 1通目に無い金額（代表の追加割引）は当てない", !findEstimateSecondProblems(staff[1], { closing: "receipt", first: CARD1 }).some((h) => h.key === "amount"));
  t("スタッフの文: 号室を並べる形は当てない", !findEstimateSecondProblems(staff[2], { closing: "receipt", first: CARD1 }).some((h) => h.key === "room"));
  t("スタッフの文: 評する一文は無い", ESTIMATE_SECOND_EXAMPLES.every((e) => !findEstimateSecondProblems(e.text, { closing: e.closing, first: CARD1 }).some((h) => h.key === "eval")));
}

// ── 締めの保証（足すだけ）──
{
  const a = ensureEstimateClosing("最大限割引させていただいたお見積書お送りさせていただきました😊！！", "receipt");
  t("ご査収が無ければ最後に足す", a.text.endsWith(ESTIMATE_RECEIPT_LINE) && a.added === ESTIMATE_RECEIPT_LINE);
  const b = ensureEstimateClosing("こちら初期費用の御見積書となります！！\nお手隙の際にご査収ください😌！！", "receipt");
  t("ご査収があれば何もしない", b.added === null);
  const c = ensureEstimateClosing("こちら初期費用の御見積書となります😊！！\nお手隙の際にご査収ください😌！！", "viewing");
  t("内覧のご案内はご査収の行の前に足す", c.text === `こちら初期費用の御見積書となります😊！！\n${ESTIMATE_VIEWING_LINE}\nお手隙の際にご査収ください😌！！`, c.text);
  const d = ensureEstimateClosing("こちら初期費用の御見積書となります😊！！\nお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！", "viewing");
  t("内覧のご案内があれば何もしない", d.added === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
