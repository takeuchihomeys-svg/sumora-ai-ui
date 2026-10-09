// app/lib/__tests__/prompt-r11.test.ts — 11巡目: 数の制約・受けの語の置き換え（実行: npx tsx app/lib/__tests__/prompt-r11.test.ts）
//   置き換え元が今のプロンプトの文にあるか（無いと静かに効かない）・当てた後に旧の数が残らないか・DB の2本を外すか
import { readFileSync } from "node:fs";
import { applyPromptR11, PROMPT_R11_REPLACEMENTS, PROMPT_R11_DROP_LINES, promptR11Enabled } from "../prompt-r11";
import { STYLE_RULE, PHASE_COMMON_FORMAT, GENERATION_SYSTEM } from "../line-reply-prompts";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };
const src = ["app/lib/line-reply-prompts.ts", "app/api/generate-reply/route.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
for (const [from] of PROMPT_R11_REPLACEMENTS) t(`元の文がある: ${from.slice(0, 30)}`, src.includes(from));
const all = `${STYLE_RULE}\n${PHASE_COMMON_FORMAT}\n${GENERATION_SYSTEM}`;
const r = applyPromptR11(all, true);
t("！！は3回以内 が消える", !/！！」?は1?返信(?:につき)?3回以内/.test(r.text), r.text.match(/[^\n]{0,20}3回以内[^\n]{0,10}/)?.[0]);
t("計2回以内 が消える", !r.text.includes("計2回以内"));
t("字数の表が竹内さんの幅に", r.text.includes("竹内さんの手打ち・空白を除く") && !r.text.includes("了承/感謝 40〜90"));
t("②の確認の決め打ちが資料→確認に", !r.text.includes("「かしこまりました！！管理会社に確認させて頂きます！！確認出来次第ご連絡させて頂きます😌！！」（確認宣言のみ") && r.text.includes("資料に無い時だけ"));
t("開口語の対応表（依頼・新しい条件→お礼の文 47%）", r.text.includes("お礼の文（「ご条件お送り頂きありがとうございます！！」等・竹内さん 47%）"));
const db = "【AI学習ルール】\n・顧客からの確認依頼に返信する際、いきなりアクション予告に入らず、必ず承認の一言を挟むことで『本当に対応してくれるか』という心理的不安を即座に解消する。\n・NG構成：[承認][確認対応の宣言]で終わると…特に見積確認や再調査の依頼時は、対応中である旨だけでなく「確認出来次第お送りします」等の次アクション文を必ず挿入し、顧客が次に…\n・別のルール";
const d = applyPromptR11(db, true);
t("DB の2本（7c600c23・46195788）の行を外す・他は残す", !PROMPT_R11_DROP_LINES.some((m) => d.text.includes(m)) && d.text.includes("・別のルール") && d.text.includes("【AI学習ルール】"), d.text);
// 10/08 11:03Z 書き換え後の2本（rules_fix.sql）は外さない
const rewritten = "【AI学習ルール（参考）】\n・お客様の依頼（〜して・〜お願いします）には「かしこまりました！！」で受けてから次にする事を書く。お客様の質問には答えから入る（承認の一言を前に挟まない）。\n・確認・作成の約束を書いた時だけ、何がいつ届くか（「確認出来次第ご連絡」「作成しお送り」）を同じ文で1回書く。お客様が頼んでいない確認の約束を足す理由にしない。";
t("書き換え後の 7c600c23・46195788 は通る", applyPromptR11(rewritten, true).text === rewritten);
t("off では変えない", applyPromptR11(all, false).text === all);
t("PROMPT_R11=off", promptR11Enabled({ PROMPT_R11: "off" }) === false && promptR11Enabled({}) === true);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
