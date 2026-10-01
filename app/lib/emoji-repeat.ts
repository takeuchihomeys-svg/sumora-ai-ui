// app/lib/emoji-repeat.ts
// 出口: 1通の中で同じ絵文字を文末に2回以上使わない（純関数・DB 依存なし）。
//
// 2026-10-01 竹内「同じ絵文字を2重で使っているが、このような形に実際していない。もう一つの絵文字を使うか、絵文字を省いている。状況によって異なる」
//   実物（YUMA 9:31・物件オススメの2通目）:
//     「…YUMAさんにかなりオススメ出来るお部屋となります😊！！\n\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」
//
// 実送信で引いた線（scripts/audit-emoji-repeat.ts・180日・YUMA を除く）:
//   ・スタッフの文 5,540通（文が2つ以上）で、2文以上に絵文字を付けた通のうち「全部同じ絵文字」は 4.0%（59/1,492）。96% は違う絵文字を混ぜる
//   ・AI の下書きは同じ絵文字が 8.1%（スタッフの2倍）。下書きが同じ絵文字を2文以上に付けた 83組で、スタッフは 54組（65%）を直して送った
//   ・2通目の締めの直前の文に 😊 がある時、スタッフの締めは
//       内覧の誘導（お気に召されましたら…ご案内）… 絵文字なし 30 ／ 😌 0 ／ 😊 0
//       申込の誘導（…お部屋抑えさせて頂きます）  … 絵文字なし 15 ／ 😌 1〜2 ／ 😊 0
//       ご査収（お手隙の際にご査収ください）     … 絵文字なし 18 ／ 😌 20 ／ 😊 1
//   → 誘導の締めは絵文字を外す。それ以外の文は、まだ使っていない絵文字（😌→😊）に替え、両方使っていれば外す
//
// 見るのは文末の飾りの位置（「！！」「！」「。」の直前）の絵文字だけ。お客様の表示名（「🐈‍⬛さん」）や物件の見出し（🌟）は触らない。
// 文字（言葉）は1文字も消さない。絵文字を替えるか外すだけ。

const EMOJI = "\\p{Extended_Pictographic}(?:\\uFE0F|\\u200D\\p{Extended_Pictographic})*";
/** 文末の飾り: 絵文字（1〜2個）の直後に ！／!／。 */
const TAIL_EMOJI_RE = new RegExp(`((?:${EMOJI}){1,2})(?=[！!。])`, "gu");
const ONE_EMOJI_RE = new RegExp(EMOJI, "gu");

/** 誘導の締め（内覧・申込）。前に同じ絵文字があればスタッフは絵文字を付けない */
const INVITE_CLOSING_RE = /お気に召され(?:ましたら|た(?:お部屋)?).{0,40}(?:ご案内|案内させて|お申込|お申し込み|抑えさせ)/;
/** 替える先の順（スタッフの2つ目の絵文字の多い順） */
const ALTERNATES = ["😌", "😊"];

const bare = (e: string) => e.replace(/️/g, "");

export type EmojiRepeatFix = { text: string; changes: Array<{ from: string; to: string; sentence: string }> };

/**
 * 同じ絵文字が文末に2回目以降に出たら、誘導の締めは外し、他は未使用の 😌／😊 に替える（どちらも使っていれば外す）。
 * 1回目の絵文字はそのまま。文末の飾りが1つ以下の文は触らない。
 */
export function dedupeRepeatedEmoji(text: string | null | undefined): EmojiRepeatFix {
  const src = String(text ?? "");
  const changes: EmojiRepeatFix["changes"] = [];
  const used = new Set<string>();
  // 行ごとに見る（物件の見出しの行「🌟…」は飾りではないので数えない）
  const lines = src.split("\n").map((line) => {
    if (/^\s*🌟/.test(line)) return line;
    return line.replace(TAIL_EMOJI_RE, (whole: string, _g: string, offset: number) => {
      const ems = whole.match(ONE_EMOJI_RE) ?? [];
      const key = bare(ems[0] ?? "");
      if (!key) return whole;
      if (!used.has(key)) {
        for (const e of ems) used.add(bare(e));
        return whole;
      }
      // この文（行の中で、前の文の終わりから今の位置まで）
      const before = line.slice(0, offset);
      const start = Math.max(before.lastIndexOf("！"), before.lastIndexOf("!"), before.lastIndexOf("。"), before.lastIndexOf("？")) + 1;
      const sentence = line.slice(start, offset).trim();
      let to = "";
      if (!INVITE_CLOSING_RE.test(sentence)) to = ALTERNATES.find((a) => !used.has(a)) ?? "";
      if (to) used.add(to);
      changes.push({ from: whole, to, sentence: sentence.slice(0, 60) });
      return to;
    });
  });
  return { text: changes.length ? lines.join("\n") : src, changes };
}
