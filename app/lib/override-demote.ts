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

export type OverrideFamily = "signal" | "signal_decided" | "search_exhausted" | "image_only" | "two_stage_promise" | "closed_ack_wait" | "viewing_day_ack" | "turn_route_guards";

/** 家族ごとの戻す環境変数（"off" で旧の上書きに戻す） */
export const DEMOTE_ENV: Record<OverrideFamily, string> = {
  signal: "BRAIN_DEMOTE_SIGNAL",
  signal_decided: "BRAIN_DEMOTE_SIGNAL_DECIDED",
  search_exhausted: "BRAIN_DEMOTE_SEARCH_EXHAUSTED",
  image_only: "BRAIN_DEMOTE_IMAGE_ONLY",
  two_stage_promise: "BRAIN_DEMOTE_TWO_STAGE",
  closed_ack_wait: "BRAIN_DEMOTE_CLOSED_ACK",
  viewing_day_ack: "BRAIN_DEMOTE_VIEWING_DAY_ACK",
  turn_route_guards: "BRAIN_DEMOTE_TURN_GUARDS",
};

/** 下げた家族（既定は下げる＝on。家族を足す時はここで既定を決める） */
const DEFAULT_ON: Record<OverrideFamily, boolean> = {
  signal: true,
  // 竹内さんの決定で入れた場面の信号（室内写真 S11・内覧の流れの段階）。10/13 の試験で下げると q017（室内写真→返信）・q045（内覧の希望→全力サポート）の道が外れた
  //   ＝ブレインの材料（場面の証拠・内覧の流れの行）だけではまだ届かない → 今は上書きのまま（食い違いのログも出ない）。材料を強くしてから下げる
  signal_decided: false,
  // 竹内さんの決定（10/13）の見本の確かめ: 出し切りの書き換え（search-exhausted）は既に「お礼・了承だけの番は外す＋送れる候補が無い＋お客様の返信の番で、ブレインが物件を
  //   もっと出す（物件の AIX／探す約束）と読んだ＝刺さらなかった」の時だけ。下げると q001・q002・q006・q007（竹内さんは新着待ち）がピックアップの約束になった（10/13 試験）
  //   → 書き換えは残す。直すのはお礼の番に全力サポートを2つ目に並べていた所（search-result-choice ackOnly）＋材料の行
  search_exhausted: false,
  image_only: true,
  two_stage_promise: true,
  closed_ack_wait: true,
  viewing_day_ack: true,
  // 4-6（10/13 試験）: ブレイン自身の AIX（llm）への関所を下げると q052（決まった内覧の後のオンライン内見の了承→待ち合わせ）・q072（〇日以降の事情→内覧調整）の道が外れた
  //   ＝この関所はブレイン自身の読み違いも正している → 今は上書きのまま（BRAIN_DEMOTE_TURN_GUARDS=on で下げる）。材料（今の番は内覧を頼んでいない等）を足してから下げる
  turn_route_guards: false,
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

// ─── 竹内さんの決定（10/13・feedback_zenryoku_support_timing）: AIX【全力サポート】の出し時 ─────────────────
// 旧（search-exhausted）: 出し切りの印（全部ピックアップ・新着待ちの約束・物件の AIX の送付）があれば、ブレインが物件の AIX を選んでも主を【全力サポート】に書き換えた。
// 新: 出し切りの印だけで全力サポートを主にしない。全力サポートは「お客様から返信が来た＋送った物件が刺さらなかった（反応が薄い・断り）＋送れる物件が無い」がそろった時に、
//   約束して固める（次に物件が見つかったら決める）。お礼・了承（よろしくお願いします）の番はまず返信で完了→次の一手は物件ピックアップ（複数の時）か物件オススメ（1件の時）。
//   これはブレインが決める（材料の行を LLM の前に渡す・後の書き換えはしない＝ログに残す）。戻す BRAIN_DEMOTE_SEARCH_EXHAUSTED=off（旧の書き換え）
export function zenryokuTimingMaterialLine(i: { exhausted: boolean; markerAt: string | null; ackOnly: boolean; pickupReady: boolean | null }): string {
  const head = "【全力サポートの出し時（材料・竹内さんの決まり 10/13）】AIX【全力サポート】は、お客様から返信が来て、送った物件が刺さらなかった（反応が薄い・見送り・断り）上で、送れる物件が無い時に、約束して固める（次に物件が見つかったら決める）。出し切りの印だけでは主にしない。";
  const ack = i.ackOnly ? "今の発言はお礼・了承だけ＝まず返信で完了させ（下書きを出す）、次の一手は物件ピックアップ（送れる物件が複数）か物件オススメ（1件）。全力サポートにしない。" : "";
  const ex = i.exhausted
    ? `この会話は今の条件の物件を一度出し切っている（${i.markerAt ? `印 ${i.markerAt.slice(0, 10)}` : "印あり"}）。${i.pickupReady === true ? "売上サポに送れる新しい候補がある＝物件の AIX。" : "送れる新しい候補は無い。"}`
    : "";
  return `${head}${ex}${ack}`;
}
/** 全力サポートの出し時の材料の行（既定 on・ZENRYOKU_TIMING_MATERIAL=off で止める） */
export function zenryokuMaterialEnabled(env: Env = process.env): boolean {
  return (env.ZENRYOKU_TIMING_MATERIAL ?? "").trim().toLowerCase() !== "off";
}
