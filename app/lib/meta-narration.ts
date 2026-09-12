// app/lib/meta-narration.ts
// AI の作業メモ（返信を作る側の独り言）を返信本文から取り除く（純関数・DB 依存なし）
//
// 2026-09-12 竹内（あや事例）「こんな本文に入れていけないのは、テキストボックスに絶対にいれない」:
//   下書きの先頭に「「284,500円になる感じですか？」という金額確認質問への直接回答を組み立てます。」が入った
//   （最終チェックの自動修正 Sonnet の前置き。旧は「修正後：」「以下修正版です」だけ除去していた）。
//   過去200日のスタッフ送信にも作業メモがそのまま送られていた: 「〇〇さんへの返信案：」11件・
//   「TikTokのリンク送信が続いているため、お客様の意図を確認しながら、親切に対応する返信を作成します。」1件。
//   お客様への文は「〜させて頂きます！！」の敬語で、返信そのもの（回答・返信・文面）を目的語にして「作成します／組み立てます」とは書かない。
//   ※「「明日行けます」というお返事が、どのご質問に対するお返事なのか…」のようなお客様への問いかけは作業メモではない（消さない）

/** 1行まるごと作業メモの行 */
const META_LINE_RES: RegExp[] = [
  // 「〜」という〜質問への（直接）回答を組み立てます／作成します
  /(?:への|に対する|に対して)(?:直接)?(?:の)?(?:回答|返信|応答|返答|答え)(?:文)?(?:を|として)?(?:組み立て|作成|生成|出力|書き?|行い|返し|まとめ)/,
  // 返信（文・案・文面・本文・下書き）を作成します／組み立てます／書き直します（行末の地の文）
  /(?:返信|回答|返答|文章|文面|本文|下書き|ドラフト)(?:文|案)?を(?:作成|生成|組み立て|書き直|修正|出力|構成)(?:します|しました|いたします|致します|する|した)[。．]?\s*$/,
  // 〜を組み立てます（お客様への文に出てこない語）
  /を組み立て(?:ます|ました|る)[。．]?\s*$/,
  // 見出し: 「〇〇さんへの返信案：」「返信案：」「修正版：」「【返信案】」
  /^\s*(?:[^\n]{0,30}(?:さん|様)への)?(?:返信案|回答案|修正版|修正案|返信文|下書き)\s*[：:]\s*$/,
  /^\s*【(?:返信案|回答案|修正版|修正案|返信文|下書き)[^】]*】\s*$/,
];

/** 行頭だけが見出しで、同じ行に本文が続く形（「修正後：〇〇さんお世話になっております」）→ 見出しだけ除く */
const META_PREFIX_RE = /^\s*(?:[^\n]{0,30}(?:さん|様)への)?(?:返信案|回答案|修正版|修正案|修正後|返信文)\s*[：:]\s*/;

export function isMetaNarrationLine(line: string): boolean {
  const l = line.trim();
  if (!l) return false;
  // お客様への文（敬語の宣言・感嘆の「！！」・絵文字で終わる行）は作業メモとみなさない
  if (/[！!]{1,2}[😊😌✨🌟]*\s*$/.test(l) || /(?:させて(?:頂|いただ)き|でしょうか|ください|下さい)/.test(l)) return false;
  return META_LINE_RES.some((re) => re.test(l));
}

/** 作業メモの行を除き、見出しだけの前置きを外す。変わらなければ同じ文字列を返す */
export function stripMetaNarration(text: string): { text: string; removed: string[] } {
  if (!text) return { text, removed: [] };
  const removed: string[] = [];
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (isMetaNarrationLine(line)) { removed.push(line.trim()); continue; }
    const m = line.match(META_PREFIX_RE);
    if (m && line.slice(m[0].length).trim()) { removed.push(m[0].trim()); kept.push(line.slice(m[0].length)); continue; }
    kept.push(line);
  }
  if (removed.length === 0) return { text, removed };
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\s*\n+/, "").trimEnd();
  return { text: out, removed };
}
