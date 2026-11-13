// 材料と受け取る側（作業員G・2026-11-14）: 「DB にあるのにブレインが受け取っていない」3つの塞ぎのテスト（元の番の実物の文）
// 実行: npx tsx app/lib/__tests__/recv-material-1114.test.ts
import { estimateCardFillOn, cardCostsOf, fillItemsFromCards } from "../estimate-card-fill";
import { viewingCountInTimeAsked, matchCompanyFacts } from "../company-facts";
import { guarantorDocsOn, guarantorDocsAsked, guarantorDocsLine, type GuarantorDocRow } from "../guarantor-docs-line";
import { estimatesFromRecords } from "../sent-props-text";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };

// ─── ① 見積の札（ac34b364 11/13 13:57 の AIX【物件確認した】＋同封で実際に送った札の文） ───
const CARDS = [
  "【エクセランス梅田西 303号室】\n\n初期費用さらに 🌟24,500円割引させて頂き\n初期費用：255,700円\n\nイエヤスなら一般的な不動産業者より86,100円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
  "【サンハイツ園部 202号室】\n\n初期費用さらに 🌟10,000円割引させて頂き\n初期費用：170,800円\n\nイエヤスなら一般的な不動産業者より76,000円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
  "【レオンコンフォート本町クレセント 803号室】\n\n初期費用さらに 🌟25,000円割引させて頂き\n初期費用：253,500円\n\nイエヤスなら一般的な不動産業者より118,500円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
  "慶次さんお送り頂きました物件の中で\n・エクセランス梅田西 303号室　※ 別のお部屋が募集中\nこちら3件現在募集中となります！！",
];
ok("既定 off", estimateCardFillOn({}) === false && estimateCardFillOn({ ESTIMATE_CARD_FILL: "on" }) === true);
{
  const cards = cardCostsOf(CARDS);
  ok("札の文から3件（本文の通は札でない）", cards.length === 3, JSON.stringify(cards));
  const items = [
    { propertyName: "エクセランス梅田西", roomNo: "303", discountYen: null, initialCostYen: null },
    { propertyName: "サンハイツ園部", roomNo: "202", discountYen: null, initialCostYen: null },
    { propertyName: "レオンコンフォート本町クレセント", roomNo: "803", discountYen: null, initialCostYen: null },
  ];
  const f = fillItemsFromCards(items, cards);
  ok("check_names の3行が札の金額で埋まる", f.filled === 3 && f.items.map((x) => `${x.initialCostYen}/${x.discountYen}`).join() === "255700/24500,170800/10000,253500/25000", JSON.stringify(f.items));
  // 埋まった行は REF_RESOLVE の estimatesFromRecords が拾う（空の行は拾わなかった）
  const before = estimatesFromRecords(items.map((x) => ({ property_name: x.propertyName, room_no: x.roomNo, initial_cost_yen: x.initialCostYen, created_at: "2026-11-13T04:57:00Z" })));
  const after = estimatesFromRecords(f.items.map((x) => ({ property_name: x.propertyName, room_no: x.roomNo, initial_cost_yen: x.initialCostYen, created_at: "2026-11-13T04:57:00Z" })));
  ok("指す物の欄に届く数 0→3", before.length === 0 && after.length === 3, `${before.length}→${after.length}`);
  const g = fillItemsFromCards([{ propertyName: "エクセランス梅田西", roomNo: "1001", discountYen: null, initialCostYen: null }], cards);
  ok("号室が違えば埋めない（1001 に 303 の金額を入れない）", g.filled === 0);
  const h = fillItemsFromCards([{ propertyName: "サンハイツ園部", roomNo: "202", discountYen: 9, initialCostYen: 1 }], cards);
  ok("金額が既にある行は変えない", h.filled === 0 && h.items[0].initialCostYen === 1);
}
{
  // 22123（サニーレジデンス吉野Ⅱ 506）: 同じ建物の3札（502・505・506）
  const cards = cardCostsOf([
    "【サニーレジデンス吉野Ⅱ 502号室】\n初期費用：291,430円\nイエヤスなら一般的な不動産業者より99,550円節約出来ます！！",
    "【サニーレジデンス吉野Ⅱ 505号室】\n初期費用：300,180円",
    "【サニーレジデンス吉野Ⅱ 506号室】\n初期費用：302,680円",
  ]);
  const f = fillItemsFromCards([{ propertyName: "サニーレジデンス吉野Ⅱ", roomNo: "506", discountYen: null, initialCostYen: null }], cards);
  ok("同じ建物の札が3つ → 号室で当てる（506＝302,680円・割引の無い札は割引を空のまま）", f.filled === 1 && f.items[0].initialCostYen === 302680 && f.items[0].discountYen === null, JSON.stringify(f.items));
  const n = fillItemsFromCards([{ propertyName: "サニーレジデンス吉野Ⅱ", roomNo: null, discountYen: null, initialCostYen: null }], cards);
  ok("号室の無い行に同じ建物の札が2つ以上 → 決めない", n.filled === 0);
}
{
  // 21835（市岡2丁目戸建て・号室なし・割引の語なし）
  const f = fillItemsFromCards([{ propertyName: "市岡2丁目戸建て", roomNo: null, discountYen: null, initialCostYen: null }], cardCostsOf(["【市岡2丁目戸建て】\n\n初期費用：250,910円\n\nスモラなら一般的な不動産業者より69,000円節約出来ます！！"]));
  ok("号室の無い戸建ても名前で当てる・「節約」の額を割引にしない", f.filled === 1 && f.items[0].initialCostYen === 250910 && f.items[0].discountYen === null, JSON.stringify(f.items));
}

