// app/lib/__tests__/draft-tag-intro.test.ts — 2026-10-02 ⑫ 6巡目の実物（実行: npx tsx app/lib/__tests__/draft-tag-intro.test.ts）
import { stripSystemDateTagLines, dedupeFirstIntroSentences } from "../draft-text";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const draft = "YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！\n\n【 日付:10/2(金)】\nこの度ご連絡頂きありがとうございます！！\nお部屋探しを担当させて頂きます鈴木と申します！！\n\nご条件お送り頂きありがとうございます😌！！\n西淀川区内・家賃65,000円まで…ピックアップしてお送りさせて頂きます！！";
const out = dedupeFirstIntroSentences(stripSystemDateTagLines(draft));
t("日付の見出しの行を落とす", !out.includes("日付"), out);
t("自己紹介の2回目を落とし1回目は残す", (out.match(/鈴木と申します/g) ?? []).length === 1 && out.startsWith("YUMAさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！"), out);
t("条件の文は残す", out.includes("ご条件お送り頂きありがとうございます😌！！") && out.includes("西淀川区内"), out);
t("【物件名 号室】の見出しは触らない", stripSystemDateTagLines("【プレリス阿波座Bloom 1302号室】\n初期費用") === "【プレリス阿波座Bloom 1302号室】\n初期費用");
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
