// app/lib/rent-negotiation-guard.ts
// 「家賃・賃料の値下げ交渉をこれからする」という していない約束 を、入口（ブレインの返信の方向）で落とす純関数。
//
// 2026-09-23 竹内「家賃交渉は基本できないものだからいれない。この言い回しいれないようにする」
//
// ── 実物（1通）──
//   あっぴさん 9/23 の AI 下書き:
//     「かしこまりました😊！！ 条件に合うお部屋を引き続き探してお届けします！！
//       現在ご検討いただいている物件についても、家賃交渉ができないか管理会社に確認させて頂きます！！」
//
// ── 出所（追った結果）──
//   DeepSeek（返信生成）の創作ではなく、**ブレイン（Claude）の返信の方向（reply_direction）** に書かれていた:
//     9/21 dir「家賃交渉の確認を宣言し、同条件で新着物件のピックアップも継続する」
//     9/23 dir「感謝を受け取り、新着物件の検索と朝日プラザの家賃交渉を継続する姿勢を示す」
//   きっかけは顧客の「1個目間取りがいいですけど家賃が安いと嬉しかったですね！」→ concern「費用:家賃が安いと嬉しい」。
//   9/23 は一度も言っていない約束を **前回の自分の方向を根拠に「継続する」と既成事実化** していた
//   （9/22 の実送信に家賃交渉の文は無い）。方向は digest（brain_decision_logs.digest.dir）に残り次の回の材料になるため、
//   ここで落とさないと毎回コピーされ続ける。許可元は brain-core の「⑤ 家賃・管理費・礼金の値下げ交渉 → 橋渡しのみ」。
//
// ── 実送信で引いた線（365日・スタッフ送信 12,417通）──
//   家賃・賃料の値下げ／減額を **これから交渉・確認する未来形** … 0通（誤削除0）
//   家賃＋交渉語は全15通だが、目で読んだ内訳は
//     結果報告（過去形）3 ／ 管理費の値下げ3（顧客が依頼した後）／ 支払方法・スライドの交渉4 ／
//     物件情報（家賃減額募集中）3 ／ 顧客が明示的に依頼した確認1  → どれもこの関数では落とさない。
//   敷金・礼金の交渉は15通（実在するので残す）／初期費用の割引・抑えるは818通（＝会社の本当の答え）。
//   下書き ai_reply_examples 3,075件のうち家賃交渉入りは4件で、予告形3件は3件ともスタッフが削除、
//   残る1件（06-17）は「交渉させて頂きましたが減額は一切行っていない」＝過去形の結果報告。
//
// ── 入口と出口（設計知見「出口は誤削除0でなければ入れない」）──
//   入口（この関数）… 方向・key_topics から落とす／avoid_topics に語を足す。厳しくてよい。
//   出口（本文）……… final-check V15 RENT_NEGOTIATION_PROMISE を **block**（修正ループで書き直させる。決定論で本文を削らない）。
//                     2026-09-23 竹内「この言い回しいれないようにする」。誤削除0は2人が別々の正規表現で再現
//                     （実送信 12,419通で当たり0・守るべき過去形の結果報告3通は ALREADY_RE で残る）。
//                     warning のままだと「指摘は出るが本文は残る」（同じ日の「同じ約束を繰り返しています」と同じ構図）。

