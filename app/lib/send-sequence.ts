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

/** ブレインの決まりに足す1行（on の時だけ・読み方と竹内さんの一手の1組） */
export function sendSequenceRule(env: Env = envOf()): string {
  if (!sendSequenceOn(env)) return "";
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
