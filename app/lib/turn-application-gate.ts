// app/lib/turn-application-gate.ts — 過去の1つの番（竹内さんの送信 等）が「申込の手前」か（純関数・スクリプトで外の LLM に渡す前の門）
//
// 2026-11-11 作業員5（統括役: 文の解剖の 198通の中に申込以降の疑いの番 23d3865f・4f647636 が DeepSeek に渡った可能性）。
//   今までの文の解剖のスクリプトは「言葉の NG（申込書・本人確認…）」だけで外していた＝申込へ押下・審査中の status・記入済みフォームの後の番を落とせない。
//   ここは post-apply.ts の線（申込へ押下・証明書類・記入済みフォーム・申込以降の status・印・戻した時刻）を「その番の時刻」で引き直す。
//   post-apply.deepseekSafeCutoff は「今の」会話の線（今申込中なら全部渡さない）。過去の番は「その番より前に申込の記録があるか」で決める。
//   決まり（memory/test_protocol_brain.md 7）: 申込の書類・本人確認書類・収入の書類の手前で切る。申込以降の会話は対象外。
// 線（fail-closed＝迷えば外す）:
//   ① 記録が読めない → 外す
//   ② 最初の申込の記録（申込へ押下・証明書類・記入済みフォーム・書類の印の通・deal_outcomes.applied_at・outcome_events の applied/won）が番の時刻以前
//      → 外す。ただし最後の記録より後に段階を戻し（status_manual_back_at / deepseek_cutoff_at）、その戻しが番より前なら残す（否決→物件提案中）
//   ③ 記録の時刻が1つも無いのに今が申込以降（status・印）＝いつから申込以降か分からない → 外す
// テスト: app/lib/__tests__/turn-application-gate.test.ts
import { DRAFT_SKIP_STATUSES } from "./conversation-status";

export type TurnApplicationRecords = {
  status: string | null;
  isPostApply: boolean;
  /** 申込の記録の時刻（ISO）。種類ごとに最初と最後 */
  records: Array<{ kind: string; first: string | null; last: string | null }>;
  /** 段階を前に戻した時刻（status_manual_back_at・deepseek_cutoff_at の遅い方） */
  backAt: string | null;
  /** どれかが読めなかった */
  unreadable: boolean;
};

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** その番を外す理由（無ければ null＝申込の手前で渡してよい） */
export function turnApplicationReason(r: TurnApplicationRecords | null | undefined, atIso: string): string | null {
  if (!r || r.unreadable) return "申込の記録が読めない";
  const at = ms(atIso);
  if (at === null) return "番の時刻が読めない";
  const firsts = r.records.map((x) => ({ kind: x.kind, t: ms(x.first) })).filter((x): x is { kind: string; t: number } => x.t !== null);
  const lasts = r.records.map((x) => ms(x.last)).filter((x): x is number => x !== null);
  for (const x of r.records) if ((x.first && ms(x.first) === null) || (x.last && ms(x.last) === null)) return "申込の記録の時刻が読めない";
  const before = firsts.filter((x) => x.t <= at).sort((a, b) => a.t - b.t);
  if (before.length) {
    const lastAll = Math.max(...lasts, ...firsts.map((x) => x.t));
    const back = ms(r.backAt);
    // 全部の申込の記録より後に戻し、その戻しが番より前＝申込前に戻った後の番
    if (back !== null && back > lastAll && back < at) return null;
    return `申込以降（${before[0].kind}の後）`;
  }
  if (!firsts.length && (r.isPostApply || DRAFT_SKIP_STATUSES.has((r.status ?? "").trim()))) return "今が申込以降で始まりの時刻が分からない";
  // 記録の時刻は無いが、申込以降の status から戻した印がある＝戻す前のどこかが申込中（始まりが分からない）→ 戻す前の番は外す
  //   実物（11/11）: 会話 8590144d は押下・書類の記録が無く 9/26 に申込から戻した。9/22〜23 の竹内さんの番 7通（「お部屋抑えていただきたいです」の後を含む）が文の解剖に入っていた
  //   2026-11-11 夜の直し: 戻しの後に書類の印の通（メール・電話の値 等）があると firsts が空でなくなり、この線を通り抜けていた（198通の読みで 8590144d が 0通しか外れなかった）。
  //   → 「戻しより前の記録が1つも無い」＝戻した申込以降の期間が status だけだった時は、戻す前の番を外す
  const back = ms(r.backAt);
  if (back !== null && at < back && !firsts.some((x) => x.t < back)) return "申込から戻す前の番（始まりの時刻が分からない）";
  return null;
}
