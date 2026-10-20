// app/lib/staff-only-aix-1020.ts（純関数・DB/LLM なし）
// 2026-10-20 P0「AIX と返信の分け方」（竹内さん 10/20「AIが知らないスタッフしか確認できないことはAIXからの送信やで。ここの部分忘れてること多い」）。
//   既定は全部「何もしない」（STAFF_ONLY_AIX_1020=on で入る）。
//
// 本番 30日の見張り（返信の番でスタッフの送った文がスタッフだけが知る事の報告 91番・返信の番でスタッフが AIX を押した 96番）を全部分けた（読むだけ）:
//   多くはブレインの読み違いではなかった — 2段の約束（10/02 竹内さんの決定「いつも約束の返信を先に」）・ピックアップの約束の後のお礼（10/14 決定 C）・
//   約束を果たす報告が数時間後に来た（番の時点では結果がまだ無い）・内覧の当日の「着きました」の後の内覧後の挨拶・見張りの控えの穴（ブレインは AIX だった）。
//   ブレインの側の根は次の1つ（台帳が「管理会社の返事待ち」を約束と読まない）:
//
//   mgmt_pending … こちらが「管理会社に確認いただいております」「管理会社確認中となります」「担当者よりご返答あり次第ご連絡させていただきます」と
//     管理会社の返事待ちを伝えた通は、確認の約束（confirmation_promised）に記録されていなかった（30日のスタッフの文 9通・うち 2通は
//     「よりご返答あり」が報告の語に当たり確認の報告＝済みに読まれていた・1通は御見積書の送付と同じ通で約束が消えていた）。
//     → お客様のお礼・了承の番に約束を果たす AIX（確認した→管理会社に確認した／物件確認した）が立たず、ブレインは「確認でき次第ご連絡」の返信を書き、
//       スタッフは後で結果（スタッフだけが知る事）を手打ちしていた（本番 2996 番・子供の入居可否）。
//     直し（action-ledger）: ① 返事待ちの文を確認の約束に読む（交渉の文は further-discount の交渉の約束の道に任せる）
//                          ② 「よりご返答あり次第」を確認の報告に読まない ③ 同じ通に済みの行い（御見積書の送付 等）があっても、
//                             最後の発言の行い（lastStaffEntry）は返事待ちの約束にする（お礼の番に約束を果たす AIX を立てる resolveStaffPromiseAix が読む）
//
// 戻す: STAFF_ONLY_AIX_1020 を付けない（既定）。一部だけ: STAFF_ONLY_AIX_1020=mgmt_pending ／ on で全部・on でも STAFF_ONLY_AIX_1020_<名前>=off で1つ止める

type Env = Record<string, string | undefined>;

export const STAFF_ONLY_AIX_1020_PARTS = ["mgmt_pending"] as const;
export type StaffOnlyAix1020Part = (typeof STAFF_ONLY_AIX_1020_PARTS)[number];

export function staffOnlyAix1020(part: StaffOnlyAix1020Part, env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  const v = (env.STAFF_ONLY_AIX_1020 ?? "").trim().toLowerCase();
  if (!v || v === "off") return false;
  if ((env[`STAFF_ONLY_AIX_1020_${part.toUpperCase()}`] ?? "").trim().toLowerCase() === "off") return false;
  if (v === "on" || v === "all" || v === "1" || v === "true") return true;
  return v.split(",").map((s) => s.trim()).includes(part);
}

/**
 * 管理会社（担当者・オーナー・保証会社）の返事待ちを伝えた文（これから結果を伝える＝確認の約束）。
 *   ・「管理会社担当さんに子供のご入居が可能か確認いただいております」「現在駐輪場途中申請可能か管理会社確認中となります」
 *   ・「担当者よりご返答あり次第ご連絡させていただきます」「管理会社から連絡があり次第ご連絡させて頂きます」「ご返事待ちとなります」
 *   線: 本番 30日のスタッフの文 4,131通のうち当たる 10通を全部読んだ（どれも返事待ち・結果の報告は 0）
 */
