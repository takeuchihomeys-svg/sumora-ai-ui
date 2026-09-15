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
  // 2026-09-15 YUMA の下書き「お客様がスタンプのみで返信されている状況ですね。…追加の催促にならないよう、短く待つ姿勢のみを示します。」
  //   お客様への文はお客様を「〇〇さん」と呼び、「お客様が〜状況ですね」と三人称で状況を述べない／返し方の方針を「〜を示します」と書かない
  /^お客様(?:が|は)[^\n]{0,80}(?:状況|様子)(?:です|ですね|のようです)[。．]/,
  /(?:姿勢|方針|トーン)(?:のみ|だけ)?(?:を|で)(?:示し|返し|伝え|書き|返信し)(?:ます|ました)[。．]?\s*$/,
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

// ─── 形で見分ける（2026-09-15 竹内「こんなの絶対にいれない。文に変なデータが入ってしまう」・YUMA の下書き）───
//   言い回しの一覧（上の META_LINE_RES）は新しい言い回しが出るたびに漏れる（あや・TikTok・YUMA）。AI 下書き180日 2,669件のうち先頭行が
//   作業メモだったのは25件（「物件資料を確認します。」「いくつか確認してから出力します。」「〜のパターンで返信します。」「正確な回答が必要な質問です。」…）。
//   お客様への文には必ずお客様への言葉の特徴（！・？・絵文字・呼びかけ・敬語・「お部屋／ご案内」のようなお・ご付きの語・報告の「となります／おります」）が
//   あり、作業メモには無く「〜します。／〜です。」の地の文で終わる。
//   実測: スタッフの実送信の先頭行 6,905件で該当1件（本物の作業メモ「…親切に対応する返信を作成します。」）＝誤削除0、AI の作業メモ25件中22件を捕まえる

/** お客様への言葉の特徴。引用（「…」）の中とお客様の三人称（お客様）は見ない */
const CUSTOMER_FACING_RE = /[！!？?]|さん|様|させて|ください|下さい|でしょうか|お願い|ございま|御座いま|致し|いたし|頂|いただ|でした|となりま|おりま|ご[一-龯]|お[一-龯]|\p{Extended_Pictographic}/u;
/** 作業の宣言・判断の地の文の語尾（「かしこまりました。」「承知しました。」は含めない） */
const PLAIN_NARRATION_END_RE = /(?:ます|です)。\s*$|(?:確認|特定|整理|判断|把握)しました。\s*$/;

export function hasCustomerFacingMarker(line: string): boolean {
  return CUSTOMER_FACING_RE.test(line.replace(/「[^」]*」/g, "").replace(/お客様/g, ""));
}

/** お客様への言葉の特徴が1つも無く、作業の地の文で終わる行（先頭の作業メモの判定に使う） */
export function isPlainNarrationLine(line: string): boolean {
  const l = line.trim();
  return !!l && !hasCustomerFacingMarker(l) && PLAIN_NARRATION_END_RE.test(l);
}

/** 先頭に続く作業メモの行と区切り（空行・---）を落とす。後ろにお客様への文が残る時だけ（全部が地の文なら触らない） */
function stripLeadingNarration(text: string): { text: string; removed: string[] } {
  const lines = text.split("\n");
  const lead: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || /^[-—―=＿_]{3,}$/.test(t)) continue;
    if (isPlainNarrationLine(t) || isMetaNarrationLine(t)) { lead.push(t); continue; }
    break;
  }
  if (lead.length === 0 || i >= lines.length || !lines.slice(i).some((l) => hasCustomerFacingMarker(l))) return { text, removed: [] };
  return { text: lines.slice(i).join("\n"), removed: lead };
}

/** 作業メモの行を除き、見出しだけの前置きを外す。変わらなければ同じ文字列を返す */
export function stripMetaNarration(text: string): { text: string; removed: string[] } {
  if (!text) return { text, removed: [] };
  const lead = stripLeadingNarration(text);
  const removed: string[] = [...lead.removed];
  text = lead.text;
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
