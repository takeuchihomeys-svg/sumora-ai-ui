// 決定論の上書きを「ブレインへの材料＋食い違いのログ」に下げる（2026-10-13 竹内さん・ブレインの使い残し 4）
//
// 設計知見 P0 9eb6aa9c「判断はすべてブレイン基準。決定論の計算は候補を拾う網に下げ、済み・まだ・どの一手かはブレインが文を読んで決める」。
//   brain-core の LLM の後に、語・場面・状態の規則が finalAix を書き換えていた（decision_source が signal:* / correction:image_only / rule:* の番）。
//   30日（brain_decision_logs・scripts/audit-brain-reuse-llm-calls.ts --decisions）: signal:* 約150番で押された AIX と同じは 9・
//   correction:image_only 0/28・rule:two_stage_promise(pickup_unless_ack) 0/29・rule:closed_ack_wait 0/18・rule:viewing_day_ack 0/12。
// 下げ方: 規則が当たっても finalAix を変えず、何に変えるはずだったかを demoted_overrides（meta）とログ（brain:override-demoted）に残す。
//   規則の材料（場面の証拠・内覧の流れ・ピックアップの約束・締めの後のお礼 等）はブレインのプロンプトに既にあるか、ここで足す。
// 1つずつ下げる（竹内さん「1つずつ下げてすぐ本番に入れ、悪くなった問題は後も直し続ける」）。家族ごとに戻す環境変数がある。

type Env = Record<string, string | undefined>;

export type OverrideFamily = "signal" | "signal_decided" | "image_only" | "two_stage_promise" | "closed_ack_wait" | "viewing_day_ack" | "turn_route_guards" | "search_exhausted" | "staff_promise";

/** 家族ごとの戻す環境変数（"off" で旧の上書きに戻す） */
export const DEMOTE_ENV: Record<OverrideFamily, string> = {
  signal: "BRAIN_DEMOTE_SIGNAL",
  signal_decided: "BRAIN_DEMOTE_SIGNAL_DECIDED",
  image_only: "BRAIN_DEMOTE_IMAGE_ONLY",
  two_stage_promise: "BRAIN_DEMOTE_TWO_STAGE",
  closed_ack_wait: "BRAIN_DEMOTE_CLOSED_ACK",
  viewing_day_ack: "BRAIN_DEMOTE_VIEWING_DAY_ACK",
  turn_route_guards: "BRAIN_DEMOTE_TURN_GUARDS",
  // 2026-10-13 棚卸し B-1: 送付だけの印（weak）での出し切り→【全力サポート】の書き換え（search-exhausted.weakExhaustDemoted と同じ変数）
  search_exhausted: "BRAIN_DEMOTE_SEARCH_EXHAUSTED",
  // 2026-10-14 まだ果たしていないこちらの約束（aix-task-link.resolveStaffPromiseAix・promise:*）が LLM の AIX を約束の AIX に差し替える
  staff_promise: "BRAIN_DEMOTE_STAFF_PROMISE",
};

/** 下げた家族（既定は下げる＝on。家族を足す時はここで既定を決める） */
const DEFAULT_ON: Record<OverrideFamily, boolean> = {
  signal: true,
  // 竹内さんの決定で入れた場面の信号（室内写真 S11・内覧の流れの段階）。10/13 の試験で下げると q017（室内写真→返信）・q045（内覧の希望→全力サポート）の道が外れた
  //   ＝ブレインの材料（場面の証拠・内覧の流れの行）だけではまだ届かない → 今は上書きのまま（食い違いのログも出ない）。材料を強くしてから下げる
  signal_decided: false,
  image_only: true,
  two_stage_promise: true,
  closed_ack_wait: true,
  viewing_day_ack: true,
  // 2026-10-14 配線（brain-core の turn-route-guards 6か所が applyOverride を通る）。宣言は true だったが配線漏れで実際は上書きだった＝今の動きのまま false にした。
  //   この歯止めは AIX→返信の向き（検討します・キャンセル・決まった内覧への追加）＝AIX の言い過ぎを減らす側。下げるのは BRAIN_DEMOTE_TURN_GUARDS=on（試験で比べた結果は dept_line_reply.md 10/14）
  turn_route_guards: false,
  // 10/13 試験の出し切り7問で下げると道 7→5（試験の正解は送付だけの印の後でも全力サポート）＝今は上書きのまま。材料を強くしてから下げる（search-exhausted.weakExhaustDemoted）
  search_exhausted: false,
  // 2026-10-14 30日: promise:check 74・pickup 169・estimate 45番。LLM の生の答えがある番の食い違い check 21（ブレイン正 12／規則正 4）・estimate 5（3／1）・pickup 4（2／2）
  //   ＝ブレインの答えのまま・約束が残っている事は材料（行動台帳の宣言＋staffPromiseMaterialLine）。LLM が同じ族を選んだ番は今まで通り promise:* の出所にする
  staff_promise: true,
};

