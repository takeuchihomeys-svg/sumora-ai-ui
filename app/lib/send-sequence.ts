// app/lib/send-sequence.ts — この番で送る物の並び（返信 1〜3通と AIX の位置）をブレインが決める（2026-11-07 竹内さん「下書きを通ごとに分けて出す」・作業員7）
//
// 竹内さん本人の90日の並び（お客様の番の後60分・竹内さんの手打ちがある番 816）: R 67%・AR 9.6%・RR 7.7%・A 5.4%・RAR 3.4%・RA 2.3%・ARR 1.5%。
//   返信2通以上で同じ番に AIX もある番（作業員9）: A→R→R 41・R→A→R 38・R→A→R→R 6・R→R→A 1＝返信を全部送ってから AIX はほぼ無い。
//   通の役目（作業員9）: 受け止めは 1通目 29%／2通目 5%・誘いは 1通目 12%／2通目 20%。2通目の出だしに決まった語は無い（中身からそのまま始まる）。
// 並びを決めるのはブレイン（決まった計算は形の確かめだけ）。meta.send_sequence が1つの正。画面は下書きを通ごとの欄に分けて並べ、間の AIX をアナウンスで出す。
// 既定 off（TWO_MESSAGE_SEQUENCE=on・画面は NEXT_PUBLIC_TWO_MESSAGE_SEQUENCE=on でも YUMA・テスト専用の会話だけ）。
type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export function sendSequenceOn(env: Env = envOf()): boolean {
  return (env.TWO_MESSAGE_SEQUENCE ?? "").trim().toLowerCase() === "on";
}
/** 画面: 既定 off・on でも YUMA・テスト専用の会話だけ（全員に広げるのは竹内さんの確認の後） */
export function sendSequenceUiOn(v: string | null | undefined, isTestConv: boolean): boolean {
  return (v ?? "").trim().toLowerCase() === "on" && isTestConv;
}

export type SendStep = { slot: "reply" | "aix"; aix?: string | null; role: string };

/** 2026-11-11 作業員7（統括役の決め）: 分け方の言い方 v2（TWO_MESSAGE_SEQUENCE_SPLIT_V2=on・既定 off）。
 *  旧の「迷ったら1通」で w7-seq-dig3 の本質の並びは竹内さんの2通以上の番 0/6（全部 R・RA・A・AR）。
 *  竹内さん本人の200日（手打ちの番・従業員の混ざらない番 約970）: R 716（74%）・RR 87・AR 79・RAR 26・RRR 18・RA 17・ARR 12・RRRR 8。
 *  RR の2通目（無作為14番）: 次の一歩（希望の地域を聞く・内覧の誘い・申込で抑える提案・全力サポートの締め・安心の一言）か、別の話題の答え（入居日と募集状況・ペット可と見積書）。
 *  RAR は 受け止め → AIX【条件ヒアリング】等 → 「ご入力頂きますと…ピックアップさせて頂きます」。ARR は AIX【見積書】→ 説明 → 誘い。 */
export function sendSequenceSplitV2On(env: Env = envOf()): boolean {
  return (env.TWO_MESSAGE_SEQUENCE_SPLIT_V2 ?? "").trim().toLowerCase() === "on";
}
function sendSequenceRuleV2(): string {
  return "- ★出力の JSON に send_sequence を足す: この番で送る物の並び（返信は 1〜3通・AIX はその位置に1つ）。形は [{\"slot\":\"reply\",\"role\":\"受け止め＋答え\"},{\"slot\":\"aix\",\"aix\":\"<aix のキー>\"},{\"slot\":\"reply\",\"role\":\"次の一歩\"}]。"
    + "竹内さんの200日: 返信1通 74%・返信2通 9%・AIX→返信 8%・返信→AIX→返信 3%・返信3通 2%・返信→AIX 2%・AIX→返信2通 1%。"
    + "返信を分ける番（1通に詰めない）: ①答える事が2つあり話題が別（例: 入居日の答えと募集状況・ペット可の答えと見積書の案内）＝1通に1つ ②受け止め＋答え・約束の後に次の一歩（希望の地域・駅を聞く／内覧の誘い／申込でお部屋を抑える提案／全力でサポートする締め）を足す番＝次の一歩は2通目 ③AIX（見積書・物件・条件のフォーム）の後に、その説明か誘いを送る番（説明と誘いが両方なら AIX→返信→返信）。"
    + "1通で済ませる番（基本・まずここに当たるかを見る）: お礼・了承への返し・答えが1つで次の一歩が要らない番。"
    + "文を書く AIX（内覧調整・待ち合わせ場所・物件確認した・申込・電話・保証会社）を送る番は、受け止め・約束・答えをその AIX の文の中で済ませる＝AIX 1通だけ（前後に返信を足さない・竹内さんの番の6〜7割）。"
    + "AIX を選ばず返信にした番に AIX の通を足さない。上の3つに当てはまらなければ分けない。AIX は先（AIX → 返信）か返信の間（返信 → AIX → 返信）に置き、返信を全部送ってから AIX にはしない。aix の欄が空なら AIX の通は入れない。"
    + "竹内さんの実物: (RR) 1通目「かしこまりました😊！！\\n家賃10万前後・1LDK〜・築年浅のご条件でオススメできるお部屋ピックアップさせて頂きます！！」→ 2通目「🌟ご希望の地域や駅御座いますでしょうか😌！！」"
    + "／(RAR) 1通目「はじめまして😊！！この度ご連絡頂きありがとうございます！！…」→ AIX【条件ヒアリング】→ 3通目「よろしければこちらにご希望のご条件お送り頂きますと、ご条件に合ったお部屋ピックアップさせて頂きます！！」"
    + "／(ARR) AIX【見積書を送る】→ 2通目「こちら1部屋のみの募集となりますので、お気に召されましたらお申込し一度お部屋抑えさせて頂き、ご都合よろしいお日にちにお部屋ご案内させて頂きます！！」。\n";
}

