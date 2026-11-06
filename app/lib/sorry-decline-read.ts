// app/lib/sorry-decline-read.ts — 謝り・断り・締めの後のお礼の番を「動く番」と読まない読み方と、竹内さんの一手の1組（純関数・LLM なし）
//
// 2026-11-06 作業員1（統括役・作業員4の解き直しの本当の読み違いの型3）: q356「ここも良いんですが、前の方が好きです😥 せっかくなのに申し訳ございません」を
//   ブレインが内覧の誘いと読み（竹内さんは「全然大丈夫です！！前にお気に召して頂いたカシミマンションを優先してご案内させて頂きます」）、
//   q354 締めの後の「ご丁寧に有難うございます」を「なし」と読み（竹内さんは「引き続き新着でオススメできるお部屋募集に出次第お送り」）、
//   q357「焦って決めたくはないため申し込みはしなくても大丈夫です！お手数おかけします」を動く番と読んだ。
//   竹内さん本人の実送信（90日）:
//     謝り 59番: 受け止めの返信 29・継続の約束 17（＝78%）・内覧に誘う 5・AIX 5・返さない 3／断り 4番: 全部返信（受け止め 3・継続の約束 1）
//     こちらの「ごゆっくりご検討・いつでもお気軽に」の締めの後のお礼 7番: 返信 5（継続の約束 3・受け止め 2）・内覧と AIX 0
//   ＝今日の (a)・359 と同じ形で、読み方（動く依頼ではない）と一手（受け止めの返信＋今の予定・前に気に入った物件を優先／引き続き探す約束）を1組で渡す。
//   同じ発言で新しい依頼（他お願いします・探して・送って・内覧・申込・質問）をしている番には当てない。既定 off（入れる BRAIN_SORRY_DECLINE_READ=on）
//   監査（scripts/audit-sorry-decline-read.ts・90日・候補 1,375通・竹内さんの番を目で読んだ）: 断り 7番＝返信 6（受け止め 2・継続の約束 4）・すぐ探して物件の AIX 1・内覧 0／
//     締めの後のお礼 6番＝返信 5・返さない 1・内覧と AIX 0。謝りの語だけの網（最初の版）は依頼つきの謝りまで当たった（AIX 16・内覧 4）ので、断りの語を必ず要る形にした

import { normalizeCustomerText } from "./reply-context";

export function sorryDeclineReadOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_SORRY_DECLINE_READ ?? "").trim().toLowerCase() === "on";
}

export const SORRY_RE = /申し訳|すみません|すいません|ごめんなさい|せっかく|お手数おかけ/;
// 2026-11-06 監査（90日・竹内さんの番 59）: 謝りの語だけでは「すみませんよろしくお願いします」（この後に物件の AIX）・「こちらもお願いします 何度もすいません」
//   （確認の依頼）・遅れの連絡・日時の連絡・不安の相談まで当たり、AIX 16・内覧 4 が混ざった → 断りの語を必ず要る形にした（謝りだけでは当てない）
export const DECLINE_RE = /見送|やめて?おき|やめておきます|今回は(?:見送|やめ|無し|なし|大丈夫)|しなくても大丈夫|しなくて大丈夫|結構です|遠慮|前の方が|前の(?:物件|お部屋)が|もう大丈夫|(?:ので|は)大丈夫です|範囲外/;
/** 断りに見えても別の番（遅れ・日時・問い・相談・電話） */
export const NOT_DECLINE_TURN_RE = /でしょうか|ますか|遅れ|遅く|不安|電話|[0-9０-９]{1,2}\s*[:：時]|[0-9０-９]{1,2}\/[0-9０-９]{1,2}|[0-9０-９]{1,2}\s*日/;
export const THANKS_RE = /ありがとう|有難う|有り難う/;
/** 同じ発言の新しい依頼・質問（あれば当てない） */
export const NEW_REQUEST_RE = /[?？]|でしょうか|ますか|他(?:の物件|の部屋|のお部屋)?(?:を)?お願い|探して|送って|教えて|ください|下さい|可能でしょうか|できますか|出来ますか|空いて|内[覧見]|見学|申込(?:み)?(?:たい|します|お願い)|申し込み(?:たい|ます)|見積|いくら|契約|決めたい|決めます|決めようと|早めに|急ぎ|至急|\[画像\]|https?:\/\//;
/** こちらの締め（ご検討・ごゆっくり・いつでもお気軽に）で、確認・送る約束をしていない文 */
export const STAFF_CLOSING_RE = /ご検討|ごゆっくり|いつでもお気軽に|何時でもお気軽に/;
export const STAFF_OPEN_PROMISE_RE = /確認させて|確認出来次第|確認でき次第|お送りさせて頂きます|お送りさせていただきます|ピックアップ/;