/** 家賃・賃料（管理費・礼金・敷金はここに含めない＝実在する交渉なので残す） */
const RENT_RE = "(?:家賃|賃料)";
/** 値下げ側の語 */
const CUT_RE = "(?:値下げ|値引き|減額|交渉|お安く)";
// 家賃と値下げ語が同じ節の中で近い（14字以内）。「家賃交渉」「家賃の減額交渉」「家賃値引き」
// 読点も区切りに入れる（「家賃8万円以下で探し、礼金の交渉もする」を1つながりにしない＝敷金礼金の交渉を巻き込まないため）。
// 逆順（交渉…家賃）は採らない: 「敷金礼金の交渉と、家賃の安いお部屋」を誤って落とすため（実送信15通の敷金礼金は残す）
const RENT_CUT_RE = new RegExp(`${RENT_RE}[^。！!？?、，,\\n]{0,14}${CUT_RE}`);
// こちらが「これからする」と言い切る形（⑦全件監査で足した条件）。
//   監査で止めた1件目: 「✅家賃の交渉について」＝お客様の質問を並べた見出し行（実送信）。
//   交渉・確認の語があるだけでは足りず、**実行の言い切り**（させて頂きます／確認する／可能か／継続する／宣言する）が要る。
const ACTION_COMMIT_RE = new RegExp(
  "(?:交渉|確認|相談|打診|依頼|申請|掛け合)[^。！!？?、，,\\n]{0,8}" +
  "(?:させて(?:頂|いただ)き)?(?:ます|ましょう|する|して(?:み)?ます|できないか|出来ないか|できるか|出来るか|可能か|可能性)" +
  // 2026-09-23 反証者の指摘: 連体・並列形「〜させて頂くなど」「〜させて頂き、」（7/18 の実物・スタッフが全削除）を拾っていなかった。
  //   足しても実送信 12,419通で当たり0は変わらない（反証者が確認）
  "|(?:交渉|確認|相談|打診)(?:を|も)?(?:させて(?:頂|いただ)(?:く|き[、，,]))" +
  "|(?:交渉|確認)(?:を|も)?(?:継続|続け|宣言)",
);
// 支払方法・スライドの交渉（実送信4通・値下げではない）は残す。⑦全件監査で止めた2件目・3件目:
//   「管理会社に家賃のスライド交渉させていただき、共益費の3,000円は賃料にスライド可能とのご返事でした」
//   「口座振り込みでの家賃支払いが問題ないか交渉させていただきます」
const PAYMENT_NEGOTIATION_RE = /スライド|お?支払|振込|振り込み|口座|引き落と|クレジット|分割/;
/** 済んだ話（過去形の結果報告・実送信3通はここで守る）。「交渉させて頂きましたが減額は一切行っていない」 */
const ALREADY_RE = /まし(?:た|て)|済(?:み|ま|ませ)|とのこと|結果|出来ません(?:でした)?|不可(?:でした)?|回答(?:を)?(?:頂|いただ)/;
// 2026-09-23 反証者の指摘: 断り文「家賃の交渉はお受け出来かねますが…」は約束ではない（「基本できない」と説明する方針で今後増える側）。
//   ⚠ 裸の「難し」は「エアコン新設が難しい場合でも…交渉させて頂くなど」（7/18 の実物・予告）まで守ってしまうので、断りは交渉の語の直後だけ
const DECLINE_RE = /(?:交渉|値下げ|値引き|減額)(?:は|も|に関しては|につきましては)?[^。！!？?\n]{0,6}(?:難し|(?:出来|でき)かね|お受け(?:出来|でき)|お断り|承(?:れ|る事が出来)ません)/;
/** お客様が自分から家賃の交渉・値下げを頼んだ（実送信1通あり。その時だけ通す） */
const CUSTOMER_ASK_RE = new RegExp(
  `${RENT_RE}[^。！!？?\\n]{0,14}(?:値下げ|値引き|減額|交渉)[^。！!？?\\n]{0,16}` +
  `(?:お願い|頼め|頼み|出来ますか|できますか|できませんか|出来ませんか|して(?:ほしい|欲しい|下さい|ください)|可能(?:でしょうか|ですか)|頂け|いただけ)`,
);

/**
 * 1文（節）が「家賃・賃料の値下げをこれからする」予告か。
 * 落とさない物: 敷金・礼金・管理費・支払方法の交渉／過去形の結果報告／家賃減額募集中の物件情報／家賃そのものの条件の話。
 */
