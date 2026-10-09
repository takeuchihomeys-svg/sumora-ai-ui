// app/lib/takeuchi-reply-form-r13.ts — 竹内さんの手打ちの返信の型（何卒・了承だけへの返し・検討中を閉じる・何時でも/いつでも・〇〇さん達・人生の出来事）（純関数）
//
// 2026-10-08 竹内さんの答え（本質の実装と一緒に）。どれも「実際の LINE を見て型を取る」・竹内さんの手打ち（staff_writer='takeuchi'・AIX でない）を基準。
// 数えた物（全期間 5/30〜10/08・1,896通・259会話・返信の固まり 894件。scratchpad r13 の調査）:
//   ①何卒: 全体 30%。本文の最後が 質問 3%・ご査収 0%・事実（となります/ございます）11%・お気軽に 17% ／ 「サポートさせて頂きます」50%・「次第お送り」36%。
//      上の4つに当たらない本文では お客様の発言が 初回 71%・了承だけ 65%・よろしくだけ 62% ／ 質問 20%・申込 22%・検討中 8%
//   ②了承だけ（了解です・わかりました）34件: 「はい😊！！」始まり 44%＋「はい！！」18%・何卒 56%。型「はい😊！！⏎（未来の約束 or 気になる点…お気軽に）⏎何卒よろしくお願い致します！！」
//   ③検討します 23件: 誘わず閉じる 52%（日時を出して誘う 0）。竹内さん 10/08「誘わず閉じる」。多数派の文「はい😊！！⏎ごゆっくりご検討頂けますと幸いです！！⏎〇〇さん気になる点出てきましたらいつでもお気軽にご連絡ください😌！！」
//   ④何時でも 51・いつでも 72: 実送信では当日・急ぎの差が見えない（時間の範囲「19時までですと何時でも」は 2/2 何時でも）。竹内さん 10/08 の決め
//      「その日の当日の話なら何時でも・そうでなければいつでも・申込など緊急性の高い場面は何時でも」に従う（決定論の出口）
//   ⑧〇〇さん達: 竹内さんが使った会話は、手がかり（同棲・2人・夫婦・家族・子ども 等）をお客様が先に言っていた（手がかりが本当に無いのは 0〜1会話）。
//      竹内さん 10/08「同棲などをお客様が自分から言ってきた場合は達・言ってきていない場合はさん」→ 手がかりの無い「さん達」を「さん」に（出口）
//   ⑨人生の出来事 9件: 新しい状態に合わせて確かめ直す・提案した 2・要望に沿って変えた 3・決まり文句だけ 2。竹内さん 10/08「決まり文句でなく新しい状態に合わせた LINE」
//      手本（10-02 別れ）「ご事情お聞かせ頂きありがとうございます😌！！ 〇〇さんお一人のご入居の場合でも…サポートさせて頂きます！！
//      お一人でのご入居となりますと、ご希望の条件が変わることもあるかと思いますので、改めて家賃・広さ・設備のご希望を教えて頂けますと幸いです！！」
// 戻す: TAKEUCHI_FORM_R13=off（全部）・CONSIDERING_CLOSE=off（検討中を閉じる）・ITSUDEMO_R13=off・SANTACHI_R13=off
import type { ReplyScene } from "./reply-scene";

export function takeuchiFormR13Enabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TAKEUCHI_FORM_R13 ?? "").toLowerCase() !== "off";
}
const flag = (name: string, env: Record<string, string | undefined>) => takeuchiFormR13Enabled(env) && (env[name] ?? "").toLowerCase() !== "off";

// ── ③ 検討中は誘わず閉じる ──────────────────────────────────────────
export function consideringCloseEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return flag("CONSIDERING_CLOSE", env);
}
/** 検討中の番の返信の方向（generate-reply の isThinkingMsg の方向に使う） */
export const CONSIDERING_CLOSE_DIRECTION = "検討中を受けて誘わずに閉じる（竹内さん 10/08「誘わず閉じる」・竹内さんの手打ち 23件の多数派）。開口語は「はい😊！！」（単独行）。"
  + "①「ごゆっくりご検討頂けますと幸いです！！」②「〇〇さん気になる点出てきましたらいつでもお気軽にご連絡ください😌！！」の2文で閉じる。"
  + "内覧・申込の誘い（「お気に召されましたら…」の扉の1文も）・日時の打診・物件の追加・催促・希少性の煽りは書かない。50〜110字";
export const CONSIDERING_CLOSE_AVOID = ["申込誘導", "内見誘導", "扉の1文（お気に召されましたら）", "希少性煽り", "物件追加提案", "日程の打診"];

