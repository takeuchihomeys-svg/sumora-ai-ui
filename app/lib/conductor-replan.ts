// app/lib/conductor-replan.ts — 途中でお客様の新しい LINE が来た時に、計画を立て直すかの候補の網（作業員5・11/05・既定 off・純関数）
//
// 竹内さんの決定（KB P1 ea2a9405②「処理の途中でお客様の新しい LINE が来たら計画を立て直す」・P0 575a7cd5 の子）:
//   新しい通で重点が変わるかを読み直し、変わる時だけ立て直す。古い計画のまま下書きを出さない。
//   ここは候補の網だけ（決めるのはブレイン・P0 feedback_remove_non_brain_criteria）:
//     keep  ＝スタンプ・絵文字・お礼・了承だけの通。前の通のブレインの判断と計画をそのまま使う（全部の再実行を省く）。前の判断に AIX があれば必ず残す（KB 2d0f33cf）
//     reread＝質問・依頼・取り消し・条件の言い直し・物件の持ち込みがある通。今の「ブレインを1回再実行」の道へ（B の配線で、軽い読みで重点が変わるかを先に見る）
//   棚卸し（11/05）: brain-core の書き込みの歯止め（updated_at・brainWriteBlock）・bg-async の追加の発言でブレインを1回再実行（75秒未満）・
//     draft-supersede（新しい発言があれば保存しない／保存後に戻す）・generate-reply の T1/T2。足りなかったのは「立て直すかの判断」「計画の見た時刻」「digest の印」。
// 切替: CONDUCTOR_REPLAN（既定 off＝今と同じ・どの通も再実行）。on にするのは E（竹内さんの番の2通目の数え）で keep の誤り0を確かめてから
type Env = Record<string, string | undefined>;
// 2026-11-06 統括役の決め: 既定 on（keep は合図の無い番＝スタンプ・お礼・了承だけ・竹内さんの番 120 で再実行は 直った1・崩れた3＝損なし・keep の誤り0）。止める CONDUCTOR_REPLAN=off
export const conductorReplanOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_REPLAN ?? "").trim().toLowerCase() !== "off";

/** お礼・了承・スタンプだけの通（短い・質問や依頼の言葉が無い） */
const ACK_ONLY_RE = /^(?:\[スタンプ\]|\[絵文字\]|はい|はーい|了解(?:です|しました)?|承知(?:しました|致しました|いたしました)?|かしこまりました|わかりました|分かりました|ありがとうございます|ありがとうございました|有難うございます|よろしくお願い(?:します|致します|いたします)|宜しくお願い(?:します|致します|いたします)|お願いします|OK|ok|オッケー|大丈夫です|助かります|[!！。、〜ー\s‍️]|\p{Extended_Pictographic}|\p{Emoji_Modifier})+$/u;
/** 依頼・質問・取り消し・条件・持ち込みの合図（あれば reread） */
const ASK_RE = /[?？]|ですか|ますか|でしょうか|教えて|ください|下さい|お願いしたい|頂けますか|いただけますか|やっぱり|やはり|キャンセル|取り消|やめ|変更|変えて|予算|家賃|エリア|駅|間取り|内覧|内見|申込|見積|初期費用|https?:\/\/|\[画像\]|\[動画\]|\[ファイル\]/;

export type ReplanCandidate = { kind: "keep" | "reread"; why: string; keepAix: string | null };
/**
 * 新しく届いた通（前の分析の後に来たお客様の通・古い順）と、前の判断から、立て直すかの候補を出す。
 *   keep の時も、前の判断の AIX（例: ピックアップの約束の直後のお礼 → AIX で物件を送る・KB 2d0f33cf）は keepAix で残す＝前の判断を変えない
 */
export function replanCandidate(o: { newTexts: ReadonlyArray<string | null>; prevAix?: string | null }): ReplanCandidate {
  const texts = o.newTexts.map((t) => String(t ?? "").trim()).filter(Boolean);
  const keepAix = o.prevAix ?? null;
  if (!texts.length) return { kind: "keep", why: "新しい通が空", keepAix };
  const joined = texts.join("\n");
  if (ASK_RE.test(joined)) return { kind: "reread", why: "依頼・質問・持ち込みの合図", keepAix: null };
  if (texts.every((t) => t.length <= 30 && ACK_ONLY_RE.test(t))) return { kind: "keep", why: /スタンプ/.test(joined) ? "スタンプ" : "お礼・了承だけ", keepAix };
  return { kind: "reread", why: "読まないと分からない通", keepAix: null };
}

/** 計画（重点・組み立て）が、届いている一番新しいお客様の発言を見て作られたか。見た時刻が古ければ stale＝読む側は使わない */
export function planIsStale(seenCustomerAt: string | null | undefined, latestCustomerAt: string | null | undefined): boolean {
  if (!latestCustomerAt) return false;
  if (!seenCustomerAt) return true;
  return Date.parse(latestCustomerAt) > Date.parse(seenCustomerAt);
}

/** digest.rp: keep:スタンプ／reread:同じ／replan:前→後／t2（立て直す時間が無く鮮度の判定に任せた） */
export function replanDigest(o: { kind: "keep" | "reread" | "replan" | "t2"; why?: string | null; from?: string | null; to?: string | null }): string {
  if (o.kind === "replan") return `replan:${o.from ?? "-"}→${o.to ?? "-"}`;
  if (o.kind === "reread") return `reread:${(o.why ?? "同じ").slice(0, 10)}`;
  if (o.kind === "keep") return `keep:${(o.why ?? "").slice(0, 10)}`;
  return "t2";
}
