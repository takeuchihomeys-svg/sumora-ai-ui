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
export function exhaustedConditionAddTurn(o: { conditionChangeType: string | null | undefined; exhausted: boolean; ackOnly: boolean; env?: Env;
  /** 2026-10-15 軸（q153・q154）: ブレインの turn_contract の依頼の軸（about・polarity）。あればこれで決める（condition_change_type は旧の網） */
  axisAsks?: ReadonlyArray<{ about?: string | null; polarity?: string | null }> | null }): boolean {
  if (!exhaustedConditionReplyEnabled(o.env) || !o.exhausted || o.ackOnly) return false;
  if (!/^(?:equip_add|rent_change|layout_change|area_change|multi)$/.test(String(o.conditionChangeType ?? ""))) return false;
  // 軸がある時はブレインの「何について・向き」で決める（EXHAUSTED_CONDITION_AXIS=off で前の形）:
  //   ゆるめた・外した（relax・remove）＝新しい条件ではまだ探していない＝出し切りの外（竹内さん Q4「広がった時は除く」・q154「ペット可じゃなくてもいい」→改めてピックアップ）
  //   探す条件の依頼が無い（送った物件への反応「予算オーバー」等・登録の条件は変わっていない）＝条件を足した番ではない（q153 →今の条件でお送りする約束）
  const axis = (o.axisAsks ?? []).filter((a) => !!a && !!a.about);
  if (exhaustedConditionAxisEnabled(o.env) && axis.length) {
    if (axis.some((a) => a.polarity === "relax" || a.polarity === "remove")) return false;
    if (!axis.some((a) => a.about === "search_condition")) return false;
  }
  return true;
}
/** 出し切りの後の条件の足しをブレインの軸（about・polarity）で決めるか（既定 on・EXHAUSTED_CONDITION_AXIS=off で condition_change_type だけ） */
export function exhaustedConditionAxisEnabled(env: Env = envOf()): boolean {
  return (env.EXHAUSTED_CONDITION_AXIS ?? "").trim().toLowerCase() !== "off";
}
/** 材料の行の範囲の1文（足した・絞った番だけ。ゆるめた番・送った物件への反応の番は外＝理由つき） */
/** 戻す EXHAUSTED_BROUGHT_FIRST=off */
export function exhaustedBroughtFirstEnabled(env: Env): boolean { return (env.EXHAUSTED_BROUGHT_FIRST ?? "").toLowerCase() !== "off"; }
function exhaustedConditionScope(env: Env): string {
  return exhaustedConditionAxisEnabled(env)
    ? "ただし、条件をゆるめた・外した・広げた番（「〇〇じゃなくてもいい」・家賃を上げる・エリアを広げる）は新しい条件ではまだ探していない＝出し切りの外で、竹内さんはゆるめた条件で改めてピックアップしてお送りする約束にする。"
      + "送った物件への反応（「予算オーバー」「ここは無理」等）で登録の条件が変わっていない番も条件を足した番ではない＝今の条件でお部屋をお送りする約束にする"
    : "";
}

export const EXHAUSTED_CONDITION_DIRECTION = "今の条件のお部屋は出し切った後にお客様が条件を足した・言い直した番＝返信で締める: 足した条件を受け止め（お詫びには一言）、その条件も含めて新着状況を随時確認し、募集に出次第お送りする約束で閉じる（改めてピックアップとは言わない・物件の AIX や全力サポートのボタンにしない）";

/** LLM の前の材料（出し切りの印がある番だけ・splitMaterialLine に足す） */
export function exhaustedConditionMaterial(env: Env = envOf()): string {
  return exhaustedConditionReplyEnabled(env)
    ? `（竹内さんの決定 10/14: 出し切った後にお客様が条件を足した・言い直した番は、左右のボタンではなく返信で締める＝足した条件を受け止め、新着が出次第お送りする約束で閉じる。左右の形は「もっと送って・他にあるか・新着」の物件を探す番だけ。${exhaustedConditionScope(env)}）`
    : "";
}

/**
 * 2026-10-14 出し切りの後の条件の足しもブレイン基準に（決定 C と同じ観点）。
 *   材料: 出し切りの印がある番に「条件を足した・言い直した番なら返信で締める」を今の番の行で渡す（exhaustedConditionTurnLine）。
 *   後の規則（rule:exhausted_condition_reply）は、ブレイン自身が物件の AIX を選んだ番を上書きしない（食い違いを記録）。
 *   ブレインが返信を選び、別の規則（2段の約束）が約束の返信に変えた番・ブレインが返信を選んだ番は今まで通り返信で締める。
 *   戻す: EXHAUSTED_CONDITION_BRAIN=off（旧: 材料の行なし・LLM の物件の AIX も規則で返信にする）
 */