export function overrideDemoted(f: OverrideFamily, env: Env = process.env): boolean {
  const v = (env[DEMOTE_ENV[f]] ?? "").trim().toLowerCase();
  if (v === "off") return false;
  if (v === "on") return true;
  return DEFAULT_ON[f];
}

export type DemotedOverride = { family: OverrideFamily; src: string; would: string | null; brain: string | null };

/**
 * 2026-10-22 D案（8c00271d②「D案の時は決まった処理の上書きを止めて核を勝たせる」）: その番で D案の核が判断した時は、
 *   上書きの関所（applyOverride）を家族の既定に関わらず全部「下げる」（記録だけ・finalAix は核のまま）。番ごとの印＝一覧に付ける（他の会話に漏れない）
 */
export type DemotedList = DemotedOverride[] & { coreWins?: boolean };
export function markCoreWins(list: DemotedOverride[]): void { (list as DemotedList).coreWins = true; }

/** 下げた上書きを1つ足す（同じ src は1回） */
export function addDemoted(list: DemotedOverride[], d: DemotedOverride): void {
  if (list.some((x) => x.src === d.src)) return;
  list.push(d);
}

/**
 * 上書きの関所（brain-core の各規則が使う）。規則が当たった時に呼ぶ。
 *   下げている家族 → 記録だけして false（finalAix はブレインのまま）／下げていない → true（呼ぶ側が上書きする）
 *   ブレインの判断と規則の答えが同じ時は記録しない（食い違いではない）
 */
export function applyOverride(list: DemotedOverride[], family: OverrideFamily, src: string, would: string | null, brain: string | null, env: Env = process.env): boolean {
  if (!(list as DemotedList).coreWins && !overrideDemoted(family, env)) return true;
  if ((would ?? null) !== (brain ?? null)) addDemoted(list, { family, src, would: would ?? null, brain: brain ?? null });
  return false;
}

/** meta に残す形（小さく・最大8件） */
export function compactDemoted(list: DemotedOverride[]): Array<{ f: OverrideFamily; src: string; would: string | null; brain: string | null }> | undefined {
  if (list.length === 0) return undefined;
  return list.slice(0, 8).map((d) => ({ f: d.family, src: d.src, would: d.would, brain: d.brain }));
}

// ─── 4-3: 2段の約束（物件の AIX → ピックアップの約束の返信）───────────────────────────
// 2段（two-stage.ts）の pickup・pickup_unless_ack は、ブレインが物件の AIX を選んでも約束の返信に書き換えていた（30日 rule:two_stage_promise(pickup_unless_ack) 29番）。
//   材料: 送れる物件が手元にあるか（売上サポの新しい候補＝pickupReady）を LLM の前にプロンプトへ渡す（pickupReadyMaterialLine）。
//   ブレインが同じ出力の turn_contract でその依頼を route=aix（約束でなく AIX で直接）と言い、送れる物件があり、約束の項目が無い時だけ上書きしない。
//   ブレインの turn_contract が無い・約束と言っている・送れる物件が無い時は今まで通り約束の返信（安全側）。

