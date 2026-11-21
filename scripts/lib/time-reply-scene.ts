// scripts/lib/time-reply-scene.ts — 竹内さん本人の番で、お客様の時の言葉への返し方を場面ごとに数える（純関数・決まった語の網・LLM なし・DB なし）
//
// 2026-11-21 作業員L（台帳 #500「時系列の場面の決まり」の下ごしらえ・統括役の頼み）。
//   場面（5つ＋その他）: 短いお礼／検討中／条件／物件を送ってきた（お客様）／物件を送る（こちらがこの番で物件の AIX）／その他
//   返し方（3つ）: 日付で言い直す（お客様の時の言葉を日付・月・曜日・同じ言葉で受ける）／期日を約束する（こちらの期限の言葉＋させて頂きます）／触れない
//   時の言葉は situation-timeline.resolveTimeWords（帳面と同じ読み）。お客様の束に時の言葉が無い番は数えない。
import { resolveTimeWords } from "../../app/lib/situation-timeline";

export type TimeScene = "short_thanks" | "considering" | "conditions" | "property_brought" | "property_send" | "other";
export const TIME_SCENE_JA: Record<TimeScene, string> = {
  short_thanks: "短いお礼", considering: "検討中", conditions: "条件", property_brought: "物件を送ってきた", property_send: "物件を送る", other: "その他",
};
export type TimeHandling = "restate_date" | "promise_due" | "no_touch";
export const TIME_HANDLING_JA: Record<TimeHandling, string> = { restate_date: "日付で言い直す", promise_due: "期日を約束する", no_touch: "触れない" };

const N = (s: string) => String(s ?? "").normalize("NFKC");
/** 場面（こちらがこの番で物件の AIX を送ったかは呼ぶ側が渡す） */
export function timeSceneOf(customerBurst: string, o: { ourPropertyAix: boolean }): TimeScene {
  const t = N(customerBurst).trim();
  if (o.ourPropertyAix) return "property_send";
  if (/\[画像\]|【物件の(?:画面|資料)|https?:\/\/(?:suumo|www\.homes|athome|chintai)/.test(t)) return "property_brought";
  if (/【?ご?(?:入居の時期|希望の家賃|希望の広さ)|万(?:円)?(?:以内|まで|くらい)|(?:駅|徒歩)\d|間取り|エリア|1LDK|1K|2LDK|ペット/.test(t)) return "conditions";
  if (/検討|考え(?:ます|てい|てみ|させ|中)|迷って|相談して|家族と/.test(t)) return "considering";
  if (t.length <= 30 && /ありがとう|有難う|了解|承知|わかりました|分かりました|かしこまり|よろしく/.test(t)) return "short_thanks";
  return "other";
}

/** 竹内さんの返事の時の言葉への返し方 */
export function timeHandlingOf(reply: string, customerWords: ReadonlyArray<string>): TimeHandling {
  const t = N(reply);
  if (/(?:本日中|今日中|明日(?:一番|中)?|明後日|週明け|今週中|来週|\d{1,2}[\/月]\d{1,2}日?(?:まで)?|\d{1,2}日(?:まで)?)[^。！\n]{0,30}(?:させて頂き|致し|いたし)ます/.test(t)) return "promise_due";
  if (customerWords.some((w) => w && t.includes(N(w)))) return "restate_date";
  if (/\d{1,2}[\/月]\d{1,2}日?|\d{1,2}月(?:上旬|中旬|下旬|中|末|頃)|[月火水木金土日]曜/.test(t)) return "restate_date";
  return "no_touch";
}

export type TimeTurn = { scene: TimeScene; handling: TimeHandling; words: string[] };
/** 1番（お客様の束・その時刻・竹内さんの返事・この番の物件の AIX）→ 時の言葉がある番だけ */
export function timeTurnOf(o: { customerBurst: string; atMs: number; reply: string; ourPropertyAix: boolean }): TimeTurn | null {
  const words = resolveTimeWords(o.customerBurst, o.atMs).map((w) => w.word);
  if (!words.length) return null;
  return { scene: timeSceneOf(o.customerBurst, { ourPropertyAix: o.ourPropertyAix }), handling: timeHandlingOf(o.reply, words), words };
}
export function tallyTimeTurns(ts: ReadonlyArray<TimeTurn>): Record<TimeScene, Record<TimeHandling, number>> {
  const out = {} as Record<TimeScene, Record<TimeHandling, number>>;
  for (const s of Object.keys(TIME_SCENE_JA) as TimeScene[]) out[s] = { restate_date: 0, promise_due: 0, no_touch: 0 };
  for (const t of ts) out[t.scene][t.handling]++;
  return out;
}
