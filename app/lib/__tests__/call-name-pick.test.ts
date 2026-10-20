// 2026-10-20 竹内さん（P1 979a4c55）「お客さんが LINE のアカウント名を🎀に変えてから呼び方も🎀さんに変わってしまった…最初呼んでいた名前で連絡する」
// 実行: npx tsx app/lib/__tests__/call-name-pick.test.ts
import { readFileSync } from "fs";
import { join } from "path";
import { hasNameLetter, pickCallName, sanOf, lockableCallNameSource } from "../call-name-pick";
import { resolveAddressName } from "../validate-reply";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const root = join(__dirname, "..", "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

console.log("■ 名前の字があるか");
t("絵文字・記号・数字だけは名前でない（🎀・❤︎・⭐️・327・、）", ["🎀", "❤︎", "⭐️", "327", "、", "♡♡", "⟡.·"].every((x) => !hasNameLetter(x)));
t("かな・カナ・漢字・英字は名前（1字も・竹内さん 10/08）", ["ayaka", "あ", "R", "サ", "関", "ふう", "ＭＩＫＡ"].every((x) => hasNameLetter(x)));

console.log("■ 呼び名を決める");
t("固定の呼び名を先に（表示名が🎀に変わっても ayaka）", pickCallName({ stored: "ayaka", conversational: "" }) === "ayaka");
t("固定が無ければ会話で決めた名前", pickCallName({ stored: null, conversational: "ayaka" }) === "ayaka");
t("会話で決めた名前が絵文字だけ → 名前なし", pickCallName({ stored: null, conversational: "🎀" }) === "");
t("固定が絵文字だけ（旧の固定）→ 使わず会話の名前", pickCallName({ stored: "❤︎", conversational: "ゆき" }) === "ゆき");
t("敬称が付いて来ても外す", pickCallName({ conversational: "ayakaさん" }) === "ayaka");
t("「〇〇さん」: 名前なしなら空", sanOf("ayaka") === "ayakaさん" && sanOf("🎀") === "" && sanOf("") === "" && sanOf(null) === "");

console.log("■ 会話で確定した名前（スタッフの呼びかけ）は表示名より先・表示名が絵文字なら名前なし");
const msgs = [
  { sender: "staff", text: "ayakaさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！" },
  { sender: "customer", text: "よろしくお願いします" },
];
const v = resolveAddressName({ messages: msgs, displayName: "🎀", pcName: "🎀" });
t("ayaka→🎀 の会話: スタッフが呼んだ ayaka", v.name === "ayaka" && v.source === "staff_greeting_head", v);
t("その名前は会話に固定してよい", lockableCallNameSource(v.source, v.name));
const v2 = resolveAddressName({ messages: [{ sender: "customer", text: "こんにちは" }], displayName: "🎀" });
t("呼びかけも名乗りも無く表示名が🎀 → 名前なし（🎀さんにしない）", v2.name === "", v2);
t("表示名・登録名・文の中の呼びかけからの名前は固定しない", !lockableCallNameSource("display", "ayaka") && !lockableCallNameSource("pc_name", "ayaka") && !lockableCallNameSource("staff_inline", "ayaka"));
t("名乗りは固定してよい・絵文字は固定しない", lockableCallNameSource("customer_self_intro", "竹田") && !lockableCallNameSource("staff_greeting_head", "🎀"));

console.log("■ 配線（名前の差し込み口）");
const pg = src("app/page.tsx");
t("画面: 呼び名の入口は conversationCallName（固定の呼び名 → 会話 → 表示名）", /function conversationCallName\(/.test(pg) && /const preferredCustomerName = useMemo\(\s*\(\) => conversationCallName\(selectedConversation\)/.test(pg));
t("画面: 会話の一覧が call_name を読む", /call_tapped_at,call_name"/.test(pg) && /callName: conversation\.call_name \?\? null/.test(pg));
t("画面: 内覧誘導・物件成約したのピッカーが表示名をそのまま使わない", !/const custName = conv\?\.customerName \?\? "お客様";/.test(pg) && /const custSan = sanOf\(preferredCustomerName\)/.test(pg));
t("画面: 文の手直しに会話の呼び名を渡す", /draft: replyDraft, customer_name: preferredCustomerName/.test(pg));
t("画面: 下書きの挨拶の名前も同じ入口", (pg.match(/canonOf\(conversationCallName\(conv\)\)/g) ?? []).length === 2);
const ans = src("app/lib/address-name-server.ts");
t("サーバー: 会話で確定した名前も固定・絵文字だけは固定しない", /lockableCallNameSource\(verdict\.source, locked\.name\)/.test(ans) && /hasNameLetter\(names\.callName\)/.test(ans) && /export async function callNameForConversation/.test(ans));
t("AIX: 会話がある時は固定の呼び名 → 会話の名前を先に", /callNameForConversation\(String\(conversationId\), rawName\)/.test(src("app/api/aix/action/route.ts")));
t("AIX のテンプレート: 同じ", /callNameForConversation\(conversationId, resolvedCustomerName\)/.test(src("app/api/aix-template-generate/route.ts")));
t("内覧誘導の文: 絵文字の名前・お客様を「〇〇さん」にしない", /const nameSan = /.test(src("app/api/aix/viewing-guide/route.ts")) && !/\$\{customerName\}さん/.test(src("app/api/aix/viewing-guide/route.ts")));
t("文の手直し: 絵文字の名前を「〇〇さん」にしない", /sanOf\(firstToken\)/.test(src("app/api/polish-draft/route.ts")));
t("見積: 絵文字だけの表示名を入居者名に入れない", /find\(\(x\) => hasNameLetter\(x\)\)/.test(src("app/lib/estimate-handoff-server.ts")));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