export function isRentNegotiationPromise(sentence: string | null | undefined): boolean {
  const s = (sentence ?? "").trim();
  if (!s) return false;
  if (!RENT_CUT_RE.test(s)) return false;
  if (!ACTION_COMMIT_RE.test(s)) return false;
  if (PAYMENT_NEGOTIATION_RE.test(s)) return false;
  if (ALREADY_RE.test(s)) return false;
  if (DECLINE_RE.test(s)) return false;
  return true;
}

/**
 * 入口（ブレインの返信の方向・key_topics）用のゆるい判定。
 * 設計知見⑤「入口は厳しくてよい・出口は誤削除0でなければ入れない」に従い、
 * 方向・必須内容では **実行の言い切りが無い名詞句**（「家賃交渉の確認」「家賃交渉可能性」）も落とす。
 * 本文（出口）には使わない: 実送信の見出し行「✅家賃の交渉について」まで消してしまうため。
 */
export function isRentNegotiationTopic(text: string | null | undefined): boolean {
  const s = (text ?? "").trim();
  if (!s) return false;
  if (!RENT_CUT_RE.test(s)) return false;
  if (PAYMENT_NEGOTIATION_RE.test(s)) return false;
  if (ALREADY_RE.test(s)) return false;
  return true;
}

/** お客様が自分から家賃の値下げ交渉を依頼したか（「もう少し安くなりませんか？」は家賃の語が無いので当たらない＝07-21 の実送信は初期費用の割引だった） */
export function customerAskedRentNegotiation(texts: ReadonlyArray<string | null | undefined>): boolean {
  return texts.some((t) => CUSTOMER_ASK_RE.test((t ?? "").trim()));
}

/** 文・節に分ける（方向は1文で書かれるので読点も区切りにする） */
function clausesOf(text: string): string[] {
  return text.split(/(?<=[。！!？?、，,])/).map((s) => s).filter((s) => s.trim().length > 0);
}

export type RentGuardResult = {
  /** 落とした後の方向（全部落ちた・残りが短すぎる時は null） */
  text: string | null;
  /** 落とした節（digest に残す。null なら当たっていない） */
  dropped: string | null;
};

/**
 * ブレインの返信の方向（reply_direction）から家賃交渉の予告だけを落とす。
 * 節ごとに落とす（「家賃交渉の確認を宣言し、同条件で新着物件のピックアップも継続する」→ 後半だけ残る）。
 * 残りが8字未満になる時は null（方向を無理に作らない。本文側は avoid_topics で守る）。
 */
export function stripRentNegotiation(
  direction: string | null | undefined,
  opts: { customerAsked?: boolean } = {},
): RentGuardResult {
  const src = (direction ?? "").trim();
  if (!src) return { text: src || null, dropped: null };
  if (opts.customerAsked) return { text: src, dropped: null };
  const parts = clausesOf(src);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const p of parts) (isRentNegotiationTopic(p) ? dropped : kept).push(p);
  if (dropped.length === 0) return { text: src, dropped: null };
  const rest = kept.join("").replace(/^[、，,\s]+/, "").replace(/[、，,\s]+$/, "").trim();
  return { text: rest.length >= 8 ? rest : null, dropped: dropped.join("").trim().slice(0, 60) };
}

/** key_topics・next_steps など短い項目の配列から家賃交渉の予告を落とす */
export function stripRentNegotiationFromList(
  items: ReadonlyArray<string>,
  opts: { customerAsked?: boolean } = {},
): { items: string[]; dropped: string[] } {
  if (opts.customerAsked) return { items: [...items], dropped: [] };
  const kept: string[] = []; const dropped: string[] = [];
  for (const t of items) (isRentNegotiationTopic(t) ? dropped : kept).push(t);
  return { items: kept, dropped };
}

/** 落とした時に返信生成へ渡す禁止語（出口で消さない代わりに、入口で本文に書かせない） */
export const RENT_NEGOTIATION_AVOID_TOPICS = ["家賃交渉", "家賃の値下げ"] as const;