// ── ② 了承だけへの返し ──────────────────────────────────────────────
const ACK_ONLY_RE = /^(?:はい|了解(?:です|しました|致しました|いたしました)?|わかりました|分かりました|承知(?:しました|致しました|いたしました)|かしこまりました|ありがとうございます|よろしくお願い(?:します|致します|いたします)|宜しくお願い(?:します|致します)|大丈夫です|お願いします)+$/;
/** お客様の文が「了解です」「わかりました」等の了承だけか（記号・絵文字・空白は除いて見る） */
export function isAckOnlyAgree(customerText: string | null | undefined): boolean {
  const t = String(customerText ?? "").normalize("NFKC").replace(/[\s!！?？。、.,〜~ー👍🙇🙏😊😌✨❤️♪]|[\p{Extended_Pictographic}\u{FE0F}]/gu, "");
  if (!t || t.length > 40) return false;
  if (!/了解|わかりました|分かりました|承知|かしこまりました/.test(t)) return false;
  return ACK_ONLY_RE.test(t);
}
export const ACK_ONLY_NOTE = "- 🤝 お客様は了承だけ（了解です・わかりました）: 竹内さんの型は3行「はい😊！！」⏎（まだ果たしていない次の動きがあればその1文／無ければ「気になる点出てきましたら何時でもお気軽にご連絡ください！！」）⏎「何卒よろしくお願い致します！！」。新しい約束・説明・提案を足さない";

// ── ① 何卒 ──────────────────────────────────────────────────────
/** 何卒で締めるかの目安（入口の注記）。歯止め（質問・ご査収・事実で終わる本文には付けない）＋お客様の発言の種類 */
export function nanisotsuNote(o: { scene: ReplyScene | null | undefined; isFirstContact: boolean; ackOnly: boolean }, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): string {
  if (!takeuchiFormR13Enabled(env)) return "";
  const lean = o.isFirstContact || o.ackOnly || o.scene === "ack" ? "付ける側（竹内さん 初回 71%・了承だけ 65%・よろしくだけ 62%）"
    : o.scene === "question" || o.scene === "apply" || o.scene === "considering" ? "付けない側（竹内さん 質問 20%・申込 22%・検討中 8%）"
    : "どちらでもよい（竹内さん 36〜42%）";
  // 10/09 竹内さん「全力でサポートの後の何卒は実際の LINE を見て」: 竹内さんの手打ち（全期間・「全力でサポートさせて頂きます」を含む 181通）で
  //   初回（はじめまして）の返信 43/67（64%・5行以上 13/15）が何卒を続ける／それ以外 31/114（27%）＝初回は付ける・それ以外は「全力でサポート」で終える
  const zenryoku = o.isFirstContact
    ? "「全力でサポートさせて頂きます」で締める時も初回は「何卒よろしくお願い致します！！」を続ける（竹内さん 初回 64%）"
    : "「全力でサポートさせて頂きます」で締める時は何卒を続けない（竹内さん 初回以外 27%）";
  return `- 🙏 締めの「何卒よろしくお願い致します！！」: 本文の最後が問いかけ（でしょうか・ますか）・「ご査収ください」・事実（となります・ございます）の時は付けない（竹内さん 3%・0%・11%）。それ以外は ${lean}。${zenryoku}`;
}

// ── ④ 何時でも／いつでも（出口） ─────────────────────────────────────
const TODAY_TALK_RE = /今日|本日|今から|この後|このあと|今夜|今晩|夕方|午後から|午前中/;
const TIME_RANGE_BEFORE_RE = /(?:[0-9０-９]{1,2}\s*(?:時|:\d{2})\s*(?:まで|迄)|〜\s*[0-9０-９]{1,2}\s*(?:時|:\d{2}))[^。！!\n]{0,8}$/;
/**
 * 竹内さん 10/08「その日の当日の話なら『何時でも』・そうでなければ『いつでも』・申込など緊急性の高い場面は『何時でも』」。
 *   時間の範囲（「19時までですと何時でも」）の直後の「何時でも」は変えない（竹内さんの手打ち 2/2）。
 */
export function normalizeItsudemo(draft: string, o: { customerText: string; scene: ReplyScene | null | undefined }, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): { text: string; changed: number } {
  if (!flag("ITSUDEMO_R13", env) || !draft) return { text: draft, changed: 0 };
  const urgent = o.scene === "apply" || TODAY_TALK_RE.test(String(o.customerText ?? ""));
  const want = urgent ? "何時でも" : "いつでも";
  const other = urgent ? "いつでも" : "何時でも";
  let changed = 0;
  const text = draft.replace(new RegExp(other, "g"), (m, idx: number, s: string) => {
    const before = s.slice(Math.max(0, idx - 20), idx);
    if (other === "何時でも" && TIME_RANGE_BEFORE_RE.test(before)) return m;
    changed++;
    return want;
  });
  return { text, changed };
}

