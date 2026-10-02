// app/lib/double-confirm-contact.ts
// 「確認しご連絡させて頂きます！！確認出来次第ご連絡させて頂きます！！」のように、同じ約束を1通で2回書いた2回目を落とす出口（純関数）。
//
// 2026-10-02 ⑫の再生で見つけた下書き「はい！！／最新の空き状況を確認しご連絡させて頂きます！！／確認出来次第ご連絡させて頂きます！！」。
// 線（6/15〜の ai_reply_examples line_reply）: 人の手打ち 2,831通で両方を含むのは1通（Sierra深江南…＝AI の下書きとほぼ同じ文を打ち直した物＝同じ重なり）・
//   AI の下書き 1,593通で4通。スタッフの確認の約束は「〇〇確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」か
//   「確認しご連絡させて頂きます！！」のどちらか1つ。
// 落とすのは、前の文に「確認し（て）…ご連絡させて頂きます」がある時の、**単独の文**「確認出来次第ご連絡させて頂きます（絵文字）！！」だけ。
//   「本日、管理会社の営業開始後に確認し、確認出来次第ご連絡させて頂きます」のように中身のある文は落とさない（言葉を消しすぎない）。

export type DoubleConfirmFix = { text: string; removed: string[] };

const FIRST_RE = /確認し(?:て)?(?:[^。！!\n]{0,10})?ご連絡させて(?:頂|いただ)きます/;
/** 単独の文の「確認出来次第ご連絡させて頂きます」（行頭か、前の文の終わり（！。）の直後） */
const SECOND_RE = /(^|\n|[！!。]\s*)確認(?:出来|でき)次第(?:、)?ご連絡させて(?:頂|いただ)きます(?:ので)?[😊😌✨]*[！!。]*/g;

export function dropDoubleConfirmContact(text: string | null | undefined): DoubleConfirmFix {
  const s = String(text ?? "");
  const first = s.match(FIRST_RE);
  if (!first || first.index === undefined) return { text: s, removed: [] };
  const after = first.index + first[0].length;
  const removed: string[] = [];
  const tail = s.slice(after).replace(SECOND_RE, (m, lead: string) => {
    // 「ので」で次の文に続く形（…ご連絡させて頂きますので、何卒…）は残す
    if (/ので[😊😌✨]*[！!。]*$/.test(m)) return m;
    removed.push(m.slice(lead.length).trim());
    return lead;
  });
  if (!removed.length) return { text: s, removed: [] };
  const out = (s.slice(0, after) + tail).replace(/\n{3,}/g, "\n\n").replace(/[ \t　]+$/gm, "").replace(/\n+$/, "");
  return { text: out, removed };
}
