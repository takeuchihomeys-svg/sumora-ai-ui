// app/lib/__tests__/current-property-gate.test.ts — 2026-10-13 主語の抜けの current_property の実在ゲート
//   実行: npx tsx app/lib/__tests__/current-property-gate.test.ts
import { currentPropertyExists, propertyCmpKey, refineCurrentProperty, currentPropertiesOf } from "../current-property-gate";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

const note = "【🏠 物件ごとの状況（この会話の台帳・今の番の物件を先に）】\n▶ 今の番の物件（主語の無い発言「ここ見てみたいです」）: 決まらない（直前のこちらの送信に物件が複数）。候補: ①大阪難波 Noah 203号室（9/28 12:30）・②RISING Maison 本町橋 1505号室（9/28 12:30）（送った順）";
t("旧の判定（会話にそのまま）", currentPropertyExists("LOHAS豊中稲津町", "LOHAS豊中稲津町", { history: "LOHAS豊中稲津町 のご紹介", sentNames: [] }));
t("空白の差（会話は空白なし）", currentPropertyExists("RISING Maison 本町橋 1505号室", "RISING Maison 本町橋", { history: "RISINGMaison本町橋1505号室です", sentNames: [] }));
t("台帳の ▶ の候補にある名前は通す", currentPropertyExists("大阪難波 Noah 203号室", "大阪難波 Noah", { history: "（画像）", sentNames: [], threadNote: note }));
t("全角・半角の差", currentPropertyExists("ＨＲ　ＦＲＯＮＴ", "ＨＲ　ＦＲＯＮＴ", { history: "HR FRONT REGAL ドームウエスト", sentNames: [] }));
t("どこにも無い名前は止める（創作）", !currentPropertyExists("グランドメゾン梅田", "グランドメゾン梅田", { history: "こちらのお部屋", sentNames: ["栄美グランドハイツ"], threadNote: note }));
t("戻す（off）と台帳は見ない", !currentPropertyExists("大阪難波 Noah 203号室", "大阪難波 Noah", { history: "", sentNames: [], threadNote: note }, { CURRENT_PROPERTY_GATE_V2: "off" }));
t("比べる形", propertyCmpKey(" A　b ") === "ab");
console.log("■ 区切り2 refineCurrentProperty（URL の番号・画像の読み取りにしか無い名前）");
{
  const img = "[画像] 物件種目：【住居用】マンション / 物件名：プレサンス戸原橋ヴィプラス / 号室名：0201（2階部分）";
  const staff = "【プレサンス芦原橋ヴィブラス 201号室】\n初期費用さらに";
  const r1 = refineCurrentProperty("プレサンス戸原橋ヴィプラス0201", { texts: [img, "初期費用お願いします", staff], ledgerNames: ["プレサンス芦原橋ヴィブラス 201号室", "スプランディッド難波キャトル 803号室"] });
  t("画像の読み取りにしか無い名前 → こちらの本文に書いた台帳の表記（同じ部屋）", r1.value === "プレサンス芦原橋ヴィブラス 201号室" && r1.reason === "ledger_canon");
  const r2 = refineCurrentProperty("プレサンス戸原橋ヴィプラス0201", { texts: [img], ledgerNames: ["スプランディッド難波キャトル 803号室"] });
  t("台帳に近い名前が無ければそのまま（お客様の画面の写しの名前は正しいことが多い）", r2.value === "プレサンス戸原橋ヴィプラス0201" && r2.reason === "kept");
  t("台帳の名前がこちらの本文に出ない（読み取りの化けの台帳）なら寄せない", refineCurrentProperty("セレニテ難波ブリエ 0611", { texts: ["[画像] セレニテ難波ブリエ 0611"], ledgerNames: ["セレニテ兼渡ブリエ 0611"] }).value === "セレニテ難波ブリエ 0611");
  t("階だけの名前は同じ階の部屋に寄せない（Luxe難波WEST 11階角部屋）", refineCurrentProperty("Luxe難波WEST 11階角部屋", { texts: ["[画像] Luxe難波WEST 11階", "Luxe難波WEST 1104号室抑えさせて頂きました"], ledgerNames: ["Luxe難波WEST 1104"] }).value === "Luxe難波WEST 11階角部屋");
  t("画面の仮の名前（物件no.92）は通さない", refineCurrentProperty("物件no.92", { texts: ["物件no.92"], ledgerNames: [] }).value === null);
  t("URL の番号は通さない", refineCurrentProperty("bc_100525219054", { texts: ["https://suumo.jp/chintai/bc_100525219054/"], ledgerNames: [] }).value === null);
  t("本文（画像以外）にある名前はそのまま", refineCurrentProperty("レジュールアッシュ難波MINAMI", { texts: ["レジュールアッシュ難波MINAMIです"], ledgerNames: [] }).value === "レジュールアッシュ難波MINAMI");
  t("台帳にある名前はそのまま", refineCurrentProperty("サウスパーク 3-C", { texts: [], ledgerNames: ["サウスパーク 3-C"] }).value === "サウスパーク 3-C");
  t("▶ の候補にある名前はそのまま", refineCurrentProperty("大阪難波 Noah 203号室", { texts: ["[画像]"], ledgerNames: [], threadNote: note }).value === "大阪難波 Noah 203号室");
  t("台帳の近い名前でも別の部屋なら寄せない", refineCurrentProperty("プレサンス戸原橋ヴィプラス0201", { texts: [img, "【プレサンス芦原橋ヴィブラス 305号室】"], ledgerNames: ["プレサンス芦原橋ヴィブラス 305号室"] }).value === "プレサンス戸原橋ヴィプラス0201");
  t("CURRENT_PROPERTY_LEDGER_CANON=off で今まで通り", refineCurrentProperty("bc_100525219054", { texts: [], ledgerNames: [] }, { CURRENT_PROPERTY_LEDGER_CANON: "off" }).value === "bc_100525219054");
  t("null はそのまま", refineCurrentProperty(null, { texts: [], ledgerNames: [] }).value === null);
}
console.log("■ 区切り5 currentPropertiesOf（今の番の物件の並び）");
{
  const note2 = "【🏠 物件ごとの状況】\n▶ 今の番の物件: カシータ神戸元町JP 401号室（募集状況・引用）\n  ・…\n▶ 今の番の物件: エステムコートみなと元町THE FIRST（募集状況・引用）";
  t("ブレインの物件を先・台帳の ▶ を後ろ（同じ物件は1つ）", JSON.stringify(currentPropertiesOf("カシータ神戸元町JP 401号室", note2)) === JSON.stringify(["カシータ神戸元町JP 401号室", "エステムコートみなと元町THE FIRST"]));
  t("ブレインの「A、B」を分ける", currentPropertiesOf("リブリ・スカイブルー ライズ 202、エイペックス神戸みなと元町", "").length === 2);
  t("ブレインが null なら ▶ だけ（使う側は current_property がある時だけ並びを使う）", currentPropertiesOf(null, note2).length === 2);
  t("CURRENT_PROPERTIES=off で current_property だけ", JSON.stringify(currentPropertiesOf("カシータ神戸元町JP 401号室", note2, { CURRENT_PROPERTIES: "off" })) === JSON.stringify(["カシータ神戸元町JP 401号室"]));
}
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