/** プロンプトに入れる材料の行（物件の AIX を直接出せるか）。promised＝この件のピックアップの約束がもうある（pickupPromiseOpen）・null は分からない */
export function pickupReadyMaterialLine(ready: boolean, promised: boolean | null = null, env: Env = process.env): string {
  // 2026-10-14 竹内さん（10/13「AIX か返信か分別」）: 約束していない番の物件の AIX は、竹内さんはまず約束（条件の番 竹内さん 約束 126／AIX 5・two-stage の線）
  const notPromised = ready && promised === false && directPropertyNeedsPromise(env)
    ? `。ただし、この件ではまだピックアップしてお送りする約束をしていない＝竹内さんはまず約束の返信（条件の番 約束 126・物件の AIX を直接 5）。物件の AIX を直接出すのは、もう約束している・今日もう同じ約束をした・お礼や了承だけの番${ackCMaterialOn(true, env) ? "（ピックアップの約束の直後のお礼・了承だけの番は決定 C で返信）" : ""}`
    : "";
  return ready
    ? `【送れる物件の候補（材料）】売上サポに今送れる新しい物件の候補がある＝物件の AIX（物件ピックアップした・1件特にオススメ）を直接出せる。ただし今のお客様の発言が条件の言い直し・質問・ご事情なら、先に答えてピックアップの約束（turn_contract の該当の route は promise）でもよい。どちらかを aix と turn_contract で同じに書く${notPromised}`
    : "【送れる物件の候補（材料）】売上サポに今送れる新しい物件の候補は無い＝物件の AIX を選ぶ番でも、まずピックアップしてお送りする約束の返信（turn_contract の該当の route は promise・aix は物件の AIX のままでよい＝約束の後で AIX）";
}

// ─── 2026-10-14: まだ果たしていないこちらの約束（promise:*）─────────────────────────────
/** LLM の前に渡す材料の行（約束が残っている事・果たす AIX・食い違いの数）。約束が無ければ空 */
export function staffPromiseMaterialLine(f: { estimatePromisedUnfulfilled?: boolean; pickupPromisedUnfulfilled?: boolean; confirmationPromisedUnfulfilled?: boolean }): string {
  const ks: string[] = [];
  if (f.confirmationPromisedUnfulfilled) ks.push("確認（果たすのは AIX【物件確認した】・内覧できるかの確認は【内覧調整】）");
  if (f.estimatePromisedUnfulfilled) ks.push("御見積書（果たすのは AIX【見積書送る】）");
  if (f.pickupPromisedUnfulfilled) ks.push("ピックアップ（果たすのは AIX【物件ピックアップした】／【物件オススメ】）");
  if (!ks.length) return "";
  // 2026-10-14 決定 C をブレイン基準に: ピックアップの約束の直後のお礼・了承だけは返信（材料どうしを食い違わせない・ACK_AFTER_PROMISE_BRAIN=off で旧の文）
  const cNote = ackCMaterialOn(f.pickupPromisedUnfulfilled) ? "（ただしピックアップの約束の直後のお礼・了承だけの番は、竹内さんの決定 C で返信＝物件の AIX はその後）" : "";
  return `【まだ果たしていないこちらの約束（材料）】${ks.join("・")}。お客様の今の発言がお礼・了承だけ・約束の催促なら、約束を果たす AIX の番${cNote}。お客様が新しい問い・ご事情を書いた番は、その問いに答える返信が先のこともある（30日・確認の約束が残る番の食い違い: ブレインの答えが正 12・約束の AIX が正 4）`;
}
/** 決定 C（ピックアップの約束の直後のお礼・了承だけ＝返信）を材料の文にも書くか（ack-exhausted-reply の2つの環境変数と同じ・ここで読む） */
function ackCMaterialOn(pickup: boolean | undefined, env: Env = process.env): boolean {
  if (!pickup) return false;
  const off = (k: string) => (env[k] ?? "").trim().toLowerCase() === "off";
  return !off("ACK_AFTER_PROMISE_REPLY") && !off("ACK_AFTER_PROMISE_BRAIN");
}
/**
 * 約束の催促か（「まだですか」「どうなりましたか」「いつ頃になりますか」「物件まだ？」）。10/14 確かめる人: 催促はお礼・了承だけではないが、
 *   約束を果たす番＝staff_promise を下げない（約束の AIX のまま）。ai_prompt_rules FEEDBACK-cff5a26b（催促には口約束で終わらせず AIX）と同じ向き
 */
