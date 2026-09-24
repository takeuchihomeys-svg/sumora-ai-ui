// 2026-09-24 竹内「会話や物件オススメの訴求点から、画像でしか分からない希望を拾う」— 純関数のテスト（実物の言い回し）
// 実行: npx tsx app/lib/__tests__/image-wants.test.ts
import { extractImageWants, scoreChecks, wantsToText, topicsOf } from "../image-wants";
let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const w = extractImageWants({
  conditions: { preferences: "WIC（ウォークインクローゼット）付き", ng_points: "西天満より北のエリア・ペット可NG[必須]", other_requests: "家賃14万以内", additional_conditions: null },
  customerMessages: [
    { text: "食事するリビングと寝室兼書斎の生活空間分けたいので、ドゥーエは部屋作るのに理想だと思いました。", created_at: "2026-09-20" },
    { text: "トラストマン堀江は洋室が小さそうなのでもう少し余裕あるところがいいです", created_at: "2026-09-21" },
    { text: "[画像] 桜川 1K 5階  5.4万円/管理費 10000円  間取り: 1K 広さ: 22.86㎡", created_at: "2026-09-22" },
    { text: "間取りと石橋阪大前駅まで徒歩何分ですか？", created_at: "2026-09-22" },
    { text: "風呂、トイレ別でお願いします", created_at: "2026-09-19" },
  ],
  sellingPoints: ["敷礼0円", "角部屋", "角部屋", "ネット無料", "広告料2ヶ月以上"],
  mask: (s) => s,
});
const texts = w.map((x) => `${x.source}:${x.text}`);
t("★ 条件欄の WIC を拾う", texts.some((s) => s.startsWith("条件:WIC")), texts);
t("★ NG のペット可NG[必須] は ng・必須", w.some((x) => /ペット可NG/.test(x.text) && x.ng && x.must), w);
t("★ エリア・家賃は画像で決めないので入れない", !texts.some((s) => /西天満|家賃/.test(s)), texts);
t("★ 会話の「リビングと寝室…分けたい」を拾う", texts.some((s) => s.startsWith("会話:") && /リビングと寝室/.test(s)), texts);
t("★ 会話の「洋室が小さそう…余裕」を拾う（広さの希望）", texts.some((s) => /洋室が小さそう/.test(s)), texts);
t("★ 会話の「風呂、トイレ別」を拾う", texts.some((s) => /風呂、トイレ別/.test(s)), texts);
t("★ お客様が貼った物件の OCR（[画像]）は拾わない", !texts.some((s) => /桜川/.test(s)), texts);
t("★ 質問だけの文は拾わない", !texts.some((s) => /徒歩何分/.test(s)), texts);
t("★ 訴求点は画像で分かる物だけ（角部屋・ネット無料○／敷礼・広告料×）・重複は1つ", texts.filter((s) => s === "訴求:角部屋").length === 1 && texts.includes("訴求:ネット無料") && !texts.some((s) => /敷礼|広告料/.test(s)), texts);
t("★ 番号は W1 から順に", w[0].id === "W1" && w[w.length - 1].id === `W${w.length}`);
t("★ 一覧の文に出どころと NG・必須の印", wantsToText(w).includes("【条件・NG・必須】"), wantsToText(w));
t("★ 話題の判定（収納・部屋の配置・水回り）", topicsOf("WIC").includes("storage") && topicsOf("リビングと寝室を分けたい").includes("layout") && topicsOf("独立洗面台").includes("water"));
{
  // YUMA の実物: フォームの回答（見出し⇒答え）は答えを「、」で1項目ずつ・空の見出しは捨てる
  const f = extractImageWants({ customerMessages: [{ text: "【希望の広さ・間取り】⇒\n【その他こだわりご要望】⇒白基調の綺麗な内装、お風呂トイレ別、お風呂綺麗、オートロック、クローゼットが壁に埋め込まれてる", created_at: "2026-09-01" }], mask: (s) => s });
  const ft = f.map((x) => x.text);
  t("★ 空の見出し（【希望の広さ・間取り】⇒）は拾わない", !ft.some((s) => /希望の広さ/.test(s)), ft);
  t("★ フォームの答えを1項目ずつ（お風呂トイレ別・オートロック・クローゼット…）", ft.includes("お風呂トイレ別") && ft.includes("オートロック") && ft.some((s) => /クローゼットが壁に埋め込まれてる/.test(s)), ft);
}
{
  const ws = [
    { id: "W1", source: "条件" as const, text: "WIC", topics: ["storage"], ng: false, must: false },
    { id: "W2", source: "条件" as const, text: "ペット可NG[必須]", topics: ["pet"], ng: true, must: true },
    { id: "W3", source: "会話" as const, text: "風呂トイレ別", topics: ["water"], ng: false, must: false },
  ];
  t("★ 点: ok 2（W1・W3）/ unknown 1 → 100", scoreChecks(ws, [{ id: "W1", result: "ok", why: "" }, { id: "W2", result: "unknown", why: "" }, { id: "W3", result: "ok", why: "" }]) === 100);
  t("★ 点: 必須の NG に当たれば 20 点が上限", scoreChecks(ws, [{ id: "W1", result: "ok", why: "" }, { id: "W2", result: "ng", why: "" }, { id: "W3", result: "ok", why: "" }]) === 20);
  t("★ 点: NG・必須は2倍（ok 1 + ng 1(重み1) → 50）", scoreChecks(ws, [{ id: "W1", result: "ok", why: "" }, { id: "W3", result: "ng", why: "" }]) === 50);
  t("★ 点: 判定できる物が無ければ null", scoreChecks(ws, [{ id: "W1", result: "unknown", why: "" }]) === null);
}
console.log(`\n合計: ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
