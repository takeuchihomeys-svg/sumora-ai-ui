// app/lib/__tests__/pre-star-memo.test.ts
// 🌟の前の作業メモを落とす出口（app/lib/pre-star-memo.ts）。実物（お客様の名前は〇〇に伏せた）で確かめる
// 実行: npx tsx app/lib/__tests__/pre-star-memo.test.ts
import { stripPreStarMemo, preStarMemoStripOn } from "../pre-star-memo";
import { stripMetaNarration } from "../meta-narration";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }
/** aix/action の finalize と同じ3段 */
const pipeline = (s: string) => stripPreStarMemo(stripMetaNarration(stripPreStarMemo(s).text).text).text;

const CARD = "🌟CASA PINO SOLO（カーサ・ピノ・ソロ） 203号室\n\n2026年築の新築・家賃管理費込136,000円、〇〇さんにかなりオススメ出来るお部屋となります！！\n\n（オススメポイント）\n・家賃130,000円・管理費6,000円（合計136,000円）\n・間取り：1LDK（LDK12.2帖、洋室7.5帖）";

// ── 実物 ee4eef81（6/30 の物件オススメの下書き）: 今の stripMetaNarration では1文字も落ちなかった
const EE4 = "礼金が1ヶ月あるため、「敷金礼金なし」はオススメポイントに記載しません。また、間取りは1LDKで1Rではないため通常通り記載します。築年は2026年4月築（新築）で築浅記載OK。駅は天王寺（希望エリアに含まれる）徒歩6分で希望7分以内に合致。\n\n---\n\n" + CARD;
t("ee4eef81: 今の stripMetaNarration だけでは残る（穴の確かめ）", stripMetaNarration(EE4).text.startsWith("礼金が1ヶ月"));
{
  const r = stripPreStarMemo(EE4);
  t("ee4eef81: 🌟から始まる", r.text === CARD, r.text.slice(0, 40));
  t("ee4eef81: 落とした物にメモが入る", !!r.removed && r.removed.includes("記載しません"));
}

// ── 実物 43ed9a27（6/25 見積書）: 箇条書きの読み取り＋「**確認事項：**」。stripMetaNarration だけだと「**確認事項：**⏎---」が残った
const F43 = "物件資料を確認します。\n\n- 物件名：フレンシアノイエ難波南 308号室\n- 築年：2009年02月築（築16年）→ 築11年以上のため築年はオススメポイント・文章に書かない\n- 敷金：0円、礼金：0円 → 敷金礼金なし記載OK\n\n**確認事項：**\n- 築浅希望ですが築16年のため、築年に関する言及はオススメポイント・文章ともにしません。\n\n---\n\n🌟フレンシアノイエ難波南 308号室\n\n敷金礼金なし・芦原橋徒歩7分の1LDK、〇〇さんにかなりオススメ出来るお部屋となります！！";
t("43ed9a27: 3段で🌟から始まる", pipeline(F43).startsWith("🌟フレンシアノイエ難波南 308号室"), pipeline(F43).slice(0, 40));

// ── 実物 9ca86d92（6/26）: お客様の名前の絵文字（🌺）が入るので、作業メモの行を先に落としてから当てる
const F9C = "物件資料を確認しました。\n\n**重要な確認事項：**\n\n- **礼金：1ヶ月** → オススメポイントに「敷金礼金なし」は記載不可\n- **交通：芦原橋徒歩8分** → いずれも〇〇🌺さんの希望徒歩7分以内を超えている\n\n希望条件と合致しない点が複数あるため、正直に伝えながらオススメ文を作成します。\n\n---\n\n🌟アイボリーポワント難波WEST 605号室\n\n家賃管理費込81,000円の浪速区1LDK、〇〇🌺さんにかなりオススメ出来るお部屋となります！！";
t("9ca86d92: 3段で🌟から始まる", pipeline(F9C).startsWith("🌟アイボリーポワント難波WEST"), pipeline(F9C).slice(0, 40));

// ── 落とさない（スタッフの送った文・正しい下書きの実物の形）
const EST = "【サウスパーク 3号室】\n\n初期費用さらに\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！";
t("見積書の札＋初期費用さらに → 触らない", stripPreStarMemo(EST).removed === null);
const IMG = "（室内イメージ）\nhttps://suumo.jp/chintai/bc_000000000000/\n\n🌟〇〇 302号室\n\n（オススメポイント）\n・家賃53,000円";
t("スタッフが足した（室内イメージ）URL → 触らない", stripPreStarMemo(IMG).removed === null);
const GREET = "〇〇さんお世話になっております！！\nご希望の条件で確認しましたところ、こちらのお部屋がございました！！\n\n🌟〇〇 302号室";
t("挨拶＋確認しました！！ → 触らない", stripPreStarMemo(GREET).removed === null);
const STAFF_LR = "ご内覧可能日申し訳ございません。\n確認しましたところ、16日が前時間にお約束が御座いまして\nお時間遅れてしまう可能性が御座います。\n\n〇〇さんよろしければ\n🌟〇〇 302号室";
t("スタッフの実送信（確認しました＋御座います）→ 触らない", stripPreStarMemo(STAFF_LR).removed === null);
t("🌟から始まる文 → 触らない", stripPreStarMemo(CARD).removed === null && stripPreStarMemo(CARD).text === CARD);
t("🌟が無い文 → 触らない", stripPreStarMemo("礼金があるため記載しません。").removed === null);
t("メモだけで🌟の後ろが空 → 触らない", stripPreStarMemo("記載しません。\n🌟").removed === null || stripPreStarMemo("記載しません。\n🌟").text.trim() === "🌟");

// ── 切替（既定 off）
t("既定 off", preStarMemoStripOn({}) === false);
t("=on で入る", preStarMemoStripOn({ AIX_PRE_STAR_MEMO_STRIP: "on" }) === true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
