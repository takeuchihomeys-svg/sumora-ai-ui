// app/lib/__tests__/recommend-fact-guard.test.ts
// 実行: npx tsx app/lib/__tests__/recommend-fact-guard.test.ts（全 PASS で exit 0）
import { parseLedgerFacts, checkFirstMessageFacts, applyFactDecisions, claimsInFirstMessage, stationsInText, dropPhrase } from "../recommend-fact-guard";
import { trimTranscriptRepetition } from "../recommend-fact-guard";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log(`✗ ${name}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`);
};

// KAORI さん（10/12 グランノーブルⅡ）の資料を書き写した形（台帳の指示＝交通の欄を写す）
const kaoriTr = `【物件の資料】
【間取り図の洗面】独立した洗面所
名称: グランノーブルⅡ
賃料: 203号室 68,000円
駐車場: 7,700円
共益費: 4,100円
町内会費: 350円
交通: 近鉄日本鉄道奈良線 瓢箪山駅 徒歩18分 / 近鉄日本鉄道奈良線 枚岡駅 徒歩22分
所在地: 〒579-8052 大阪府東大阪市上四条町20番28号
間取り: 2LDK
専有面積: 54.85㎡
間取り内容: 洋6・洋5.3・LDK10.3`;
const kaoriFirst = `🌟グランノーブルⅡ 203

1件新着でKAORIさんにかなりオススメ出来るお部屋が募集に出ました！！

（オススメポイント）
・家賃68,000円・管理費7,700円（合計75,700円）
・間取り：2LDK（リビング10.3帖、洋室6帖・洋室5.3帖）
・近鉄大阪線「河内山本」駅徒歩15分
・2019年9月築で築年数浅く
・独立洗面台・追い焚き・浴室乾燥機など水回り設備も充実`;

const kf = parseLedgerFacts(kaoriTr);
eq("KAORI 台帳の駅", kf.stations.map((s) => [s.station, s.walk]), [["瓢箪山", 18], ["枚岡", 22]]);
eq("KAORI 台帳の管理費（共益費だけ・駐車場は入れない）", [kf.adminFee, kf.parking], [4100, 7700]);
eq("KAORI 台帳の㎡・帖・洗面", [kf.areaSqm, kf.jo.sort((a, b) => a - b), kf.washbasin], [54.85, [5.3, 6, 10.3], "independent"]);

const kd = checkFirstMessageFacts({ message: kaoriFirst, ledger: kf, geo: { 河内山本: { ward: "八尾市", lines: ["近鉄大阪線", "近鉄信貴線"] } }, addressWard: "東大阪市" });
eq("KAORI の判定", kd.map((d) => [d.kind, d.verdict]), [["station", "conflict"], ["admin_fee", "fix"], ["jo", "ok"], ["jo", "ok"], ["jo", "ok"], ["washbasin", "ok"]]);
const ka = applyFactDecisions(kaoriFirst, kd, { exit: true, mode: "shadow" });
eq("KAORI 出口: 駅の行を落とし管理費と合計を直す", ka.text.includes("河内山本") || !ka.text.includes("・家賃68,000円・管理費4,100円（合計72,100円）"), false);
eq("KAORI 出口: 他の行は残る", ka.text.includes("・2019年9月築で築年数浅く") && ka.text.includes("・独立洗面台・追い焚き"), true);

// 交通が読めていない台帳（書き写しが交通を飛ばした）× 駅の表でも分からない → unverified（shadow では残す・on で落とす）
const noSt = parseLedgerFacts("【物件の資料】\n名称: X\n共益費: 4,100円");
const ud = checkFirstMessageFacts({ message: "・御堂筋線「江坂」駅徒歩5分", ledger: noSt, geo: {}, addressWard: null });
eq("出どころなし → unverified", ud.map((d) => d.verdict), ["unverified"]);
eq("shadow は落とさない", applyFactDecisions("・御堂筋線「江坂」駅徒歩5分\n・築浅", ud, { exit: true, mode: "shadow" }).text, "・御堂筋線「江坂」駅徒歩5分\n・築浅");
eq("on は行を落とす", applyFactDecisions("・御堂筋線「江坂」駅徒歩5分\n・築浅", ud, { exit: true, mode: "on" }).text, "・築浅");

