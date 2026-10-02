// app/lib/final-check-overfire.ts — 最終チェックの2つの規則の線（純関数・DB 依存なし）
//
// 2026-10-02 竹内さんの指示「誤発火の3つ（FAREWELL_ON_MOVEOUT_INFO・DUPLICATE_OF_SENT・条件フォームの SENSITIVE_CASE）を実送信で線を引き直す」
//   監査 scripts/audit-overfire-three.ts（365日・お客様の番に続くスタッフの手打ちの返事 3,636通・YUMA を除く）で、人の文に当たった物を全部読んで線を引いた。
//   ③ SENSITIVE_CASE は app/lib/sensitive-case.ts（条件フォームの誤発火は ⑦ の 10/01 の直しで 0・残りの2つの形をそこで外した）。
import { classifyMoveOutSubject, CURRENT_HOME_MOVEOUT_CLAUSE_RE } from "./move-out-context";
import { CUST_WITHDRAWAL_SRC } from "./reply-context";
import { isAckOnlyCustomerText } from "./final-check-gate";

/** 会話を終える語（final-check.ts の FAREWELL_ON_MOVEOUT_INFO と同じ） */
export const FAREWELL_TEXT_RE = /またお部屋探しの際は|この度はありがとうございました|ご縁があり|またのご縁|またの機会|お気をつけて|お元気で/;

// ① FAREWELL_ON_MOVEOUT_INFO: お客様の「今の家の退去・引越し・転勤」の話を、お部屋探しをやめる話と誤読した会話の締めを止める規則。
//   人の文で当たったのは1通: 「申し訳ありません。転勤の件無くなりましたので今回は見送りでお願いします。」→ スタッフ「かしこまりました！！またお部屋探しをされる際は…」
//   ＝転勤が無くなった（引越し自体をやめた）のでお客様は探すのをやめている。締めが正しい。classifyMoveOutSubject は「転勤」で current_home と読んでいた。
//   → お客様の発言から今の家の退去の句を除いた残りに、やめる・見送る・無くなった の語があれば当てない（generate-reply の断りの判定 CUST_WITHDRAWAL_SRC と同じ語＋2つ）
const SEARCH_STOP_EXTRA_RE = /見送り(?:で|に|と)|今回は(?:見送|大丈夫|結構|やめ)|(?:件|話|予定|転勤|異動|引っ?越し)(?:が|は|も)?(?:無く|なく)なり/;
const WITHDRAWAL_RE = new RegExp(CUST_WITHDRAWAL_SRC);

/** お客様が探すのをやめた（断った）か。今の家の退去の句は除いて読む */
export function customerStoppedSearch(customerText: string): boolean {
  const rest = String(customerText ?? "").replace(CURRENT_HOME_MOVEOUT_CLAUSE_RE, "");
  return WITHDRAWAL_RE.test(rest) || SEARCH_STOP_EXTRA_RE.test(rest);
}

/** FAREWELL_ON_MOVEOUT_INFO が当たるか（moveOutSubject は generate-reply が渡す値。無ければお客様の発言から求める） */
export function farewellOnMoveOutHit(customerText: string, text: string, moveOutSubject?: string | null): boolean {
  const subject = moveOutSubject ?? classifyMoveOutSubject(customerText);
  return subject === "current_home" && FAREWELL_TEXT_RE.test(text) && !customerStoppedSearch(customerText);
}

// ② DUPLICATE_OF_SENT: 直前にこちらが送った文とほぼ同じ下書きを止める規則（2026-09-15 竹内・朱莉事例「前に送ってる文と同じ内容を生成しない」）。
//   朱莉: こちら「朱莉さん気になる点出てきましたら何時でもお気軽にご連絡ください😌！！」→ お客様「ありがとうございます！」→ 下書きがほぼ同じ文。
//   人の文で当たったのは 15通。お客様が**新しい事を言った番**（質問「本日電話いける時間ありますか？」・物件の URL・「もうすぐ着きます」
//   「19:00ギリギリつきます」・審査に落ちた会社の一覧・生年月日の数字・画像）にスタッフが前と同じ答えを返したのは正しい（同じ問いには同じ答え）。
//   止めたいのはお客様が**了承・お礼だけ**の番に同じ締めを繰り返す形（朱莉）＝お客様の発言が了承・お礼だけの時だけ当てる。
//   （「なるほど！かしこまりました」も了承として読む）
export function duplicateOfSentApplies(customerText: string): boolean {
  return isAckOnlyCustomerText(String(customerText ?? "").replace(/なるほど(?:です)?/g, ""));
}
