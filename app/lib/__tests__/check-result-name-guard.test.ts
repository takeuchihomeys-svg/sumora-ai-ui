// app/lib/__tests__/check-result-name-guard.test.ts — 物件確認した に前のやり取りの別の物件名を書かせない（実物: ☆・10/26 be842674）
import { checkResultNameGuardOn, checkResultNameMaterial, estimateHeadName, propertyNamesInTexts } from "../check-result-name-guard";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };

// 実物の文（9/22 の通・10/26 の費用の文）
const hist = [
  "[画像] 22:23\n【物件タイトル】\nS-RESIDENCE堺筋本町Deux(1LDK/9階/32.",
  "【S-RESIDENCE堺筋本町Deux 909号室】\n\n初期費用さらに\n🌟88,000円割引させて頂き\n初期費用：259,180円",
  "⭐︎さんお世話になっております！！\nお送り頂きましたS-RESIDENCE堺筋本町Deuxの最大限割引しました初期費用の御見積書となります！！",
  "堺筋本町 2LDK 7階\nhttps://suumo.jp/chintai/bc_100532850605/\nby SUUMO",
  "空きありますか？",
  "お世話になっております！！\nかしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます！！",
];
const bundle = "【アーバネックス堺筋本町 701号室】\n\n初期費用さらに\n🌟137,750円割引させて頂き\n初期費用：173,480円";

t("既定 off", checkResultNameGuardOn({}) === false && checkResultNameGuardOn({ CHECK_RESULT_NAME_GUARD: "on" }) === true);
t("費用の文の見出しから物件名", estimateHeadName(bundle) === "アーバネックス堺筋本町 701号室");
t("見出しが無い・仮の名前は null", estimateHeadName("初期費用：1円") === null && estimateHeadName("【物件①】") === null);
const names = propertyNamesInTexts(hist);
t("履歴の物件名（見出し・お送り頂きました〇〇の）", names.length === 1 && /S-RESIDENCE堺筋本町Deux/.test(names[0]), names);

const m = checkResultNameMaterial({ inputNames: [""], estimateNames: [estimateHeadName(bundle)], historyTexts: hist });
t("入力が空なら見積書の見出しの物件名が対象", m.targets[0] === "アーバネックス堺筋本町 701号室" && m.fromEstimate[0] === true, m);
t("前のやり取りの別の物件は書かない行", m.lines.some((l) => /S-RESIDENCE堺筋本町Deux/.test(l) && /書かない/.test(l)), m.lines);
t("対象の物件名の行", m.lines.some((l) => /今回確認した物件名: アーバネックス堺筋本町 701号室/.test(l)));

const m2 = checkResultNameMaterial({ inputNames: ["グランド本町 502号室"], estimateNames: [estimateHeadName(bundle)], historyTexts: hist });
t("スタッフの入力が正（見積書より先）", m2.targets[0] === "グランド本町 502号室" && m2.fromEstimate[0] === false);

const m3 = checkResultNameMaterial({ inputNames: [""], estimateNames: [], historyTexts: hist });
t("名前が分からない時は物件名を作らない行だけ（今の番の物件を誤って外さない）", m3.targets[0] === "" && m3.lines.some((l) => /物件名を書かず/.test(l)) && !m3.lines.some((l) => /S-RESIDENCE/.test(l)), m3.lines);
const m5 = checkResultNameMaterial({ inputNames: ["アーバネックス堺筋本町 701号室"], estimateNames: [], historyTexts: hist, currentTexts: ["S-RESIDENCE堺筋本町Deuxもまだ空いてますか？"] });
t("お客様が今の番で書いた物件は「書かない」に入れない", !m5.lines.some((l) => /書かない/.test(l)), m5.lines);
t("画像の読みの節の見出し・案内の文は物件名にしない", propertyNamesInTexts(["【下部ボタン】 【緊急連絡先欄】 【物件タイトル】", "🌟パークハイツアイリス2号館 のみご案内可能です😊"]).length === 0);

const m4 = checkResultNameMaterial({ inputNames: ["S-RESIDENCE堺筋本町Deux 909号室"], estimateNames: [], historyTexts: hist });
t("同じ建物を確認した時は「書かない」に入れない", !m4.lines.some((l) => /書かない/.test(l)), m4.lines);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
