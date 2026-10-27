// app/lib/far-move-in-todo.ts — 入居の時期が先のお客様の「物件を探して送る」仕事を、連絡の日まで待つ形にする（純関数・DB も LLM もなし）
//
// 2026-10-28 竹内さん（響夢さん・やることリスト「⑤AIX【物件ピックアップした】：条件（東大阪市・〜6万・1K）で探して送る（期限 10/17 過ぎ）（5日）」）
//   「今物件を探すわけではない。12月末〜1月前半で引越しをする形となる。なぜ認識できていないのか。このような部分を細かく従業員に指示を出すようにする」
//   お客様の言った入居の時期（contact-promise.moveInFromCustomerText）から連絡の日（1ヶ月半前・contact-promise.farMoveInPlan＝ブレインの far_move_in と同じ計算）を出し、
//   連絡の日がまだ先（farMoveInMinDays 日以上）の間は:
//     ・やることリストの物件を送る行（AIX要対応・約束・ターゲットの新着確認）を「⏳11月15日に連絡（12月末〜1月前半入居）・それまで物件は探さない」の待ちの行にする（番号を振らない・残りに数えない）
//     ・AIX要対応（property_send／property_recommendation）の pending は取り下げ、カレンダーに【必ず】【連絡日】の行を入れる（aix-action-items）
//   連絡の日が近づいたら（7日未満）今まで通りの物件を送る行に戻る。
//   切替 TODO_FAR_MOVE_IN=on の時だけ（既定 off）。
// テスト: app/lib/__tests__/far-move-in-todo.test.ts
import { moveInFromCustomerText, farMoveInPlan, ymdStr, type FarMoveInPlan } from "./contact-promise";

export function todoFarMoveInEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TODO_FAR_MOVE_IN ?? "").trim().toLowerCase() === "on";
}

/** お客様の入居の時期を読む発言の古さの上限（これより前の発言の時期は今は当てにしない） */
export const FAR_MOVE_IN_TURN_MAX_DAYS = 60;

export type MoveInTurn = { conversation_id?: string; text: string | null; created_at: string };

/** 会話のお客様の発言（どの順でも）から、一番新しい入居の時期の発言で計画を作る。連絡の日が近い・読めなければ null */
export function farMoveInOfTurns(turns: ReadonlyArray<MoveInTurn>, nowMs: number): FarMoveInPlan | null {
  const min = nowMs - FAR_MOVE_IN_TURN_MAX_DAYS * 86_400_000;
  const sorted = [...turns].filter((m) => Date.parse(m.created_at) >= min && Date.parse(m.created_at) <= nowMs)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const m of sorted) {
    const s = moveInFromCustomerText(m.text, m.created_at);
    if (s) return farMoveInPlan(s, nowMs, "customer_text");
  }
  return null;
}

/** 入居の時期の言い方（「12月末から1月前半」→「12月末〜1月前半」・幅が無ければ始まりの言い方） */
export function moveInRangeLabel(p: Pick<FarMoveInPlan, "moveInLabel" | "evidence">): string {
  const ev = String(p.evidence ?? "").normalize("NFKC");
  const m = ev.match(/((?:\d{4}年)?\d{1,2}月(?:上旬|中旬|下旬|末|頭|初め|前半|後半|\d{1,2}日)?)(?:から|〜|~|-|ー)((?:\d{4}年)?\d{1,2}月(?:上旬|中旬|下旬|末|頭|初め|前半|後半|\d{1,2}日)?)/);
  return m ? `${m[1]}〜${m[2]}` : p.moveInLabel;
}

/** 待ちの行の文（例「⏳11月15日に連絡（12月末〜1月前半入居）・それまで物件は探さない」の「⏳」の後ろ） */
export function farMoveInWaitText(p: FarMoveInPlan): string {
  return `${p.contactLabel}に連絡（${moveInRangeLabel(p)}入居）・それまで物件は探さない`;
}

/** 連絡の日（YYYY-MM-DD） */
export const contactYmdOf = (p: FarMoveInPlan) => ymdStr(p.contact);
