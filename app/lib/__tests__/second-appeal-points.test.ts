// app/lib/__tests__/second-appeal-points.test.ts — 2通目の刺さる点（R の実物で）
import { rankAppealPoints, buildSecondAppealNote, firstMessagePoints, firstMessageSaving, secondAppealPointsOn } from "../second-appeal-points";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
// R の1通目（10/28 19:08・実物）
const R1 = "🌟S-RESIDENCE難波Briller 411\n\n（オススメポイント）\n・家賃69,000円・管理費10,000円（合計79,000円）\n・間取り：1R（洋室7.1帖）・専有面積23.52㎡\n・御堂筋線「大国町」徒歩6分、御堂筋線・四つ橋線「なんば」徒歩6分ですので職場の天王寺まで通いやすい立地となります！！\n・2014年9月築（築12年）\n・角部屋で風通し良く過ごしやすいお部屋です！！\n・浴室乾燥機・独立洗面台ではなく2口ガスコンロ・システムキッチン付き\n・オートロック・宅配ボックス・防犯カメラ完備\n・インターネット使用料不要で毎月の通信費も節約出来ます！！\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！";
t("既定 off", !secondAppealPointsOn({}) && secondAppealPointsOn({ AIX_SECOND_APPEAL_POINTS: "on" }));
t("オススメポイントの行は8行", firstMessagePoints(R1).length === 8, firstMessagePoints(R1));
const pts = rankAppealPoints({ firstMessage: R1, customerPoints: "内覧後に503号室を決めきれず、より納得できる部屋を急ぎで比べたい。職場は天王寺", conditions: "浪速区・家賃8万円以内・1K/1R・築20年以内・敷金礼金なし" });
t("R: 1番は職場の天王寺まで通いやすい", /天王寺/.test(pts[0]?.text ?? ""), pts);
t("R: 上位3つに角部屋かネット無料（比べたい＝決め手）", pts.some((p) => /角部屋|インターネット/.test(p.text)), pts);
t("R: 家賃・面積・築年だけの行は入らない", !pts.some((p) => /^家賃|^間取り|^2014年/.test(p.text)), pts);
t("節約額の一文", firstMessageSaving("・初期費用もイエヤスなら108,900円節約出来ます！！") === "初期費用もイエヤスなら108,900円節約出来ます", firstMessageSaving("・初期費用もイエヤスなら108,900円節約出来ます！！"));
const note = buildSecondAppealNote({ firstMessage: R1, customerPoints: "職場は天王寺", conditions: "", situation: "503号室と比べて決めたい" });
t("注記: 見出し・状況・羅列にしない", note.includes("【このお客様に刺さる点") && note.includes("今の状況: 503号室") && note.includes("並べるだけの文にしない"), note);
t("オススメポイントが無い1通目は空", buildSecondAppealNote({ firstMessage: "こちら募集中となります！！", customerPoints: "費用", conditions: "" }) === "");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
