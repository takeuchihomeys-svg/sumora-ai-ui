// app/lib/unsend-refresh.ts — お客様が LINE で送信を取り消した（unsend）時、その通を見て作ったブレインの判断・下書きを片付けて分析し直すか（純関数）
//
// 2026-10-28 竹内さんの指摘（☆・スモラ・10/26）: お客様が 16:08 の後に3通を取り消した（LINE 本体は「☆がメッセージの送信を取り消しました」×3）。
//   webhook は unsend で messages の行を消していた（line-webhook/route.ts）が、取り消し前の通を見たブレインの判断
//   （brain_decision_logs 07:10:02「床がグレーのお部屋の空きを確認する約束で受ける」）と下書き（ai_draft）・AIX の提案（suggested_aix_meta）・
//   控え（last_brain_meta）は残り、画面も messages の INSERT しか見ていないので取り消した通が出たままだった。
//   竹内さん「削除された部分に対しての返信が出ないように気を付ける」。
// 決め方: 取り消したのがお客様の通で、今の判断（suggested_aix_meta／last_brain_meta）がその通の時刻以降の発言を見ている時は、その判断と下書きを外して分析し直す。
//   スタッフの通の取り消し・判断より後の取り消しは触らない。入れる UNSEND_REFRESH=on（既定 off）
export function unsendRefreshOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.UNSEND_REFRESH ?? "").trim().toLowerCase() === "on";
}

export type UnsendRefreshPlan = { clearSuggested: boolean; clearLast: boolean; clearDraft: boolean; rerun: boolean; reason: string };

const ts = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export function unsendRefreshPlan(o: {
  sender: string | null | undefined;
  unsentAt: string | null | undefined;
  suggestedAnalyzedTs: string | null | undefined;
  lastAnalyzedTs: string | null | undefined;
  hasDraft: boolean;
}): UnsendRefreshPlan {
  const none = (reason: string): UnsendRefreshPlan => ({ clearSuggested: false, clearLast: false, clearDraft: false, rerun: false, reason });
  if (o.sender !== "customer") return none("スタッフの通の取り消し");
  const at = ts(o.unsentAt);
  if (!Number.isFinite(at)) return none("取り消した通の時刻が分からない");
  // 判断がその通を見たか: 判断が見た一番新しいお客様の発言の時刻（analyzed_msg_ts）が、取り消した通の時刻以降（1秒の揺れを見込む）
  const saw = (s: string | null | undefined) => { const t = ts(s); return Number.isFinite(t) && t >= at - 1000; };
  const clearSuggested = saw(o.suggestedAnalyzedTs);
  const clearLast = saw(o.lastAnalyzedTs);
  if (!clearSuggested && !clearLast) return none("今の判断は取り消した通を見ていない");
  return { clearSuggested, clearLast, clearDraft: o.hasDraft, rerun: true, reason: "取り消した通を見た判断・下書きを外して分析し直す" };
}