// 未桜さん（エステムコート難波Ⅳ）: 設備欄は「洗面台（独立）」・間取り図はトイレと同じ部屋
const miou = parseLedgerFacts("【物件の資料】\n【間取り図の洗面】トイレと同じ部屋\n交通: 千日前線「桜川」徒歩7分\n設備: 洗面台（独立）・浴室乾燥機");
const md = checkFirstMessageFacts({ message: "・千日前線「桜川」駅徒歩7分\n・独立洗面台・浴室乾燥機付き", ledger: miou });
eq("未桜 判定", md.map((d) => [d.kind, d.verdict]), [["station", "ok"], ["washbasin", "conflict"]]);
eq("未桜 出口（on）: 独立洗面台だけ落とす", applyFactDecisions("・千日前線「桜川」駅徒歩7分\n・独立洗面台・浴室乾燥機付き", md, { exit: true, mode: "on" }).text, "・千日前線「桜川」駅徒歩7分\n・浴室乾燥機付き");

// 売上サポの資料にある駅は確か
eq("資料の文字にある駅 → ok", checkFirstMessageFacts({ message: "・谷町線「天神橋筋六丁目」駅徒歩3分", ledger: null, materialText: "交通 大阪メトロ谷町線 天神橋筋六丁目駅 徒歩3分" }).map((d) => d.verdict), ["ok"]);
// 徒歩の分の違い → fix
const wf = checkFirstMessageFacts({ message: "・「瓢箪山」駅徒歩15分", ledger: kf });
eq("徒歩の分が違う → fix", [wf[0].verdict, wf[0].to], ["fix", "「瓢箪山」駅徒歩18分"]);

// 主張の取り出し
eq("主張: 帖・㎡・管理費", claimsInFirstMessage("・管理費：8,670円\n・20.5㎡・洋6.5帖").map((c) => c.kind), ["admin_fee", "area", "jo"]);
eq("駅の読み: 路線つき", stationsInText("交通 阪急京都線「南方」駅 徒歩4分 バス停「三国」徒歩2分").map((s) => s.station), ["南方"]);
eq("文の中の語だけ落とす", dropPhrase("築浅、独立洗面台、ペット可のお部屋です！！", "独立洗面台"), "築浅、ペット可のお部屋です！！");

// 書き写しの繰り返しを切る
const rep = trimTranscriptRepetition("設備: A / B / 保証会社必須 / C / 保証会社必須 / D / 保証会社必須 / E / F");
eq("繰り返しを切る", [rep.trimmed, rep.text], [true, "設備: A / B / 保証会社必須 / C / 保証会社必須 / D"]);

const block = trimTranscriptRepetition("名称: X\nA: ○\nB: ○\nC: ○\nD: ○\n備考: Y\nA: ○\nB: ○\nC: ○\nD: ○\n備考: Y");
eq("一覧の2周目を切る", [block.trimmed, block.text], [true, "名称: X\nA: ○\nB: ○\nC: ○\nD: ○\n備考: Y"]);

const f2 = parseLedgerFacts("【物件の資料】\n交通: 近鉄奈良線 『東花園』駅徒歩5分\n賃料98,000〜104,000円 共益費6,000円\n備考: 京阪本線『千林』駅より徒歩1分");
eq("『』の駅・行の中の共益費・より", [f2.stations.map((s) => s.station), f2.adminFee], [["東花園", "千林"], 6000]);
eq("！！の後の駅", claimsInFirstMessage("円となります！！住吉東駅から徒歩4分").map((c) => (c as { station?: string }).station), ["住吉東"]);
eq("全角の帖", claimsInFirstMessage("洋室８．４帖").map((c) => (c as { value?: number }).value), [8.4]);

if (fail) { console.log(`\n${fail} 件 FAIL`); process.exit(1); }
console.log("\nALL PASS");
