// app/lib/pre-star-memo.ts
// AIX の物件オススメ・見積書の文で、🌟の物件カードより前に書かれた AI の作業メモを落とす（純関数・DB 依存なし）
//
// 2026-11-14 作業員E（統括役の指示・監査で見つかった下書き ee4eef81・6/30 の物件オススメ）:
//   「礼金が1ヶ月あるため、「敷金礼金なし」はオススメポイントに記載しません。また、間取りは1LDKで1Rではないため通常通り記載します。
//     築年は2026年4月築（新築）で築浅記載OK。駅は天王寺（希望エリアに含まれる）徒歩6分で希望7分以内に合致。\n\n---\n\n🌟…」
//   ＝書き手（AIX 物件オススメ）が資料の読み取りを🌟の前に書いた。スタッフが手で消して送っていた（送った文には無い）。
//
// 【出所】書き手の出力そのもの（AIX property_recommendation / estimate_sheet）。書き直し・最終チェック・手本ではない
//   （手本に入った9件はどれも ai_draft の側だけで、sent_reply には無い）。
// 【入口】aix/action の静的 system に「出力の最初の文字は必ず🌟」「〜のため〜は使わず作成します 等の確認メモは絶対に含めない」が
//   既にあり、同じ型は 2026-07-03 を最後に出ていない（直近30日の下書き 1,171件・見張りの下書き 535件で 0）。
// 【出口の穴】今の stripMetaNarration（区切り線の前置き・作業メモの行）では、この型17件のうち 15件で🌟の前にメモが残る
//   （「記載しません」「記載OK」「合致」は作業の動詞の語尾でも指示の語でもないため・ee4eef81 は1文字も落ちない）。
//
// 【線（誤削除0の確かめ・scripts/audit-pre-star-memo.ts）】ai_reply_examples の全期間:
//   🌟の行より前に、①！？・お客様向けの絵文字が無い ②「ございま・御座いま・申し訳・させて頂・お世話」が無い
//   ③作業の印（記載・出力・確認します/事項・判断・合致・照合・→・OK・作成・整理・特定・処理・NG・✅・**）がある
//   → スタッフの送った文 0通／AI の下書き 17通（6/16〜7/03・どれも作業メモ）。
//   ※ ①だけだと、見積書の「【物件名】\n\n初期費用さらに\n🌟…」や、スタッフが足した「（室内イメージ）URL」に当たるので③を必須にした。
//   ※ 現状の1文（situation_kind）の型は🌟の前に1文を書くのが正しいので、呼ぶ側で外す。
//
// 切替: AIX_PRE_STAR_MEMO_STRIP=on の時だけ（既定 off・入口が効いていて直近は 0 のため。悪化0を確かめてから on にする）

/** お客様向けの言葉の特徴（これが🌟の前にあれば触らない） */
const CUSTOMER_MARK_RE = /[！!？?😊😌✨🙇🙏😢😭💦🎉👍😆🥺]|ございま|御座いま|申し訳|させて頂|させていただ|お世話/;
/** 作業メモの印（資料の読み取り・何を書くかの検討） */
const WORK_MARK_RE = /記載|出力|確認(?:します|事項|して|しました)|判断|合致|照合|→|OK|作成|整理|特定|処理|NG|✅|\*\*/;

export function preStarMemoStripOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_PRE_STAR_MEMO_STRIP ?? "").trim().toLowerCase() === "on";
}

/**
 * 最初の🌟の行より前が作業メモなら、🌟の行から後ろだけを返す。
 * 当たらない時は同じ文字列を返す（removed は null）。
 */
export function stripPreStarMemo(text: string): { text: string; removed: string | null } {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const star = lines.findIndex((l) => l.trim().startsWith("🌟"));
  if (star <= 0) return { text: src, removed: null };
  const pre = lines.slice(0, star).join("\n");
  if (!pre.trim()) return { text: src, removed: null };
  if (CUSTOMER_MARK_RE.test(pre) || !WORK_MARK_RE.test(pre)) return { text: src, removed: null };
  const rest = lines.slice(star).join("\n");
  if (!rest.trim()) return { text: src, removed: null };
  return { text: rest, removed: pre.trim() };
}