export function isPromiseNudge(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (t.length > 80) return false;
  return /まだ(?:です|でしょう|かな|ですか|ですかね)?[?？]|まだ(?:来|届|き|ですか|でしょうか)|どう(?:なり|なって)(?:まし|ます)|進捗|いつ(?:頃|ごろ)?(?:に)?(?:なり|届|来|送)|(?:提案|物件|見積|結果|連絡)(?:は)?まだ(?:[?？]|です|でしょう|来|届|かな|$)/.test(t);
}
/** 約束の AIX と LLM の AIX が同じ族か（同じなら今まで通り promise:* の出所にして2段の言い直しを防ぐ） */
export function samePromiseFamily(promiseAction: string, llmAix: string | null): boolean {
  if (!llmAix) return false;
  const fam = (a: string) => (/^property_(?:send|recommendation|search)$/.test(a) ? "物件" : a === "acknowledge_check" ? "property_check_result" : a);
  return fam(promiseAction) === fam(llmAix);
}

/**
 * 2026-10-14 竹内さん（10/13）「ちゃんと AIX か返信か分別」: 物件の AIX を直接出す（2段の約束を挟まない）のは、この件のピックアップの約束が
 *   もうある時だけ（下げた 4-3 の「ブレインが route=aix と言い・送れる物件がある」に「約束済み」を足す）。まだ約束していない番は約束の返信が先
 *   （two-stage の線: 条件の番 竹内さん 約束 126／AIX 5）。戻す: TWO_STAGE_DIRECT_NEEDS_PROMISE=off
 */
export function directPropertyNeedsPromise(env: Env = process.env): boolean {
  return (env.TWO_STAGE_DIRECT_NEEDS_PROMISE ?? "").trim().toLowerCase() !== "off";
}
/** この件のピックアップの約束がまだ果たされずにあるか（台帳の最後の約束がピックアップで、その後に物件を送っていない・または今日もうピックアップを約束した） */
export function pickupPromiseOpen(f: { lastPromisedKind?: string | null; lastPromisedAt?: string | null; lastPropertiesSentAt?: string | null }, promisedTodayKinds: ReadonlyArray<string> = []): boolean {
  if (promisedTodayKinds.includes("pickup")) return true;
  if (f.lastPromisedKind !== "pickup_declared" || !f.lastPromisedAt) return false;
  const p = Date.parse(f.lastPromisedAt);
  const s = f.lastPropertiesSentAt ? Date.parse(f.lastPropertiesSentAt) : NaN;
  return Number.isFinite(p) && (!Number.isFinite(s) || s < p);
}

const PROPERTY_AIX_RE = /^(?:property_send|property_recommendation|property_search)$/;
/** ブレインの turn_contract が、物件の依頼を約束でなく AIX で直接と言っているか（route=aix の物件の項目があり、探す・送る約束の項目が無い） */
export function brainContractSaysDirectPropertyAix(raw: unknown, finalAix: string | null): boolean {
  if (!finalAix || !PROPERTY_AIX_RE.test(finalAix)) return false;
  const asks = raw && typeof raw === "object" && Array.isArray((raw as { asks?: unknown }).asks) ? (raw as { asks: Array<Record<string, unknown>> }).asks : null;
  if (!asks || asks.length === 0) return false;
  const direct = asks.some((a) => a?.route === "aix" && PROPERTY_AIX_RE.test(String(a?.aix ?? "")));
  const promised = asks.some((a) => a?.route === "promise" && /ピックアップ|探|お送り|物件|pickup|property/.test(`${a?.answer ?? ""} ${a?.topic ?? ""} ${a?.aix ?? ""}`));
  return direct && !promised;
}

