// app/lib/__tests__/final-check-staff-name.test.ts — 担当者の名乗りに付いた FABRICATED_NAME だけを外す（本物の名前の誤り・壊れは残す）
// 実行: npx tsx app/lib/__tests__/final-check-staff-name.test.ts
// 2026-10-06 点検: 引用は本番の記録（conversations.ai_draft_check・line_watch_turns の FABRICATED_NAME 全17件）をそのまま使う
import { isStaffSelfIntroNameFlag } from "../final-check-staff-name";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

// 外す（担当者＝鈴木の正しい名乗り）
const DROP = [
  "お部屋探しを担当させて頂きます鈴木と申します",
  "鈴木と申します",
  "担当者名：鈴木",
  "担当者名： 鈴木",
];
// 残す（お客様の名前の誤り・名前の壊れ・名前の無い引用）
const KEEP = [
  "ご連絡お待ち角田ております！！お部屋お気に召されま角田たら",
  "かしこまりました！！",
  "あいりさん",
  "か角田こまりま角田た！！ / 角田さんにオススメできるよう / 角田さんがご満足頂くお部屋 / お部屋探角田全力で",
  "森本様",
  "か角田こまりま角田た😊！！\n内装白・築浅で初期費用も抑えられるお部屋、松屋町周辺全域からピックアップ角田てお送りさせて頂きます！！",
  "何卒よろしくお願い致します",
  "か角田こまりま角田た",
  "akaneyさん、お世話になっております！！",
  "お部屋お気に召されま角田たら",
  // 名乗りとお客様の呼びかけが同じ引用にある時は外さない（呼びかけの名前の誤りかもしれない）
  "鈴木様、はじめまして😊！！お部屋探しを担当させて頂きます鈴木と申します",
  "佐藤さん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します",
];
for (const e of DROP) t(`外す: ${e.slice(0, 30)}`, isStaffSelfIntroNameFlag("FABRICATED_NAME", e));
for (const e of KEEP) t(`残す: ${e.slice(0, 30).replace(/\n/g, " ")}`, !isStaffSelfIntroNameFlag("FABRICATED_NAME", e));
t("他の code は対象外", !isStaffSelfIntroNameFlag("FABRICATED_POLICY", "鈴木と申します"));

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