// ── ⑧ 〇〇さん達（出口） ─────────────────────────────────────────────
/** お客様が同棲・2人・家族で住む事を言った手がかり（「大丈夫」の「夫」は当てない） */
export const COUPLE_EVIDENCE_RE = /同棲|2人|二人|ふたり|カップル|彼氏|彼女|旦那|主人|(?<!丈)夫(?!婦)|夫婦|妻|嫁|家族|子供|子ども|お子|赤ちゃん|[0-9０-９]+歳児|ルームシェア|同居|パートナー|婚約|入籍|結婚/;
/** 手がかりの無い「〇〇さん達」を「〇〇さん」に（竹内さん 10/08）。customerTexts はこの会話のお客様の発言（条件の文も入れてよい） */
export function fixSanTachi(draft: string, customerTexts: ReadonlyArray<string>, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): { text: string; changed: number } {
  if (!flag("SANTACHI_R13", env) || !draft || !/さん(?:達|たち)/.test(draft)) return { text: draft, changed: 0 };
  if (customerTexts.some((t) => COUPLE_EVIDENCE_RE.test(String(t ?? "").normalize("NFKC")))) return { text: draft, changed: 0 };
  let changed = 0;
  const text = draft.replace(/さん(?:達|たち)/g, () => { changed++; return "さん"; });
  return { text, changed };
}

// ── ⑨ 人生の出来事 ─────────────────────────────────────────────────
/** 人生の出来事を聞いた番の返し方（ブレインと返信に渡す注記。決まり文句で受けて終わらない） */
/** 10/09 竹内さん「出産など家族が増えた時は、こちらから広さ・間取りを聞き直す」 */
export const FAMILY_GROWS_RE = /出産|妊娠|赤ちゃん|子供が(?:産|生)まれ|子どもが(?:産|生)まれ|家族が増え|お子さん(?:が|も)(?:産|生)まれ/;
export const FAMILY_GROWS_NOTE = "家族が増える（出産・妊娠）→ こちらから広さ・間取りを聞き直す（例「ご家族が増えられるとの事で、改めてご希望の広さ・間取りを教えて頂けますと幸いです！！」の形・竹内さん 10/09）";
export const LIFE_EVENT_NOTE = "ご事情（人生の出来事）を話してくれた → 決まり文句で受けて終わらない。出来事を新しい状態（住む人数・広さ・時期・審査）の変化として読み、"
  + "それに合わせた確かめ直し・探し方を主にする（竹内さんの手本 10-02 別れ「ご事情お聞かせ頂きありがとうございます😌！！ お一人でのご入居となりますと、ご希望の条件が変わることもあるかと思いますので、改めて家賃・広さ・設備のご希望を教えて頂けますと幸いです！！」）。"
  + "条件が変わるなら登録の条件そのものを直す。新しい状態の言い方は作らず、お客様の言葉と条件の語だけで書く";

/**
 * 10/09 竹内さん「検討しますの申込の一言: 確認の結果や見積書を送った後は添える・初回で詳細を送った直後は内覧の案内だけ」
 *   それ以外（どちらでもない）は誘わず閉じる（CONSIDERING_CLOSE_DIRECTION）。竹内さんの手打ちの扉の1文そのまま。
 */
export function consideringDirectionFor(o: { afterEstimateOrCheck: boolean; afterPropertyDetails: boolean }): string {
  if (o.afterEstimateOrCheck) return "検討中を受ける（確認の結果・御見積書を送った後）。開口語は「はい😊！！」（単独行）。①「ごゆっくりご検討頂けますと幸いです！！」②申込の一言「お気に召されましたらお申込みしお部屋抑えさせて頂きます！！」③「気になる点出てきましたらいつでもお気軽にご連絡ください😌！！」。催促・日時の打診・希少性の煽り・物件の追加は書かない。60〜130字";
  if (o.afterPropertyDetails) return "検討中を受ける（お部屋の詳細を送った直後）。開口語は「はい😊！！」（単独行）。①「ごゆっくりご検討頂けますと幸いです！！」②内覧の案内だけ「お部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！」。申込の一言・日時の打診・催促は書かない。60〜120字";
  return CONSIDERING_CLOSE_DIRECTION;
}