/**
 * 2026-10-15（q153）: ブレインが AIX の欄を空にしたまま、turn_contract で「お部屋をピックアップしてお送りする」約束（route=promise）を言った番。
 *   探す条件の話（about=search_condition）か送った物件への反応（reaction_to_sent）の依頼で、約束の中身が探す・送る（見積・確認でない）時だけ。
 *   brain-core はこの時、2段（ピックアップの約束の返信→後で物件の AIX）に乗せる＝ブレインの約束を道に通す（語の網ではなくブレインの route と about で決める）。
 *   戻す: BRAIN_PROMISE_PICKUP=off
 */
export function brainContractPromisesPickup(raw: unknown, env: Env = process.env): boolean {
  if ((env.BRAIN_PROMISE_PICKUP ?? "").trim().toLowerCase() === "off") return false;
  const asks = raw && typeof raw === "object" && Array.isArray((raw as { asks?: unknown }).asks) ? (raw as { asks: Array<Record<string, unknown>> }).asks : [];
  return asks.some((a) => a?.route === "promise" && (a?.about === "search_condition" || a?.about === "reaction_to_sent")
    && /ピックアップ|探し|探す|(?:お部屋|物件)[^。\n]{0,12}(?:お送り|送り|送る|ご紹介)/.test(String(a?.answer ?? ""))
    // 10/15 確かめる人: 資料・図面・写真・動画・間取・見積・確認の約束は物件の AIX にしない（「物件資料をお送りします」が網に掛かっていた）
    && !/見積|確認|資料|図面|写真|画像|動画|間取/.test(String(a?.answer ?? "")));
}

/**
 * 2026-10-13 棚卸しの表 2（作る人・2段の約束をブレイン基準に）:
 *   ブレインが同じ出力の turn_contract で「この番は約束をしない」（約束の項目も AIX の項目も無く、閉じる番 close_only か、答える・触れないだけ）と
 *   言っている時、2段の規則（物件・確認・見積の AIX → 約束の返信）は上書きしない（食い違いは demoted_overrides に記録）。
 *   ⚠ 本番の digest.tc は reconcileTurnContractWithAix（規則で AIX が外れたら aix の項目を promise に直す）の後の値＝「ブレインも約束と言った」に見える。
 *     reconcile は aix→promise しか変えないので、記録の tc に約束も AIX も無い番は LLM の生の答えでも約束が無い（確かな食い違い）。
 *   数え（60日・2段の番 115・出し切りを除く 74・YUMA 除く・scripts/audit-two-stage-vs-takeuchi.ts）: 約束も AIX も無い番 7 → 12時間の内に約束の返信を送ったスタッフ 0
 *     （竹内さんの AIX 1・締めの返信 1・申込のフォーム 1・何もしない 4）＝ブレイン正 7・規則正 0。約束と言った番（記録で p>0）は竹内さんの手打ち 9 が約束・答えの返信。
 *   対象の種類: pickup・pickup_unless_ack・check・check_question・brought_both・estimate（竹内さんの決め打ちの言い回し work_support・viewing_check・room_photo_shoot は対象外）。
 *   戻す: TWO_STAGE_BRAIN_NO_PROMISE=off（この形だけ）／BRAIN_DEMOTE_TWO_STAGE=off（2段の下げ全部）
 */
