// 実行: npx tsx app/lib/__tests__/emoji-allowlist.test.ts
// 2026-10-02 竹内「絵文字は入れて良い絵文字だけにする。女性の絵文字いれない」
// 2026-10-02（2回目）竹内「🙇の絵文字入れない 😊 😌 🌟 ✨となる」「見積書の✅はのこす」
//   実送信（スタッフの手打ち・AIX の送信・AI の下書き・定型文）の本文をそのまま使う
import { enforceEmojiAllowlist, ALLOWED_EMOJIS } from "../emoji-allowlist";
import { normalizeBannedPhrasing } from "../banned-phrasing";
import { dedupeRepeatedEmoji } from "../emoji-repeat";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, note = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${note}`); } }
const eq = (name: string, input: string, want: string) => { const r = enforceEmojiAllowlist(input).text; t(name, r === want, `\n      got  ${JSON.stringify(r)}\n      want ${JSON.stringify(want)}`); };

t("入れてよい絵文字は 😊 😌 🌟 ✨", ALLOWED_EMOJIS.join("") === "😊😌🌟✨");

// ── 女性の絵文字・お辞儀 → 外す（人の実送信 5通の形。性別の無い形にも置き換えない）──
eq("🙇‍♀️ → 外す（何卒よろしく）", "お手数おかけしますが何卒よろしくお願い致します🙇‍♀️", "お手数おかけしますが何卒よろしくお願い致します");
eq("🙇‍♀️✨ → ✨（ご査収）", "お手隙の際にご査収ください🙇‍♀️✨", "お手隙の際にご査収ください✨");
eq("肌の色つき 🙇🏻‍♀️ → 外す", "引き続き何卒よろしくお願い致します🙇🏻‍♀️", "引き続き何卒よろしくお願い致します");
eq("🙇 → 外す", "申し訳ございません🙇 引き続きよろしくお願い致します", "申し訳ございません 引き続きよろしくお願い致します");
eq("🙆‍♀️ → 外す", "大丈夫です🙆‍♀️！！", "大丈夫です！！");
eq("💁‍♀️ → 外す", "ご案内させて頂きます💁‍♀️！！", "ご案内させて頂きます！！");
eq("👩 → 外す", "女性専用のお部屋です👩！！", "女性専用のお部屋です！！");
eq("🙇‍♂️ → 外す", "申し訳ございません🙇‍♂️", "申し訳ございません");
eq("🙏 → 外す（定型文「内覧後お礼」）", "本日は内覧にお越しいただきありがとうございました🙏\nいかがでしたでしょうか？", "本日は内覧にお越しいただきありがとうございました\nいかがでしたでしょうか？");

// ── 入れてよい物以外 ──
eq("💪 → 外す（後ろの空白は残す・前が文字）", "しっかり確認させていただきます💪 リフォーム", "しっかり確認させていただきます リフォーム");
eq("🏠 → 外す（前が空白なら後ろの空白も）", "サポートさせていただけます 🏠 ゆそひさん", "サポートさせていただけます ゆそひさん");
eq("👍 → 外す", "ご安心ください👍", "ご安心ください");
eq("☺️ → 😊", "ピックアップさせて頂きます☺️！", "ピックアップさせて頂きます😊！");
eq("⚠️（作業メモの印）→ 外す", "⚠️ 確認事項", "確認事項");

// ── ✅ は見積書（初期費用・見積・概算）の文の中だけ残す ──
eq("✅ 見積書の定型文は残す", "管理会社に初期費用の詳細を確認いたしました！\n概算はご案内の通りとなります✅", "管理会社に初期費用の詳細を確認いたしました！\n概算はご案内の通りとなります✅");
eq("✅ 空室確認の定型文では外す", "管理会社に確認いたしました！\n現在空室でございます✅\nご内覧もご案内可能です😊", "管理会社に確認いたしました！\n現在空室でございます\nご内覧もご案内可能です😊");

// ── 触らない ──
for (const s of [
  "YUMAさんお世話になっております！！\nかしこまりました😊！！\nお手隙の際にご査収ください😌！！",
  "🌟プレサンス梅田北ザ・ライブ 305\n家賃管理費込75,000円✨",
  "a🤫さん お世話になっております！！",              // 表示名
  "🐈‍⬛さん お世話になっております！！",              // 表示名（ZWJ）
  "💞さんにお送りさせて頂きます！！",                 // 表示名
  "南森町駅徒歩7分、Sayuri🌺さんにかなりオススメ出来るお部屋となります！！",
  "（ルッキズム風刺画、俺は右側🫪🧡さんご希望の…",   // 表示名が2つの絵文字
  "❤︎さん お世話になっております",                   // 文字として書いた記号
  "⚪︎家電・IoT 機器の操作\n⚪︎来客対応",            // 文字の記号の箇条書き
  "Copyright © 2026 ™ ‼ ↔",                          // 既定が文字の記号
  "かしこまりました！！\n確認させて頂きます！！",
]) t(`触らない: ${s.replace(/\s+/g, " ").slice(0, 30)}`, enforceEmojiAllowlist(s).text === s && enforceEmojiAllowlist(s).changes.length === 0, enforceEmojiAllowlist(s).text);

// ── 言葉は1文字も変えない ──
{
  const s = "お世話になっております。\nお話し頂きありがとう御座います🙇‍♀️ 引き続き何卒よろしくお願い致します💪✨";
  const strip = (x: string) => x.replace(/\p{Extended_Pictographic}|[‍️♀♂\s]/gu, "");
  t("絵文字以外の文字は同じ", strip(enforceEmojiAllowlist(s).text) === strip(s));
}

// ── 共通の入口: 仕上げ（normalizeBannedPhrasing）と最後（dedupeRepeatedEmoji）の両方で効く ──
t("normalizeBannedPhrasing でも直る（手本・AIX の仕上げ・applySurfaceFixes）",
  normalizeBannedPhrasing("お手数おかけしますが何卒よろしくお願い致します🙇‍♀️").text === "お手数おかけしますが何卒よろしくお願い致します");
t("dedupeRepeatedEmoji でも直る（返信・AIX・AIX テンプレートの最後）",
  dedupeRepeatedEmoji("ご安心ください👍\n何卒よろしくお願い致します🙇‍♀️").text === "ご安心ください\n何卒よろしくお願い致します");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
