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

export type OverrideFamily = "signal" | "signal_decided" | "image_only" | "two_stage_promise" | "closed_ack_wait" | "viewing_day_ack" | "turn_route_guards" | "search_exhausted";

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
  turn_route_guards: true,
  // 10/13 試験の出し切り7問で下げると道 7→5（試験の正解は送付だけの印の後でも全力サポート）＝今は上書きのまま。材料を強くしてから下げる（search-exhausted.weakExhaustDemoted）
  search_exhausted: false,
};

export function overrideDemoted(f: OverrideFamily, env: Env = process.env): boolean {
  const v = (env[DEMOTE_ENV[f]] ?? "").trim().toLowerCase();
  if (v === "off") return false;
  if (v === "on") return true;
  return DEFAULT_ON[f];
}

export type DemotedOverride = { family: OverrideFamily; src: string; would: string | null; brain: string | null };

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
  if (!overrideDemoted(family, env)) return true;
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

/** プロンプトに入れる材料の行（物件の AIX を直接出せるか） */
export function pickupReadyMaterialLine(ready: boolean): string {
  return ready
    ? "【送れる物件の候補（材料）】売上サポに今送れる新しい物件の候補がある＝物件の AIX（物件ピックアップした・1件特にオススメ）を直接出せる。ただし今のお客様の発言が条件の言い直し・質問・ご事情なら、先に答えてピックアップの約束（turn_contract の該当の route は promise）でもよい。どちらかを aix と turn_contract で同じに書く"
    : "【送れる物件の候補（材料）】売上サポに今送れる新しい物件の候補は無い＝物件の AIX を選ぶ番でも、まずピックアップしてお送りする約束の返信（turn_contract の該当の route は promise・aix は物件の AIX のままでよい＝約束の後で AIX）";
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
const NO_PROMISE_KINDS_RE = /^rule:two_stage_promise\((?:pickup|pickup_unless_ack|check|check_question|brought_both|estimate)\)$/;
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
