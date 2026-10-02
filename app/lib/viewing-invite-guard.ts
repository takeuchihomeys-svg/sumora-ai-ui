// app/lib/viewing-invite-guard.ts
// ⚠ 判断（2026-10-02・本番 30日 scripts/audit-viewing-invite-overuse.ts）: ブレインが内覧調整の番 60 のうちスタッフが内覧調整を押したのは 全体 31%・確認待ち 29%・内覧の質問 40%
//   ＝確認待ち／質問で分けても押す割合が下がらない（線を引けない）→ ブレインには**入れない**。内覧調整の番の多くはスタッフが候補日を手打ちしていた（同じ中身の手打ち）。この関数は監査でだけ使う
// 2026-10-02 ⑫ 22巡の分類（B: 内覧調整の出しすぎ）: お客様が内覧に触れても、①こちらの確認の約束がまだ果たされていない
//   （ペットの可否・募集状況「確認させていただき…ご連絡」）②内覧についての質問（「4階以外の他の階も見れたりしますか」）の番は、
//   スタッフは内覧調整を押さず返信で答えていた。線は scripts/audit-viewing-invite-overuse.ts（本番30日のブレインの内覧調整の番）
type Msg = { sender: string; text: string };

const CONFIRM_DECL_RE = /(?:確認|お調べ|問い合わせ)(?:させて(?:頂|いただ)き|いたし|致し|し)[^\n。！!]{0,25}(?:ご連絡|お送り|お伝え)|(?:確認|撮影)(?:出来|でき)次第/;
const CONFIRM_REPORT_RE = /確認(?:しました|いたしました|致しました)(?:ところ|所)|とのこと(?:で|です|でした)|飼育(?:可能|不可)|募集(?:中|終了)(?:でした|です|となります)/;

/** 今回のお客様の番より前のこちらの発言に、まだ結果を返していない確認の約束があるか（古い順の会話・直近 8通のこちらの発言） */
export function pendingConfirmationBeforeTurn(messagesOldestFirst: ReadonlyArray<Msg>): boolean {
  const staff = messagesOldestFirst.filter((m) => m.sender !== "customer").slice(-8);
  for (let i = staff.length - 1; i >= 0; i--) {
    const t = staff[i].text ?? "";
    if (CONFIRM_REPORT_RE.test(t)) return false; // 結果を返した後
    if (CONFIRM_DECL_RE.test(t)) return true;
  }
  return false;
}

/** お客様の発言が内覧についての質問（内覧の時に何ができるか）か。日程の打診・内覧したい の依頼ではない */
export function customerAsksAboutViewing(turn: string | null | undefined): boolean {
  const t = String(turn ?? "").normalize("NFKC");
  return /(?:内覧|内見|見学)[^。\n]{0,24}(?:見れ|見られ|みれ|できますか|出来ますか|可能ですか|入れ|入れますか|ありますか)|(?:他の|別の|ほかの)(?:階|部屋|お部屋)[^。\n]{0,12}(?:見れ|見られ|みれ)/.test(t);
}
