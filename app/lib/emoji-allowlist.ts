// app/lib/emoji-allowlist.ts
// お客様への文に入れてよい絵文字だけにする（純関数・DB 依存なし）。
//
// 2026-10-02 竹内「絵文字は入れて良い絵文字だけにする。女性の絵文字いれない」
// 2026-10-02（同日の2回目）竹内「🙇の絵文字入れない 😊 😌 🌟 ✨となる」＝お辞儀も入れない（1回目は 🙇‍♀️→🙇 にしていた）。
//   「見積書の✅はのこす」＝初期費用・見積のテンプレートの ✅ だけは残す（下の CHECK_MARK_CONTEXT_RE）
//
// 【実送信で引いた線】（90日・YUMA と AI のまま送った文を除く手打ち 3,116通・scripts/audit-emoji-allowlist.ts）
//   😊 1,728 ／ 😌 852 ／ 🌟 103（物件の見出し）／ ✨ 25 ← 飾りとして使っているのはこの4つで 99%
//   それ以外は 10回以下で、多くは**お客様の表示名**（「a🤫さん」「🐈‍⬛さん」「Sayuri🌺さん」「❤︎さん」）。
//   飾りで出た残り（💪8・🏠5・👍4・💦4・🙏4・🙇‍♀️5・🙇1・💬2・💡2・😓2・😭1…）は少数で、文の型（「〜ね✨」「ご安心ください👍」）も
//   スタッフの型（「〜😊！！」「〜😌！！」）ではない。
//   AI の下書き（90日 2,504件）は 😊 936 ／ 😌 484 のほか ⚠️ 4・🧸 3・🤎 3・🫪 1・🧡 1・🤭 1（⚠️ は作業メモ・残りは表示名の写し）。
//
// 【決まり】
//   入れてよい: 😊 😌 🌟 ✨ だけ
//   性別の付いた絵文字（🙇‍♀️・🙆‍♀️・🙋‍♀️・💁‍♀️・♂ も）・👩・🙇・🙏 → 外す（性別の無い形に置き換えない）
//   笑顔の仲間（☺️ 🙂 😀 😃 😄 😁 😆 🥰）→ 😊 ／ それ以外 → 外す
//   ✅ は「初期費用・見積・概算」の文の中だけ残す（竹内「見積書の✅はのこす」。テンプレート「初期費用確認結果」の「概算はご案内の通りとなります✅」）
//   触らない: お客様の表示名の中の絵文字（後ろ15字以内に「さん／様／さま／ちゃん／くん」が続く）・文字として書かれた記号（FE0E の付いた ❤︎ ⚪︎、
//            既定が文字の © ™ ‼ ↔ ☺ 等＝絵文字の表示にしていない物）
//   言葉は1文字も変えない（絵文字を替えるか外すだけ。外した時に前が空白なら後ろの空白1つも一緒に外す）。
//
// 使う所（どれも同じこの関数）: banned-phrasing.normalizeBannedPhrasing（返信の仕上げ applySurfaceFixes・AIX の仕上げ・手本の文・
//   清書・補助ボタン）と emoji-repeat.dedupeRepeatedEmoji（返信・AIX・AIX テンプレートの最後）。

export const ALLOWED_EMOJIS = ["😊", "😌", "🌟", "✨"] as const;
const ALLOWED = new Set<string>(ALLOWED_EMOJIS);
/** ✅ を残す文（初期費用・見積の文の中だけ・竹内「見積書の✅はのこす」） */
export const CHECK_MARK_CONTEXT_RE = /見積|初期費用|概算/;
const CHECK_MARK = "✅";

const VS15 = "︎";
const ZWJ = "‍";
const FEMALE = "♀";
const MALE = "♂";
const WOMAN = "\u{1F469}";

/** 替える先（性別を外した後の形で引く）。無い物は外す */
const REPLACE: Record<string, string> = {
  "☺": "😊", "🙂": "😊", "😀": "😊", "😃": "😊", "😄": "😊", "😁": "😊", "😆": "😊", "🥰": "😊",
};

/**
 * 絵文字の塊（1つの見た目）: 本体＋（異体字セレクタ）＋（肌の色）＋（ZWJ でつながる続き）＋（後ろの空白1つ）。
 */
const CLUSTER_RE = /(\p{Extended_Pictographic})([️︎])?([\u{1F3FB}-\u{1F3FF}])?((?:‍(?:\p{Extended_Pictographic}|[♀♂])️?[\u{1F3FB}-\u{1F3FF}]?)*)( ?)/gu;
const PRESENTATION_RE = /\p{Emoji_Presentation}/u;
/** お客様の表示名の中（後ろに敬称が続く） */
const NAME_AHEAD_RE = /^[^\s、。！!？?\n「」]{0,15}?(?:さん|様|さま|ちゃん|くん)/;
const SKIN_OR_VS_RE = /[️\u{1F3FB}-\u{1F3FF}]/gu;

export type EmojiAllowFix = { text: string; changes: Array<{ from: string; to: string }> };

/** 入れてよい絵文字だけにする。変わらなければ同じ文字列を返す */
export function enforceEmojiAllowlist(text: string | null | undefined): EmojiAllowFix {
  const src = String(text ?? "");
  const changes: EmojiAllowFix["changes"] = [];
  if (!/\p{Extended_Pictographic}/u.test(src)) return { text: src, changes };
  const checkMarkOk = CHECK_MARK_CONTEXT_RE.test(src);
  const out = src.replace(CLUSTER_RE, (whole0: string, base: string, vs: string | undefined, _skin: string | undefined, zwj: string, sp: string, offset: number) => {
    const whole = sp ? whole0.slice(0, -1) : whole0;
    if (vs === VS15) return whole0;                                           // 文字として書いた記号（❤︎ ⚪︎）
    if (!vs && !zwj && !PRESENTATION_RE.test(base)) return whole0;            // 既定が文字の記号（© ™ ‼ ↔ ☺ 等・FE0F なし）
    if (NAME_AHEAD_RE.test(src.slice(offset + whole.length))) return whole0;  // お客様の表示名
    if (base === CHECK_MARK && !zwj && checkMarkOk) return whole0;            // 見積書の ✅
    const parts = (zwj ?? "").split(ZWJ).filter(Boolean).map((p) => p.replace(SKIN_OR_VS_RE, ""));
    let to = "";
    if (base === WOMAN || base === FEMALE || base === MALE || parts.length > 0) to = "";   // 性別つき・ZWJ の続き → 外す
    else if (ALLOWED.has(base)) to = base;
    else if (REPLACE[base]) to = REPLACE[base];
    // 入れてよい絵文字そのもの（異体字セレクタの有無は問わない）は触らない
    if (to && to === base && whole.replace(SKIN_OR_VS_RE, "") === base) return whole0;
    changes.push({ from: whole, to });
    // 外した時、前が空白・行頭なら後ろの空白も一緒に外す（「ください 🏠 その間に」→「ください その間に」）
    const prev = offset > 0 ? src[offset - 1] : "\n";
    return to ? `${to}${sp}` : (/\s/.test(prev) ? "" : sp);
  });
  if (!changes.length) return { text: src, changes };
  return { text: out, changes };
}