export const MGMT_PENDING_RE = new RegExp([
  /(?:管理会社|オーナー|貸主|大家|保証会社|元付|担当(?:者|さん|社さん)?)[^\n。！!？?]{0,30}確認(?:いただいて|して(?:頂|いただ)いて|中)/.source,
  /確認中(?:です|となり|でございます|の(?:状況|為|ため))/.source,
  /(?:ご?返事|ご?返答|ご?回答|ご?連絡)(?:が)?(?:あり|有り|入り|届き|頂け|いただけ|頂き|いただき)?次第[^\n。！!？?]{0,15}(?:ご連絡|お伝え|ご報告|お知らせ)/.source,
  /(?:ご?返事|ご?返答|ご?回答)待ち/.source,
].join("|"));
/** 交渉・減額の文（further-discount の交渉の約束の道＝AIX【確認した→初期費用】に任せる） */
export const NEGOTIATION_WORD_RE = /交渉|減額|値下げ|値引き|お値引/;
/** 条件・お客様からの送付待ち（「お送り頂け次第」「ご入力頂けましたら」）は管理会社の返事待ちではない */
const NOT_MGMT_WAIT_RE = /(?:頂け|いただけ)(?:ましたら|たら|れば|次第)|(?:頂|いただ)き次第|お送り(?:頂|いただ)(?:き|け)|ございましたら|でしたら|あれば/;

/** 文の並びから、管理会社の返事待ちの文（交渉の文・条件の文を除く）を1つ。無ければ null */
export function findMgmtPendingSentence(sentences: readonly string[]): { sentence: string; evidence: string } | null {
  // 同じ通に交渉の文がある時（「交渉させていただきます。担当者よりご返事いただき次第ご連絡」）は交渉の約束の道に任せる
  if (sentences.some((s) => NEGOTIATION_WORD_RE.test(String(s ?? "").normalize("NFKC")))) return null;
  for (const raw of sentences) {
    const s = String(raw ?? "").normalize("NFKC").trim();
    if (!s) continue;
    const m = s.match(MGMT_PENDING_RE);
    if (!m) continue;
    if (NEGOTIATION_WORD_RE.test(s)) continue;
    // 「ご返事あり次第」は管理会社の返事待ち。それ以外の「〜次第」の条件（お客様の送付待ち）は外す
    if (NOT_MGMT_WAIT_RE.test(s.replace(MGMT_PENDING_RE, ""))) continue;
    return { sentence: s, evidence: m[0] };
  }
  return null;
}

/** 「よりご返答あり次第…」の待ちの句を除いた文（確認の報告の語「よりご返答あり」に当てない）。part が off なら文のまま */
export function stripPendingClause(sentence: string, env?: Env): string {
  if (!staffOnlyAix1020("mgmt_pending", env)) return sentence;
  return sentence.replace(/(?:より)?(?:ご)?(?:返事|返答|回答|連絡)(?:が)?(?:あり|有り|入り|届き|頂け|いただけ|頂き|いただき)?次第[^\n。！!？?]*/g, "");
}

/**
 * 返事待ちの約束の直後の、問い・頼みの無い反応だけの番（本番 2996「めちゃくちゃ安いですね！ありがとうございます！」＝御見積書への喜び＋お礼）。
 *   お礼・了承だけ（isAckOnly）と同じく、約束を果たす AIX（確認した→管理会社に確認した）の番として扱う。問い・頼み・物件の持ち込みがあれば当てない
 */
export function reactionOnlyAfterMgmtPending(i: { lastStaffMgmtPending: boolean; customerText: string | null | undefined; hasImage: boolean; env?: Env }): boolean {
  if (!staffOnlyAix1020("mgmt_pending", i.env) || !i.lastStaffMgmtPending || i.hasImage) return false;
  const t = String(i.customerText ?? "").normalize("NFKC").trim();
  if (!t || t.length > 60) return false;
  if (/https?:\/\/|\[(?:画像|動画|ファイル)\]/.test(t)) return false;
  return !/[?？]|ですか|ますか|でしょうか|ませんか|かな|ください|下さい|お願いでき|頂け(?:ます|ません)|いただけ(?:ます|ません)|可能|教えて|知りたい|ほしい|欲しい/.test(t);
}