export type SorryDeclineKind = "sorry_decline" | "thanks_after_closing" | null;

/** この番の型（当たらなければ null） */
export function readSorryDecline(i: { customerText: string | null | undefined; prevStaffText?: string | null }): SorryDeclineKind {
  const c = normalizeCustomerText(i.customerText).trim();
  if (!c || c.length > 120 || NEW_REQUEST_RE.test(c)) return null;
  if (DECLINE_RE.test(c) && !NOT_DECLINE_TURN_RE.test(c)) return "sorry_decline";
  const prev = String(i.prevStaffText ?? "");
  if (THANKS_RE.test(c) && c.length <= 60 && STAFF_CLOSING_RE.test(prev) && !STAFF_OPEN_PROMISE_RE.test(prev)) return "thanks_after_closing";
  return null;
}

export type SorryDeclineExample = { conv: string; customer: string; staff: string };
export const SORRY_DECLINE_EXAMPLES: ReadonlyArray<SorryDeclineExample> = [
  { conv: "a260169b-7491-41fe-9c3a-fbd860326fca", customer: "ここも良いんですが、前の方が好きです😥 せっかくなのに申し訳ございません",
    staff: "全然大丈夫です！！前にお気に召して頂いたカシミマンションを優先してご案内させて頂きます！！お日にちが決まりましたらいつでもお気軽にご連絡ください😊！！" },
  { conv: "a3cc571e", customer: "6畳はせますぎるので大丈夫ですすいません",
    staff: "かしこまりました！！引き続きご条件に合ったお部屋新着で出次第お送りさせて頂きます！！" },
  { conv: "db3722a5", customer: "申し訳ありません。転勤の件無くなりましたので今回は見送りでお願いします。",
    staff: "かしこまりました！！またお部屋探しをされる際はいつでもお気軽にご連絡ください😊！！その際は〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！" },
];

/** 手本の選び（同じ会話・試験の元の会話は外す＝答えが漏れない） */
export function pickSorryDeclineExamples(conversationId: string | null | undefined, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): SorryDeclineExample[] {
  const ex = [String(conversationId ?? ""), ...String(env.BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV ?? "").split(",")].map((x) => x.trim()).filter(Boolean);
  return SORRY_DECLINE_EXAMPLES.filter((e) => !ex.some((x) => e.conv === x || x.startsWith(e.conv) || e.conv.startsWith(x)));
}

/** ブレインの材料の文（当たらなければ空） */
export function sorryDeclineBrainText(kind: SorryDeclineKind, examples: ReadonlyArray<SorryDeclineExample>): string {
  if (!kind) return "";
  const lines = examples.map((e, i) => `${i + 1}. お客様「${e.customer}」→ 竹内さん: 受け止めの返信「${e.staff}」`);
  if (kind === "thanks_after_closing") {
    return `\n\n【読み方と一手の手本（こちらの「ごゆっくりご検討」の締めの後のお礼）】
- 読み方: 締めの後のお礼。新しい依頼・質問は無い。
- 一手: 返さないにしない。竹内さんは短い受け止めと、引き続き新着でオススメできるお部屋をお送りする約束を返す（返信・内覧の誘い・新しい AIX にしない）。
竹内さんの実送信（90日・この網に当たる 6番・目で読んだ）: 返信 5（継続の約束 2・受け止め 3）・返さない 1・内覧と AIX 0。`;
  }
  return `\n\n【読み方と一手の手本（お客様の謝り・断り）】
- 読み方: お客様は謝っている・断っている（「前の方が好き」「今回は見送り」「申込はしなくても大丈夫」）＝動く依頼ではない。内覧・申込・見積の依頼と読まない。
- 一手: 竹内さんは受け止めの返信（「全然大丈夫です！！」「かしこまりました！！」）に、今の予定・前に気に入った物件を優先する一言、または引き続き探してお送りする約束を添える（すぐ送れる物件があれば物件の AIX で送る事もある）。内覧の誘い・申込の誘いにしない。
竹内さんの実送信（90日・この網に当たる断り 7番・目で読んだ）: 受け止めの返信 2・継続の約束 4・すぐ探して物件の AIX 1・内覧に誘う 0。${lines.length ? `\n${lines.join("\n")}` : ""}`;
}
