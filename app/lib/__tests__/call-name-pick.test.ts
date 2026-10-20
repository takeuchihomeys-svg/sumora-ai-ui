// 2026-10-20 竹内さん（P1 979a4c55）「お客さんが LINE のアカウント名を🎀に変えてから呼び方も🎀さんに変わってしまった…最初呼んでいた名前で連絡する」
// 実行: npx tsx app/lib/__tests__/call-name-pick.test.ts
import { readFileSync } from "fs";
import { join } from "path";
import { hasNameLetter, pickCallName, sanOf, lockableCallNameSource, isCallableName } from "../call-name-pick";
import { maskHonorificNames } from "../pii-mask";
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
// 2026-10-20 竹内さんの答え「本当の名前が分からない会話は『表示名（絵文字）＋さん』で呼ぶ。数字だけ・空は名前なし」
t("本当の名前が無く表示名が絵文字だけ → 絵文字で呼ぶ（🎀）", pickCallName({ stored: null, conversational: "🎀" }) === "🎀" && pickCallName({ conversational: "", display: "🎀" }) === "🎀");
t("分かっている名前が表示名（絵文字）より先", pickCallName({ stored: "ayaka", display: "🎀" }) === "ayaka" && pickCallName({ conversational: "ayaka", display: "🎀" }) === "ayaka");
t("数字だけ・句読点だけ・空の表示名 → 名前なし", pickCallName({ display: "327" }) === "" && pickCallName({ display: "、" }) === "" && pickCallName({ display: "" }) === "");
t("呼べる名前（名前の字・絵文字・記号）", ["🎀", "❤︎", "⭐️", "♡♡", "★", "ayaka"].every((x) => isCallableName(x)) && !["327", "、", "", " "].some((x) => isCallableName(x)));
t("固定が絵文字だけ（旧の固定）→ 使わず会話の名前", pickCallName({ stored: "❤︎", conversational: "ゆき" }) === "ゆき");
t("敬称が付いて来ても外す", pickCallName({ conversational: "ayakaさん" }) === "ayaka");
t("「〇〇さん」: 絵文字は🎀さん・数字だけ・空なら空", sanOf("ayaka") === "ayakaさん" && sanOf("🎀") === "🎀さん" && sanOf("327") === "" && sanOf("") === "" && sanOf(null) === "");

console.log("■ 会話で確定した名前（スタッフの呼びかけ）は表示名より先・表示名が絵文字なら名前なし");
const msgs = [
  { sender: "staff", text: "ayakaさん、はじめまして😊！！この度ご連絡頂きありがとうございます！！" },
  { sender: "customer", text: "よろしくお願いします" },
];
const v = resolveAddressName({ messages: msgs, displayName: "🎀", pcName: "🎀" });
t("ayaka→🎀 の会話: スタッフが呼んだ ayaka", v.name === "ayaka" && v.source === "staff_greeting_head", v);
t("その名前は会話に固定してよい", lockableCallNameSource(v.source, v.name));
const v2 = resolveAddressName({ messages: [{ sender: "customer", text: "こんにちは" }], displayName: "🎀" });
t("呼びかけも名乗りも無く表示名が🎀 → 下書きの判定（resolveAddressName）は名前なしのまま（画面・AIX は pickCallName の display で🎀さん）", v2.name === "", v2);
t("2通目の文: 名前が無くても「さんお気に召されましたら」と崩れない", !src("app/page.tsx").includes("${customerName}さんお気に召されましたら") && src("app/page.tsx").split("${sanOf(customerName)}お気に召されましたら").length - 1 === 2);
t("テンプレートの「アカウント名さん」: 名前が無い時は「さん」を残さない", src("app/page.tsx").split("replace(/アカウント名((?:さん|様)?)/g").length - 1 === 2);
t("表示名・登録名・文の中の呼びかけからの名前は固定しない", !lockableCallNameSource("display", "ayaka") && !lockableCallNameSource("pc_name", "ayaka") && !lockableCallNameSource("staff_inline", "ayaka"));
t("名乗りは固定してよい・絵文字は固定しない", lockableCallNameSource("customer_self_intro", "竹田") && !lockableCallNameSource("staff_greeting_head", "🎀"));

console.log("■ DeepSeek に渡す材料の伏せ字（呼び名）");
t("短い呼び名は敬称つきの時だけ伏せる", maskHonorificNames("ゆきさん\nお世話になっております", ["ゆき"]) === "お客様\nお世話になっております");
t("駅名・物件名（敬称なし）は触らない", maskHonorificNames("日野駅の日野ハイツ", ["日野"]) === "日野駅の日野ハイツ" && maskHonorificNames("日野さんへ", ["日野"]) === "お客様へ");
t("語の途中（まゆきさん）は伏せない・絵文字の名前は触らない", maskHonorificNames("まゆきさん", ["ゆき"]) === "まゆきさん" && maskHonorificNames("🎀さん", ["🎀"]) === "🎀さん");
const pkn = src("app/lib/pii-known-names.ts");
t("当事者の別名に固定の呼び名（call_name）を入れる（返信の下書き・AIX の可逆の伏せ字）", pkn.includes(`select("property_customer_id, call_name")`) && pkn.includes("export async function loadKnownCallNames"));
t("返信の下書き・AIX: 他のお客様の呼び名も伏せる", src("app/api/generate-reply/route.ts").includes("...await loadKnownCallNames()]") && src("app/api/aix/action/route.ts").includes("...await loadKnownCallNames()]"));
const bc = src("app/lib/brain-core.ts");
t("ブレイン: DeepSeek に回る時だけ当事者の呼び名を伏せる（Claude は今のまま）", bc.includes("const brainRoutesAlt = willRouteAlt(") && bc.includes("const partyShortNames = brainRoutesAlt ?") && bc.split(", maskNames)").length - 1 === 1);
t("グループの会話は1回の呼びかけで固定しない", src("app/lib/address-name-server.ts").includes(`lockFromConv && !isGroup && locked.source === "resolved"`));

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
t("内覧誘導の文: 「お客様」を「〇〇さん」にしない・名前は sanOf", /const nameSan = /.test(src("app/api/aix/viewing-guide/route.ts")) && !/\$\{customerName\}さん/.test(src("app/api/aix/viewing-guide/route.ts")));
t("文の手直し: 名前は sanOf（数字だけは呼ばない）", /sanOf\(firstToken\)/.test(src("app/api/polish-draft/route.ts")));
t("見積: 絵文字だけの表示名を入居者名に入れない", /find\(\(x\) => hasNameLetter\(x\)\)/.test(src("app/lib/estimate-handoff-server.ts")));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