// 10/14 試験（DeepSeek・q003 q004 q006 q007・前後1回）: 前は q006 q007 の本質（LLM）が物件の AIX・規則で返信 3/4／後は材料だけで本質も返信 4/4＝既定 on
const EXHAUSTED_CONDITION_BRAIN_DEFAULT = true;
export function exhaustedConditionBrainEnabled(env: Env = envOf()): boolean {
  const v = (env.EXHAUSTED_CONDITION_BRAIN ?? "").trim().toLowerCase();
  if (v === "off") return false;
  if (v === "on") return true;
  return EXHAUSTED_CONDITION_BRAIN_DEFAULT;
}
export function exhaustedConditionTurnLine(env: Env = envOf()): string {
  if (!exhaustedConditionReplyEnabled(env)) return "";
  return "【今の番（材料・竹内さんの決定 10/14）】この会話には「今の条件のお部屋は出し切った」印がある。お客様の今の発言が条件を足した・言い直した（設備・家賃・間取り・エリアを変えた）番なら、"
    + "竹内さんは物件の AIX（物件ピックアップした）も全力サポートのボタンも出さず、返信で締める＝足した条件を受け止め、その条件も含めて新着を随時確認し出次第お送りする約束で閉じる（aix は null・reply_mode は auto_reply）。"
    + "「もっと送って・他にあるか・新着は」の物件を探す番だけは物件の AIX と全力サポートの左右。" + exhaustedConditionScope(env)
    // 2026-10-16（q133）: 材料の主語の直し（竹内さん→お客様に伏せていた）で、この行がそのまま効くようになり、同じ連投の持ち込みの物件の約束まで出し切りの締めに倒れた
    + (exhaustedBroughtFirstEnabled(env) ? "同じ連投でお客様が物件（URL・画像）を送ってきた・特定の物件の見積や空きを頼んだ番は、その物件の約束（募集状況の確認・御見積書）が先（出し切りの締めにしない）。" : "");
}

/** LLM の前の材料（約束が残っている番の行に足す） */
export function ackAfterPromiseMaterial(env: Env = envOf()): string {
  return ackAfterPromiseReplyEnabled(env)
    ? "（竹内さんの決定 10/14 C: ピックアップの約束の直後にお客様がお礼・了承だけを言った番は、お礼に短く返信する＝aix は null・受けだけか待ちの形の1文は ack_form・物件の AIX はその後で出す。確認・見積の約束の直後のお礼は約束を果たす AIX のまま。約束の催促は約束を果たす AIX）"
    : "";
}

// ─── 2026-10-14 決定 C をブレイン基準に（P0 9eb6aa9c ②・見直し役の指摘）────────────────────────
// 旧: 規則（rule:ack_after_promise_reply）が LLM の物件の AIX を finalAix=null にして返信に変えていた＝ブレインの判断の上書き。
// 新: 今の番が決定 C の番か（網＝お礼・了承だけ×最後の約束がピックアップ×確認・見積の約束が残っていない）を LLM の前に材料で渡し、
//     返信か AIX かはブレインが決める。後の規則は「ブレインが決められなかった時（aix の欄が無い）」の網だけ。
//     ブレインが AIX を選んだ時は上書きせず、食い違いを demoted_overrides に記録する。
// 戻す: ACK_AFTER_PROMISE_BRAIN=off（旧の上書き）
export function ackAfterPromiseBrainEnabled(env: Env = envOf()): boolean {
  return (env.ACK_AFTER_PROMISE_BRAIN ?? "").trim().toLowerCase() !== "off";
}

/** 今の番が決定 C の番か（材料の網・決めるのはブレイン）。lastEntry＝台帳の最後のこちらの約束 */
export function ackAfterPickupTurn(o: {
  ackOnly: boolean; nudge: boolean;
  lastEntry: { kind: string; status: string } | null | undefined;
  pickupOpen: boolean; estimateOpen: boolean; confirmOpen: boolean;
}): boolean {
  if (!o.ackOnly || o.nudge || !o.pickupOpen) return false;
  if (o.lastEntry?.kind !== "pickup_declared" || o.lastEntry.status !== "promised") return false;
  // 確認・見積の約束が残っていれば、そちらを先に果たす（resolveStaffPromiseAix の PROMISE_ORDER_CHECK_FIRST と同じ向き）＝決定 C の番ではない
  return !o.estimateOpen && !o.confirmOpen;
}

/** LLM の前の今の番の材料の行（決定 C の番の時だけ） */
export function ackAfterPickupTurnLine(env: Env = envOf()): string {
  if (!ackAfterPromiseReplyEnabled(env) || !ackAfterPromiseBrainEnabled(env)) return "";
  return "【今の番（材料・竹内さんの決定 10/14 C）】お客様の今の発言はお礼・了承だけで、直前のこちらの約束は「ピックアップしてお送りする」（まだ物件を送っていない・確認や見積の約束は残っていない）。"
    + "竹内さんはこの番は物件の AIX をまだ出さず、お礼に短く返信して締める（受けだけか「〜出来次第お送りさせて頂きます！！」の待ちの形の1文かは turn_contract.ack_form）。"
    + "約束を果たす物件の AIX（物件ピックアップした／物件オススメ）は、スタッフが物件を探した後の別の番。"
    + "だからこの番の aix は null・reply_mode は auto_reply にする。ただし、会話に今すぐ物件を送るべき事情（お客様が物件をすぐ送ってと頼んでいる 等）を読んだ時だけ物件の AIX にしてよい（その時は reason にその事情を書く）";
}

/** 決定 C の番で、ブレインが決められなかった時（aix の欄が無い）だけ規則で返信にする（網） */
export function ackAfterPromiseRuleApplies(o: { brainMode: boolean; llmAixPresent: boolean }): boolean {
  return !o.brainMode || !o.llmAixPresent;
}
