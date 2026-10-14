// ack-exhausted-reply.ts — 竹内さんの決定（2026-10-14・設計知見 P1）の2つ（純関数）
//
// 1. 決定 C（10/14）: **ピックアップの約束**の直後にお客様がお礼・了承だけを言った番は、お礼に短く返信する（その後に約束を果たす AIX）。
//    旧: 台帳の約束（resolveStaffPromiseAix）が、お礼・了承だけの番に物件の AIX を立てていた（試験 q110・q112 は毎回 AIX:property_send で落ちた）。
//    確認・見積・交渉の約束の直後のお礼は旧のまま＝約束を果たす AIX（約8割はスタッフが後で約束を果たす AIX を送る・q094）。
//    受けだけか待ちの形の1文かは ack_form（竹内さんの使い分け・repeat-brain-align）。約束の催促（「まだですか」）は今まで通り約束を果たす AIX。
//    戻す: ACK_AFTER_PROMISE_REPLY=off
// 2. 物件を出し切った後にお客様が条件を足した・言い直した番は、左右のボタン（物件の AIX＋全力サポート）ではなく返信で締める
//    （足した条件を受け止め、新着が出次第お送りする約束で閉じる）。左右の形（決定 B・f6af682d）は「物件を探す番」（もっと送って・他にあるか・新着）のまま。
//    戻す: EXHAUSTED_CONDITION_REPLY=off

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export function ackAfterPromiseReplyEnabled(env: Env = envOf()): boolean {
  return (env.ACK_AFTER_PROMISE_REPLY ?? "").trim().toLowerCase() !== "off";
}
export function exhaustedConditionReplyEnabled(env: Env = envOf()): boolean {
  return (env.EXHAUSTED_CONDITION_REPLY ?? "").trim().toLowerCase() !== "off";
}

const PROMISE_JA: Record<string, string> = {
  pickup: "ピックアップしてお送りする", check: "確認する", estimate: "御見積書をお送りする", negotiation: "交渉する", meeting: "待ち合わせをご連絡する",
};

/** 約束の直後のお礼・了承だけの番の返信の方向（ブレインの reply_direction） */
export function ackAfterPromiseDirection(kind: string, laterAix: string | null): string {
  const what = PROMISE_JA[kind] ?? "お約束した事をする";
  return `約束（${what}）の直後のお礼・了承だけ＝お礼に短く返信する（受けだけか、まだ果たしていない約束の待ちの形の1文「〜出来次第お送りさせて頂きます！！」＋締め。新しい約束・提案・物件は足さない）。約束を果たす AIX${laterAix ? `【${laterAix}】` : ""}はその後で出す`;
}

/** 出し切った後に条件を足した・言い直した番か（ブレインの condition_change_type で読む。広げる＝condition_relax・物件を送ってほしい＝pickup_request は外す） */
export function exhaustedConditionAddTurn(o: { conditionChangeType: string | null | undefined; exhausted: boolean; ackOnly: boolean; env?: Env }): boolean {
  if (!exhaustedConditionReplyEnabled(o.env) || !o.exhausted || o.ackOnly) return false;
  return /^(?:equip_add|rent_change|layout_change|area_change|multi)$/.test(String(o.conditionChangeType ?? ""));
}

export const EXHAUSTED_CONDITION_DIRECTION = "今の条件のお部屋は出し切った後にお客様が条件を足した・言い直した番＝返信で締める: 足した条件を受け止め（お詫びには一言）、その条件も含めて新着状況を随時確認し、募集に出次第お送りする約束で閉じる（改めてピックアップとは言わない・物件の AIX や全力サポートのボタンにしない）";

/** LLM の前の材料（出し切りの印がある番だけ・splitMaterialLine に足す） */
export function exhaustedConditionMaterial(env: Env = envOf()): string {
  return exhaustedConditionReplyEnabled(env)
    ? "（竹内さんの決定 10/14: 出し切った後にお客様が条件を足した・言い直した番は、左右のボタンではなく返信で締める＝足した条件を受け止め、新着が出次第お送りする約束で閉じる。左右の形は「もっと送って・他にあるか・新着」の物件を探す番だけ）"
    : "";
}

/** LLM の前の材料（約束が残っている番の行に足す） */
export function ackAfterPromiseMaterial(env: Env = envOf()): string {
  return ackAfterPromiseReplyEnabled(env)
    ? "（竹内さんの決定 10/14 C: ピックアップの約束の直後にお客様がお礼・了承だけを言った番は、お礼に短く返信する＝aix は null・受けだけか待ちの形の1文は ack_form・物件の AIX はその後で出す。確認・見積の約束の直後のお礼は約束を果たす AIX のまま。約束の催促は約束を果たす AIX）"
    : "";
}
