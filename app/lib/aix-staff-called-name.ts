// app/lib/aix-staff-called-name.ts
// スタッフが会話の冒頭で実際に呼んだ名前（「Rさん」「あさん」「❤︎さん」）を、形を問わず拾う（純関数・DB 依存なし）。
//
// 2026-10-06 ⑰（竹内さんの 10/02 の決定「相手を『お客様』と呼ばない・名前が無ければ呼ばない」の続き）:
//   AIX の下書きの名前の欄に「お客様」が入った 60日 30回のうち、スタッフは 18回は名前を書かず、12回は名前で呼んだ
//   （うち前にスタッフ自身が冒頭で2回以上呼んだ名前 8回）。aix/action の extractPreferredName は名前の「形」
//   （ひらがな2〜6・カタカナ2〜6・漢字1〜4）で本物かを決めるので、1文字・英字1文字・記号の呼び名を落としていた。
//   → スタッフが冒頭で2回以上呼んだ事実を証拠にして、形を問わず使う（1回だけは打ち間違い・別の人の可能性があるので使わない）。
//   名前でない語（お客様・オーナー・管理・皆 等）と、接続の語（よろしければ 等）は今まで通り外す。

/** 名前でない語（extractPreferredName と同じ並び） */
export const NON_NAME_RE = /(お客様|オーナー|大家|管理|業者|保証|担当|スタッフ|弊社|不動産|審査|通過|契約|入居|退去|申込|内覧|皆|各位|こちら|まずは|引き続き|何卒|改めて|よろし|宜し|もしよ|できれば|出来れば|ぜひ|是非)/;
/** 冒頭の呼びかけ（「〇〇さん」）。extractPreferredName と同じ切り出し */
const HEAD_CALL_RE = /^[\s「]*([^\s、。！？\n【】「」（）・]{1,8}?)さん/;

/** スタッフが会話の冒頭で2回以上呼んだ名前（一番新しく呼んだ物）。無ければ "" */
export function staffCalledName(messages: ReadonlyArray<{ sender?: string | null; text?: string | null }>, minTimes = 2): string {
  const count = new Map<string, number>();
  const order: string[] = [];
  for (const msg of messages) {
    if ((msg.sender ?? "") !== "staff" || !msg.text) continue;
    const m = String(msg.text).match(HEAD_CALL_RE);
    if (!m) continue;
    const name = m[1];
    if (NON_NAME_RE.test(name)) continue;
    count.set(name, (count.get(name) ?? 0) + 1);
    order.push(name);
  }
  for (let i = order.length - 1; i >= 0; i--) if ((count.get(order[i]) ?? 0) >= minTimes) return order[i];
  return "";
}