/** ブレインの決まりに足す1行（on の時だけ・読み方と竹内さんの一手の1組） */
export function sendSequenceRule(env: Env = envOf()): string {
  if (!sendSequenceOn(env)) return "";
  if (sendSequenceSplitV2On(env)) return sendSequenceRuleV2();
  return "- ★出力の JSON に send_sequence を足す: この番で送る物の並び（返信は 1〜3通・AIX はその位置に1つ）。形は [{\"slot\":\"reply\",\"role\":\"受け止め＋答え\"},{\"slot\":\"aix\",\"aix\":\"<aix のキー>\"},{\"slot\":\"reply\",\"role\":\"答えの続き・誘い\"}]。"
    + "読み方: 竹内さんは番の 67% を返信1通で済ませる＝迷ったら1通（[{\"slot\":\"reply\",\"role\":\"受け止め＋答え\"}]）。返信を分けるのは、答える事が2つ以上ある・答えの後に誘いか締めを足す番だけで、1通目＝受け止め＋答え、2通目＝答えの続き・誘い・締め。"
    + "AIX がある番は、AIX を先（AIX → 返信）か、返信の間（返信 → AIX → 返信）に置き、返信を全部送ってから AIX にはしない（竹内さんの90日: A→R→R 41・R→A→R 38・R→R→A 1）。aix の欄が空なら AIX の通は入れない。"
    + "竹内さんの一手（10/25・入居の見送りの相談）: 1通目「かしこまりました！！\\nお伝え頂きありがとうございます！！\\n明日月曜日は週明けで…新着物件が最もでる曜日となります！！…」→ 2通目「はい！！\\n明日ご連絡させて頂きます！！\\n何卒よろしくお願い致します！！」。\n";
}

/** 出力の JSON の欄（on の時だけ brain-core の出力の指定に足す）。
 *  2026-11-10 作業員7: 決まりの1行（sendSequenceRule）は turn_contract の決め方の中にしか無く、出力の指定に欄が無かった＝
 *  w7-seq-dig2（TWO_MESSAGE_SEQUENCE=on・8問）で DeepSeek が send_sequence を1回も出さなかった（答案の生の出力にも 0/8） */
export const SEND_SEQUENCE_FIELD = `"send_sequence": [{"slot": "reply か aix", "aix": "slot=aix の時だけ aix の欄と同じキー", "role": "この通の役目（受け止め＋答え・答えの続き・誘い・締め 等・15字以内）"}]（この番で送る物の並び。返信1通だけの番は [{"slot":"reply","role":"受け止め＋答え"}]）`;

/** ブレインの send_sequence を確かめて整える（形が崩れていれば null・1通の返信だけなら null＝今の形のまま） */
export function sanitizeSendSequence(raw: unknown, finalAix: string | null | undefined): SendStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5) return null;
  const out: SendStep[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const slot = (r as { slot?: unknown }).slot;
    const role = String((r as { role?: unknown }).role ?? "").trim().slice(0, 30);
    if (slot === "reply") out.push({ slot: "reply", role: role || "返信" });
    else if (slot === "aix") {
      if (!finalAix) continue; // ブレインの aix が空なら AIX の通は入れない
      if (out.some((s) => s.slot === "aix")) continue; // AIX は1つ
      out.push({ slot: "aix", aix: finalAix, role: role || "AIX" });
    } else return null;
  }
  const replies = out.filter((s) => s.slot === "reply").length;
  if (replies > 3) return null;
  if (finalAix && !out.some((s) => s.slot === "aix")) return null; // ブレインが AIX を選んだのに並びに無い＝食い違い
  if (out.length <= 1) return null; // 返信1通だけ・AIX だけ＝今の形のまま
  return out;
}

export const replyCountOf = (seq: ReadonlyArray<SendStep> | null | undefined): number => (seq ?? []).filter((s) => s.slot === "reply").length;

const AIX_JA: Record<string, string> = {
  estimate_sheet: "見積書を送る", property_check_result: "物件確認した", property_send: "物件送付", property_recommendation: "物件オススメ",
  viewing_invite: "内覧調整", meeting_place: "待ち合わせ場所", application_push: "申込", phone_call: "電話", guarantor_info: "保証会社",
};
/** 画面のアナウンス（例「1通目: 受け止め＋答えの返信 → 2通目: AIX【内覧調整】 → 3通目: 答えの続き・誘いの返信」）。current は今送る通（0 始まり・太字にする所） */
export function sequenceAnnounce(seq: ReadonlyArray<SendStep> | null | undefined): string[] {
  return (seq ?? []).map((s, i) => `${i + 1}通目: ${s.slot === "aix" ? `AIX【${AIX_JA[String(s.aix ?? "").split("/")[0]] ?? s.aix}】` : `${s.role}の返信`}`);
}
/** 送った数から今送る通を決める（送った通＝この番の後にこちらが送った通の数・画像だけの通は数えない） */
export function currentStepOf(seq: ReadonlyArray<SendStep> | null | undefined, sentCount: number): number | null {
  const n = (seq ?? []).length;
  if (!n || sentCount >= n) return null;
  return Math.max(0, sentCount);
}

/** 下書きを通ごとに分ける（書き手が「---」だけの行で分ける・作業員9の reply-split.ts splitReplyDraft が入ったらそちらを使う） */
export function splitDraftParts(text: string | null | undefined): string[] {
  return String(text ?? "").split(/\r?\n-{3}\r?\n/).map((t) => t.trim()).filter(Boolean);
}
