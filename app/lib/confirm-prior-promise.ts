// app/lib/confirm-prior-promise.ts — 前の番で対象を書いて約束した確認を、お礼・了承の番で「確認出来次第ご連絡」と言い直す形を見分ける（純関数）
//
// 2026-11-13 作業員9（統括役・最終チェックの直し 2・昨夜の点検 scripts/audit-final-check-roots.ts）:
//   8f67f33b（11/08）: こちら「プレサンス立売堀アーバンスタイルの募集状況確認させて頂きます！！」→ お客様「ご協力ありがとうございます」
//   → 下書き「はい！！\n確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します😌！！」（竹内さんの送信と同じ文）を
//   CONFIRM_NO_OBJECT（対象が会話に無い確認の約束＝創作約束）で block していた。対象は前の通に書いてあり、創作ではない。
//   線: お客様の今の発言がお礼・了承だけ（問い・新しい依頼が無い）で、直前のお客様の発言の後のこちらの返信（AIX 以外）に
//   「〇〇確認させて頂きます」（対象つきの確認の宣言）がある時だけ、その対象を返す。
//   既定 off（FC_CONFIRM_PRIOR_PROMISE=on で、final-check の CONFIRM_NO_OBJECT を info に下げる）。

const ACK_ONLY_RE = /^(?:[^？?]{0,60})$/;
const ACK_WORD_RE = /ありがと|有難|よろしく|宜しく|お願い(?:します|致します|いたします)|助かり|了解|承知|わかりました|分かりました|かしこまり|ご協力|お手数/;
const ASK_RE = /[？?]|ますか|でしょうか|ですか|ませんか|教えて|頂けますか|いただけますか|ください(?!ね)/;
const DECL_WITH_OBJECT_RE = /([^\n。！!、]{2,30}?)(?:を|について(?:は)?)?(?:管理会社(?:様)?に)?確認させて(?:頂|いただ)き/;

export function confirmPriorPromiseOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FC_CONFIRM_PRIOR_PROMISE ?? "").trim().toLowerCase() === "on";
}

/** お礼・了承だけの発言か（問い・依頼が無い・短い） */
export function isAckOnlyCustomer(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC").trim();
  if (!t || t.length > 60) return false;
  return ACK_ONLY_RE.test(t) && ACK_WORD_RE.test(t) && !ASK_RE.test(t);
}

type Msg = { sender: string; text: string | null | undefined; isAix?: boolean };

/**
 * 直前のお客様の発言の後のこちらの返信（AIX 以外）に、対象つきの確認の宣言があればその対象を返す。
 * recent は古い順。末尾のお客様の通（今の番）は飛ばしてから見る。
 */
export function priorStaffConfirmObject(recent: ReadonlyArray<Msg> | null | undefined, customerText: string | null | undefined): string | null {
  if (!isAckOnlyCustomer(customerText)) return null;
  const ms = [...(recent ?? [])];
  let i = ms.length - 1;
  while (i >= 0 && ms[i].sender === "customer") i--; // 今の番のお客様の通
  for (; i >= 0 && ms[i].sender !== "customer"; i--) {
    const m = ms[i];
    if (m.isAix) continue;
    const hit = String(m.text ?? "").match(DECL_WITH_OBJECT_RE);
    if (hit && hit[1].trim().length >= 2) return hit[1].trim();
  }
  return null;
}