// ─── ② 内覧の件数と時間（36bb96d9 11/13 18:22 の実物）。180日の候補 11通のうち当てるのはこの1通だけ ───
const ON = { COMPANY_FACT_VIEWING_COUNT: "on" };
const ASKED = "30分でしたら1件ぐらいしか回れないですか？";
ok("既定 off", viewingCountInTimeAsked(ASKED, {}) === false);
ok("on: 「30分でしたら1件ぐらいしか回れない」を拾う", viewingCountInTimeAsked(ASKED, ON) === true);
for (const t of [
  "6月1日内覧3件の時間は何時から行けますか？",
  "この物件を内見したいのですが、14日日曜日の10時は可能でしょうか？",
  "ただ、内覧に行く時間がなくて 10日なら空いてるのですが ちなみに、今から11月末入居に出来そうでしょうか",
  "夜分遅くにすみません。 こちらの2件を内見させて頂きたいのです。",
  "この2件内見行きたいんですけど、12日ってお時間ありますか？",
  "⑥【ご希望の駅徒歩分数】⇒15分以内 内覧は2件",
]) ok(`on でも日時の調整・条件の文は拾わない: ${t.slice(0, 20)}`, viewingCountInTimeAsked(t, ON) === false);
{
  const prev = process.env.COMPANY_FACT_VIEWING_COUNT;
  ok("off の時は会社の事実（内覧の所要）が当たらない＝ブレインが「会社基準が無い」と書いた元", !matchCompanyFacts([ASKED]).some((f) => f.id === "viewing_duration"));
  process.env.COMPANY_FACT_VIEWING_COUNT = "on";
  ok("on の時は内覧の所要の事実（1部屋15〜30分＋移動）が届く", matchCompanyFacts([ASKED]).some((f) => f.id === "viewing_duration"));
  if (prev === undefined) delete process.env.COMPANY_FACT_VIEWING_COUNT; else process.env.COMPANY_FACT_VIEWING_COUNT = prev;
}

// ─── ③ 資料にある保証会社（b50fd451 11/13 14:11 のスタッフの文・売上サポの資料の文字層の実物） ───
ok("既定 off", guarantorDocsOn({}) === false && guarantorDocsOn({ BRAIN_GUARANTOR_DOCS: "on" }) === true);
ok("審査落ち→独立系で探す番は保証会社の話", guarantorDocsAsked(["まりあさん お世話になっております！！  これまでのお部屋大手の管理会社、審査厳しめの保証会社のお部屋のお申し込みで審査が否決となっております。  審査が比較的通過しやすい独立系の保証会社にてまりあさんにお勧めできるお部屋ピックアップさせていただきます！！"]));
ok("費用だけの番は読まない", !guarantorDocsAsked(["初期費用はどうなりますか？", "内見お願いしたいです"]));
{
  const now = Date.parse("2026-11-13T05:13:00Z");
  const rows: GuarantorDocRow[] = [
    { property_name: "Aレジデンス", room_no: "301", status: "sent", sent_at: "2026-10-19T08:43:00Z", expired_at: null, created_at: "2026-10-19T08:43:00Z", pdf_text: "保証会社：ジェイリース 初回:総賃料80%(保証人有) 初回:総賃料100%(保証人無) 月次:総賃料1.5%・保険： あそしあ", image_lines: [] },
    { property_name: "Bコート", room_no: "205", status: "sent", sent_at: "2026-10-10T05:38:00Z", expired_at: null, created_at: "2026-10-10T05:38:00Z", pdf_text: "保証会社利用無の場合敷金1ヶ月積増)■再契約手数料1ヶ月", image_lines: [] },
    { property_name: "Cハイツ", room_no: "102", status: "pending", sent_at: null, expired_at: null, created_at: "2026-11-12T00:00:00Z", pdf_text: "保証会社：日本賃貸保証 初回 総賃料の50%", image_lines: [] },
    { property_name: "Dメゾン", room_no: "803", status: "pending", sent_at: null, expired_at: null, created_at: "2026-11-12T00:00:00Z", pdf_text: "保証会社：オリコフォレントインシュア 保証委託料:初回保証料月額総賃料の60%", image_lines: [] },
    { property_name: "Eプラザ", room_no: "201", status: "pending", sent_at: null, expired_at: "2026-11-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", pdf_text: "保証会社：日本賃貸保証", image_lines: [] },
  ];
  const g = guarantorDocsLine(rows, { nowMs: now });
  ok("送った物件 2・名前あり 1（ジェイリース）・名前の無い物件は「資料に名前なし」", g.sent === 2 && g.sentNamed === 1 && /Aレジデンス 301＝ジェイリース（信用系）/.test(g.line) && /Bコート 205＝資料に名前なし/.test(g.line), g.line);
  ok("送れる候補は期限切れを除いて 2・独立系 1（日本賃貸保証）", g.ready === 2 && g.readyIndependent === 1 && /独立系 1件（Cハイツ 102）/.test(g.line), g.line);
  ok("人だけが知る事は AIX と添える", /管理会社に確かめる事（人だけが知る＝AIX/.test(g.line));
  ok("資料の行が無ければ空", guarantorDocsLine([], { nowMs: now }).line === "");
}

console.log(`recv-material-1114: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
