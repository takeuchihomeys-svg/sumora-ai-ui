// app/lib/payment-timing-wording.ts
// 初期費用のお支払いの時期の話で、スタッフが書かない言い切り・誤りを落とす出口（純関数）。
//
// 2026-10-02 竹内さん（YUMA の LINE を読んで）:
//   ①「…それより前にお支払い頂くことはありませんのでご安心ください」→「それより前に〜の部分、ここでは断定的な表現使わない」
//   ②（AIX【申込へ！】）「まずは審査を進めて、ご希望に合えば今月のご入金でお部屋を押さえさせていただきます！！」
//     →「入金のタイミング入れる部分じゃない、なぜこんなのが入ってるのか」。お部屋はお申込みで押さえる（company-facts hold_room）＝入金で押さえるは誤り
// 出所: ①は会社の事実 payment_timing／credit_card の文「それより前にお振込頂くことは無い」を本文に写した（事実の文から外した）。
//   ②は申込誘導の形で作った AIX がお客様の「今月お金振り込みます」を拾った（apply-sub-mode.ts で申込確定の形にした）。
// 線（scripts/audit-payment-timing-wording.ts・365日の本番のスタッフの送信 8,441通）: 「それより前に／それ以前に」0通・「入金」と「押さえ／抑え」を結んだ文 0通
//   ＝落としても人の文は変わらない。スタッフの支払いの時期の答えは「ご入居日から5日から１週間ほど前の日にちでお支払いとなります！！」で終わる。

export type WordingFix = { text: string; changes: string[] };

/** 「（ので、）それより前にお支払い頂くことはございません（のでご安心ください）」 */
const BEFORE_ASSERT_RE = /(?:ので|ため)?[、,]?\s*(?:それ(?:より(?:前|以前)に?|以前に)|事前に)[^。！!\n]{0,24}(?:こと|事)(?:は|も)?(?:一切)?(?:ございません|御座いません|ありません|無い|ない)(?:ので|ため)?(?:[、,]?\s*ご安心(?:ください|下さい))?[😊😌✨]*/g;
/** 「（今月の）ご入金でお部屋を押さえさせていただきます」の文（行ごと落とす） */
const PAY_TO_HOLD_LINE_RE = /^[^\n]*(?:入金|お振込|振り込み|お支払い)(?:頂き次第|いただき次第|で|にて|を(?:もって|以て))[^\n]{0,12}(?:お部屋|物件)?(?:を)?(?:押さえ|抑え|確保)[^\n]*$\n?/gm;

export function fixPaymentTimingWording(text: string | null | undefined): WordingFix {
  let s = String(text ?? "");
  const changes: string[] = [];
  s = s.replace(BEFORE_ASSERT_RE, (m) => { changes.push(`言い切りを外す: ${m.trim()}`); return ""; });
  s = s.replace(PAY_TO_HOLD_LINE_RE, (m) => { changes.push(`入金で押さえる文を外す: ${m.trim()}`); return ""; });
  if (changes.length) {
    s = s
      .replace(/^[ \t　]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s*\n/, "")
      .trimEnd();
  }
  return { text: s, changes };
}