export function brainContractRejectsPromise(raw: unknown, env: Env = process.env): { reject: boolean; close: boolean } {
  if ((env.TWO_STAGE_BRAIN_NO_PROMISE ?? "").trim().toLowerCase() === "off") return { reject: false, close: false };
  if (!raw || typeof raw !== "object") return { reject: false, close: false };
  const r = raw as { asks?: unknown; close_only?: unknown };
  const close = r.close_only === true || r.close_only === "true";
  const asks = Array.isArray(r.asks) ? (r.asks as Array<Record<string, unknown>>) : [];
  if (!asks.length && !close) return { reject: false, close: false }; // 中身の無い本質は判断に使わない（安全側＝今まで通り約束）
  if (asks.some((a) => a?.route === "promise" || a?.route === "aix")) return { reject: false, close };
  // 本番の確かな食い違い 7番は全部 閉じる番（close_only）。閉じない「答えるだけ」の番は本番の例が無い＝既定は下げない（TWO_STAGE_BRAIN_NO_PROMISE_REPLY=on で試せる）
  if (!close && (env.TWO_STAGE_BRAIN_NO_PROMISE_REPLY ?? "").trim().toLowerCase() !== "on") return { reject: false, close };
  return { reject: true, close };
}
const NO_PROMISE_KINDS_RE = /^rule:two_stage_promise\((?:pickup|pickup_unless_ack|check|check_question|brought_both|brought_estimate|estimate|estimate_stale)\)$/;
/** 2段の source がブレインの「約束しない」で下げてよい種類か */
export function twoStageSourceDemotable(source: string | null | undefined): boolean {
  return NO_PROMISE_KINDS_RE.test(String(source ?? ""));
}
/** 生の turn_contract の道ごとの数（reconcile の前・digest.ltc）。例 "2:r0p1a1n0:c" */
export function rawContractRouteDigest(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { asks?: unknown }).asks)) return null;
  const asks = (raw as { asks: Array<Record<string, unknown>> }).asks;
  const n = (k: string) => asks.filter((a) => a?.route === k).length;
  const c = (raw as { close_only?: unknown }).close_only;
  return `${asks.length}:r${n("reply")}p${n("promise")}a${n("aix")}n${n("none")}${c === true || c === "true" ? ":c" : ""}`;
}

// ─── 4-4: 締めの後のお礼・了承だけ（rule:closed_ack_wait）────────────────────────────
// 旧: こちらが締め（「何時でもお気軽にご連絡ください」）を送った後のお礼・了承だけの番は、ブレインの判断に関わらず AIX【物件ピックアップした】＋下書きなし（30日 18番・押された AIX と同じ 0）。
// 新: 材料の行（締めの後のお礼だけ・実データ）を LLM の前に渡し、ブレインが「返信しない（aix null・reply_mode=aix）／次の物件の AIX／返信」を決める。戻す BRAIN_DEMOTE_CLOSED_ACK=off
export function closedAckMaterialLine(staffLine: string): string {
  const q = Array.from(String(staffLine ?? "").replace(/\s+/g, " ")).slice(0, 40).join("");
  return `【こちらの締めの後のお礼・了承だけ（材料）】こちらの最後の送信は締め（「${q}」）で、お客様の今の発言はお礼・了承だけ。実データ（8月〜10件）: スタッフは返信しなかった 8（うち4件は後で次の物件を AIX で送った）・新しい内容の返信 2。同じ締めを繰り返す返信は書かない。物件を送っている提案中なら次の一手は次の物件（AIX【物件ピックアップした】・後で）`;
}

// ─── 4-5: 内覧当日の送り出しの後のお礼だけ（rule:viewing_day_ack）──────────────────────
// 旧: 内覧当日にこちらが送り出した（お気をつけてお越しください）後のお礼だけの番は、ブレインの判断に関わらず AIX【挨拶（内覧後）】＋下書きなし（30日 12番・押された AIX と同じ 0）。
// 新: 材料の1行を LLM の前に渡し、ブレインが決める。戻す BRAIN_DEMOTE_VIEWING_DAY_ACK=off
export function viewingDayAckMaterialLine(staffLine: string): string {
  const q = Array.from(String(staffLine ?? "").replace(/\s+/g, " ")).slice(0, 40).join("");
  return `【内覧当日の送り出しの後のお礼だけ（材料）】今日は内覧の日で、こちらの最後の送信は送り出し（「${q}」）、お客様の今の発言はお礼・了承だけ。実データ（180日）: この場面でスタッフは返信せず、内覧が終わってから「本日お時間頂きありがとうございました」（AIX【挨拶→内覧後】・60件）を送っている。同じ送り出しを繰り返す返信は書かない`;
}
