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

export type OverrideFamily = "signal" | "signal_decided" | "image_only" | "two_stage_promise" | "closed_ack_wait" | "viewing_day_ack" | "turn_route_guards";

/** 家族ごとの戻す環境変数（"off" で旧の上書きに戻す） */
export const DEMOTE_ENV: Record<OverrideFamily, string> = {
  signal: "BRAIN_DEMOTE_SIGNAL",
  signal_decided: "BRAIN_DEMOTE_SIGNAL_DECIDED",
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
  image_only: true,
  two_stage_promise: true,
  closed_ack_wait: true,
  viewing_day_ack: true,
  turn_route_guards: true,
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
