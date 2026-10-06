// app/lib/__tests__/guarantor-prefill.test.ts — AIX【保証会社について】の先入れ（会話から物件・資料から保証会社）
// 実行: npx tsx app/lib/__tests__/guarantor-prefill.test.ts
// 2026-10-06 竹内さん（松浦 麻夜 事例）「なぜ物件きかれてるのに反映されていないのか…資料に保証会社記載されているので、それも読みとることはできないのか」
import { guarantorFromMaterial, guarantorSegmentsOf, companiesInSegment } from "../guarantor-material";
import { resolveGuarantorTargets } from "../guarantor-target";
import { staffLabelsOf } from "../confirm-target-property";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const names = (r: ReturnType<typeof guarantorFromMaterial>) => r.companies.map((c) => c.name).join("・");

console.log("■ 資料から保証会社（実物の文字）");
{
  // 松浦 麻夜 10/4 H-maison大正VII 106 の資料（リアプロの文字層の特記事項・折り返しのまま）
  const pdf = "条 件\n【条件】 ペット相談（小型犬、猫可）・2人入居可能・保証人不要・保証会\n社利用必須\n取引態様：媒介\n特記事項：\n募集戸数：2戸・保証会社：保証会社利用必須 興和アシスト 初回 総賃料の50%・保険：保険要加入 2年契約 20,000円・安心サポート24：1,100円（月額）\n";
  const r = guarantorFromMaterial({ pdfText: pdf });
  t("H-maison: 興和アシスト（1社）", r.status === "named" && names(r) === "興和アシスト", JSON.stringify(r));
  const l = guarantorFromMaterial({ lines: ["ペット: ペット相談", "保証会社: 保証会社利用必須 興和アシスト 初回 総賃料の50%", "連帯保証人: 保証人不要"] });
  t("読み取り行だけでも 興和アシスト", l.status === "named" && names(l) === "興和アシスト" && l.from === "lines");
}
{
  const r = guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須"] });
  t("「保証会社利用必須」だけ → 会社名なし（入れない）", r.status === "unnamed" && r.companies.length === 0);
  t("保証会社の記載なし → none", guarantorFromMaterial({ pdfText: "賃料 7万円\n敷金 なし" }).status === "none");
}
{
  // 種類はマスタで引く
  t("株式会社エポスカード → 信販系", (() => { const r = guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 株式会社エポスカード ※大手法人:加入免除相談可"] }); return names(r) === "エポスカード" && r.companies[0].type === "credit"; })());
  t("K-net株式会社 → 信用系", (() => { const r = guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 K-net株式会社 初回 総賃料50%"] }); return names(r) === "K-net" && r.companies[0].type === "shinyou"; })());
  t("近畿保証(K-net) は1社", names(guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 近畿保証(K-net)"] })) === "K-net");
  t("賃貸保証(セーフティー) → 日本セーフティー1社", names(guarantorFromMaterial({ lines: ["保証会社: 賃貸保証(セーフティー) 初回総賃料の70%(最低保証料3.5万円)"] })) === "日本セーフティー");
  t("株式会社クレディ・セゾン → クレディセゾン1社", names(guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 株式会社クレディ・セゾン ※大手法人:加入免除相談可"] })) === "クレディセゾン");
  t("ジェイリース(株)（全角の長音ゆれ）→ 1社", names(guarantorFromMaterial({ lines: ["保証会社: 利用必須, ジェイリ－ス(株)"] })) === "ジェイリース");
  t("西日本賃貸保証サービス を 日本賃貸保証 にしない", !names(guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 (株)西日本賃貸保証サービス"] })).includes("日本賃貸保証"));
}
{
  // マスタに無い会社は会社名の形の時だけ
  const r = guarantorFromMaterial({ lines: ["保証会社: アズ生活倶楽部(ALC/アルク)の加入必須"] });
  t("マスタに無い アズ生活倶楽部（倶楽部で終わる）", r.status === "named" && names(r) === "アズ生活倶楽部" && !r.companies[0].known);
  t("株式会社えるく（株式会社が付く）", names(guarantorFromMaterial({ lines: ["保証会社: 株式会社えるく 初回保証人有40%"] })) === "えるく");
  t("「初回保証料:総賃料の100%」は会社にしない", guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 初回保証料:総賃料の100% 更新時:20,000円/年毎"] }).status === "unnamed");
  t("「指定賃貸保証加入」は会社にしない", guarantorFromMaterial({ lines: ["保証会社: 指定賃貸保証加入（総賃料100%）"] }).status === "unnamed");
}
{
  // 2社以上は決めない
  t("エポスカード、全保連 2社審査 → multiple", guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 エポスカード、全保連 2社審査"] }).status === "multiple");
  t("JRAG・CASA → multiple", guarantorFromMaterial({ lines: ["保証会社: JRAG・CASA"] }).status === "multiple");
  // 「外国籍の方は【GTN】」「否決時」の後ろは数えない
  const g = guarantorFromMaterial({ pdfText: "保証会社\n初回保証料・・・月額賃料合計×100% ※外国籍の方は【GTN】利用可(初回保\n" });
  t("外国籍の方は【GTN】→ GTN を数えない", !names(g).includes("GTN"), names(g));
  t("否決時:ニッポンインシュア を数えない", names(guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 株式会社テナントファースト / エポス(否決時:ニッポンインシュア)"] })) === "テナントファースト・エポスカード");
}
{
  // 文字層の折り返し（「ルームバン⏎クインシュア」）
  const pdf = "特記事項：\n事務所:不可/飲食店:不可・ペット:不可・楽器:不可・二人入居:可・法人契約可・保証会社：保証会社利用必須 株式会社ルームバン\nクインシュア ■初期費用総賃料の50%・保険：保険要加入\n";
  t("折り返しをつないで ルームバンクインシュア", names(guarantorFromMaterial({ pdfText: pdf })) === "ルームバンクインシュア", JSON.stringify(guarantorSegmentsOf(pdf)));
  // 文字層を先に・読み取り行の読み違いは使わない
  const r = guarantorFromMaterial({ pdfText: "・保証会社：保証会社利用必須 S全保連 初回保証料:総賃料80%・保険：要\n", lines: ["保証会社: 保証会社利用必須 S全保証"] });
  t("文字層を先に（読み取り行の S全保証 を使わない）", names(r) === "全保連" && r.from === "pdf", names(r));
  t("見出しの外の「株式会社サイラス」（元付）は拾わない", companiesInSegment("保証会社利用必須").length === 0);
}

{
  // 監査で見つけた取り違え（2026-10-06）
  t("株式会社プレサンスコミュニティ（管理会社）を プレサンスギャランティ にしない", guarantorFromMaterial({ lines: ["保証会社: 株式会社プレサンスコミュニティ"] }).companies.every((c) => c.name !== "プレサンスギャランティ"));
  t("セゾン・エルズ他 → 2社", guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 セゾン・エルズ他 初回保証料30%~"] }).status === "multiple");
  const pdf = "特記事項：\n法人契約可・保証会社：保証会社利用必須 【個人契約の場合】保証会社利用必須 連帯保証人無し可 【信和CM保証】信和CM保証(信和保証プラン) 初回保証料:月\n額総額60% 月額手数料:月額総賃料の1%(最低1,000円) 年間保証料:10,000円 ※初回保証料は決済金でのお預かりとなります。 【全保連】初回保証料:月額総\n額60%、月額保証料:個人契約:1,700円 【法人契約の場合】※法人契約で保証会社加入の場合 【1番手】信和CM保証(信和保証プラン)・保険：保険要加入\n";
  t("保証人代行サービス保証料 → 会社にしない", guarantorFromMaterial({ lines: ["保証会社: 保証人代行サービス保証料 10,000円/入居時"] }).status === "unnamed");
  t("エポスカード、フォーディーネット → 2社", guarantorFromMaterial({ lines: ["保証会社: エポスカード、フォーディーネット"] }).status === "multiple");
  t("番号の並び（1いえらぶ2GTN(外国籍)3日本セーフティー）→ 2社以上", guarantorFromMaterial({ lines: ["保証会社: 利用必須(大)1いえらぶ2GTN(外国籍)3日本セーフティー、初回契約時:50%"] }).status === "multiple");
  t("「更新料1年」「1箇所」は番号の並びにしない（ジェイリース1社のまま）", names(guarantorFromMaterial({ lines: ["保証会社: 保証会社利用必須 ジェイリース 初回:賃料総額の50%・更新料10,000円/1年 ※外国籍の方はGTN 鍵交換1箇所"] })) === "ジェイリース");
  const r = guarantorFromMaterial({ pdfText: pdf });
  t("ラ・フェスタ真田山: 信和CM保証と全保連 → 2社（全保連だけにしない）", r.status === "multiple" && names(r).includes("信和CM保証") && names(r).includes("全保連"), names(r));
}

console.log("■ 会話から物件（実物の会話）");
{
  // 松浦 麻夜 10/2〜10/4（お客様の表示名・本文は実物のまま・URL なし）
  const M = [
    { id: "a1", createdAt: "2026-10-02T06:44:25Z", sender: "staff", text: "🌟JPmaison此花 201号室\n\nペット飼育可能な家賃管理費込み79700円の松浦さんにかなりオススメ出来るお部屋となります！！" },
    { id: "a2", createdAt: "2026-10-02T06:45:11Z", sender: "staff", text: "JPmaison此花 201号室が築浅4年で、なんば・梅田どちらにもアクセスしやすく、家賃管理費79700円の松浦さんにかなりオススメ出来るお部屋となります😊！！\n\nお手隙の際にご査収ください😌！！" },
    { id: "a3", createdAt: "2026-10-04T06:51:23Z", sender: "staff", text: "[画像: H-maison大正VII 106号室の資料・御見積書]" },
    { id: "a4", createdAt: "2026-10-04T06:51:23Z", sender: "staff", text: "[画像]" },
    { id: "a5", createdAt: "2026-10-04T06:51:23Z", sender: "staff", text: "🌟H-maison大正VII 106\n\n1件新着で松浦さんにかなりオススメ出来るお部屋が募集に出ました！！\n\n（オススメポイント）\n・家賃74,500円・管理費5,000円（合計79,500円）\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！" },
    { id: "a6", createdAt: "2026-10-04T06:52:41Z", sender: "staff", text: "お世話になっております！！\nこちらのお部屋如何でしょうか😌！！\n\n敷金礼金なしで初期費用を抑える事ができ、ペット可で松浦さんにかなりオススメ出来るお部屋となります！！" },
    { id: "a7", createdAt: "2026-10-04T08:46:06Z", sender: "customer", text: "ここは保証会社どこでしょうか？💦\nブラックでも通る可能性ありますか？" },
  ];
  t("見出し「🌟H-maison大正VII 106」（号室の字なし）を物件に数える", staffLabelsOf(M[4].text).includes("H-maison大正VII 106号室"), JSON.stringify(staffLabelsOf(M[4].text)));
  const r = resolveGuarantorTargets(M);
  t("「ここ」＝直前に送った H-maison大正VII 106（JPmaison此花 にしない）", r.names.length === 1 && r.names[0] === "H-maison大正VII 106号室", JSON.stringify(r));
  // 画像の印が無くても（送った画像の読み取りが無い時）見出しで決まる
  const r2 = resolveGuarantorTargets(M.filter((m) => m.id !== "a3"));
  t("画像の印なしでも 見出しで H-maison", r2.names[0] === "H-maison大正VII 106号室", JSON.stringify(r2));
  // 質問の後にお客様が別の物件（URL）を送った → 決めない
  const r3 = resolveGuarantorTargets([...M, { id: "a8", sender: "customer", text: "https://www.homes.co.jp/chintai/room/xxxx/" }]);
  t("質問の後にお客様の持ち込み → 決めない", r3.names.length === 0);
  // 引用返信（引用先がこちらの1通）
  const r4 = resolveGuarantorTargets([...M.slice(0, 6), { id: "a7", sender: "customer", text: "保証会社どこでしょうか？", quotedId: "a1" }]);
  t("引用返信 → 引用先の JPmaison此花 201号室", r4.names[0] === "JPmaison此花 201号室" && r4.source === "quoted", JSON.stringify(r4));
}
{
  // 指す語の無い質問＋直前の送付が複数 → 送付の全部
  const B = [
    { sender: "staff", text: "【メゾン加美北 305号室】\n御見積書同封させて頂きました" },
    { sender: "staff", text: "【カーザSun I 102号室】\n御見積書同封させて頂きました" },
    { sender: "customer", text: "ありがとうございます！保証会社はどこになりますか？" },
  ];
  const r = resolveGuarantorTargets(B);
  t("「保証会社はどこになりますか」＋送付2件 → 2件とも", r.names.length === 2 && r.source === "last_send", JSON.stringify(r));
  // 「ここ」＋送付2件 → 決めない
  const r2 = resolveGuarantorTargets([...B.slice(0, 2), { sender: "customer", text: "ここの保証会社はどこですか？" }]);
  t("「ここ」＋送付2件 → 決めない（理由つき）", r2.names.length === 0 && /2件/.test(r2.reason), JSON.stringify(r2));
  // 保証会社の質問が無い
  t("保証会社の質問が無い → 入れない", resolveGuarantorTargets([...B.slice(0, 2), { sender: "customer", text: "ありがとうございます" }]).names.length === 0);
  // お客様が名前を出した
  const r3 = resolveGuarantorTargets([...B.slice(0, 2), { sender: "customer", text: "カーザSun Iの保証会社はどこですか？" }]);
  t("名前を出した物件 → その1件", r3.names.length === 1 && r3.names[0] === "カーザSun I 102号室", JSON.stringify(r3));
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
