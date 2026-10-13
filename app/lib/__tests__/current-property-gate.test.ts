// app/lib/__tests__/current-property-gate.test.ts — 2026-10-13 主語の抜けの current_property の実在ゲート
//   実行: npx tsx app/lib/__tests__/current-property-gate.test.ts
import { currentPropertyExists, propertyCmpKey } from "../current-property-gate";
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
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
