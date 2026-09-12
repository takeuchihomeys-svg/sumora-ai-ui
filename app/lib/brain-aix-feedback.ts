// app/lib/brain-aix-feedback.ts
// 2026-09-12 竹内方針「AIX のセットはブレインが判断する」統合設計 段2:
//   スタッフが実際に押した AIX（aix_usage_logs）を、ブレインの判断（brain_decision_logs）と1件ずつ対にし、
//   ブレインが「自分の判断はどれだけ押されたか・代わりに何が押されたか」を事実として読めるようにする。
//   ここは純関数だけ（supabase を読み込まない）。DB の読み書きは cron/brain-aix-eval と brain-core が持つ。
//   ・trigger_action_rules は使わない（category トリガーで keyword_rule に混ざるため）。書き先は brain_aix_feedback。
//   ・場面（S1〜S7）は「証拠」。ここでも AIX を決めない（ブレインへの実績欄とLLMが null の時の信号だけに使う）。
import { detectAixSceneEvidence, type AixSceneEvidence } from "./aix-scene-evidence";
import { detectPropertyCheckPattern, propertyCheckKindFor, type PropertyCheckKind } from "./aix-taxonomy";

/** 対にする窓（次の判断が来なければ24時間まで） */
export const PAIR_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 30分以内の連続押しは1件にまとめる */
export const PRESS_COLLAPSE_MS = 30 * 60 * 1000;
/** 集計を upsert する最小件数 */
export const FEEDBACK_MIN_N = 10;

/** acknowledge_check は property_check_result と同じ扱い（管理会社宛ての確認はログに残らないため） */
export function normalizeAixForMatch(a: string | null | undefined): string {
  const s = (a ?? "").trim();
  return s === "acknowledge_check" ? "property_check_result" : s;
}

export type BrainDecisionRow = {
  id: string;
  conversation_id: string;
  created_at: string;
  suggested_action: string | null;
  suggested_check_pattern?: string | null;
  decision_source?: string | null;
  scene_evidence?: string | null;
};
export type AixPressRow = {
  conversation_id: string;
  aix_type: string | null;
  check_pattern?: string | null;
  created_at: string;
};
export type PairedDecision = {
  decision: BrainDecisionRow;
  /** 窓の中で最初に押された AIX（まとめた後）。押されていなければ null */
  press: AixPressRow | null;
  /** 窓がまだ閉じていない（次の判断も無く24時間も経っていない）かつ押されていない＝判定保留 */
  pending: boolean;
  /** action あり: 押された AIX が一致 / action なし: 何も押されなかった。pending は null */
  matched: boolean | null;
};

const ms = (iso: string) => new Date(iso).getTime();

/** 30分以内の連続押し（同じ会話）を1件にまとめる。入力の順序は問わない。出力は古い順 */
export function collapsePresses(presses: ReadonlyArray<AixPressRow>): AixPressRow[] {
  const byConv = new Map<string, AixPressRow[]>();
  for (const p of presses) {
    if (!p.aix_type) continue;
    const arr = byConv.get(p.conversation_id) ?? [];
    arr.push(p);
    byConv.set(p.conversation_id, arr);
  }
  const out: AixPressRow[] = [];
  for (const arr of byConv.values()) {
    arr.sort((a, b) => ms(a.created_at) - ms(b.created_at));
    let lastKept: AixPressRow | null = null;
    let lastAt = -Infinity;
    for (const p of arr) {
      const t = ms(p.created_at);
      if (lastKept && t - lastAt <= PRESS_COLLAPSE_MS) { lastAt = t; continue; }
      out.push(p);
      lastKept = p;
      lastAt = t;
    }
  }
  return out.sort((a, b) => ms(a.created_at) - ms(b.created_at));
}

/**
 * 各判断を「次の判断または24時間まで」に最初に押された AIX と対にする。
 * @param nowMs 窓が閉じたかの判定に使う現在時刻（テスト用に注入）
 */
export function pairBrainDecisions(
  decisions: ReadonlyArray<BrainDecisionRow>,
  presses: ReadonlyArray<AixPressRow>,
  nowMs: number = Date.now(),
): PairedDecision[] {
  const collapsed = collapsePresses(presses);
  const pressByConv = new Map<string, AixPressRow[]>();
  for (const p of collapsed) {
    const arr = pressByConv.get(p.conversation_id) ?? [];
    arr.push(p);
    pressByConv.set(p.conversation_id, arr);
  }
  const decByConv = new Map<string, BrainDecisionRow[]>();
  for (const d of decisions) {
    const arr = decByConv.get(d.conversation_id) ?? [];
    arr.push(d);
    decByConv.set(d.conversation_id, arr);
  }
  const out: PairedDecision[] = [];
  for (const [conv, decs] of decByConv) {
    decs.sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const ps = pressByConv.get(conv) ?? [];
    decs.forEach((d, i) => {
      const start = ms(d.created_at);
      const next = decs[i + 1] ? ms(decs[i + 1].created_at) : Infinity;
      const end = Math.min(next, start + PAIR_WINDOW_MS);
      const press = ps.find((p) => { const t = ms(p.created_at); return t >= start && t < end; }) ?? null;
      const windowClosed = end <= nowMs;
      const action = normalizeAixForMatch(d.suggested_action);
      if (!press && !windowClosed) { out.push({ decision: d, press: null, pending: true, matched: null }); return; }
      const matched = action
        ? !!press && normalizeAixForMatch(press.aix_type) === action
        : !press;
      out.push({ decision: d, press, pending: false, matched });
    });
  }
  return out;
}

export type FeedbackRow = {
  key: string;
  kind: "action" | "action_cp" | "decision_source" | "scene_staff";
  action: string | null;
  check_pattern: string | null;
  scene: string | null;
  decision_source: string | null;
  /** 判定済みの判断の数（scene_staff は押された数） */
  n: number;
  /** 窓の中でスタッフが何かの AIX を押した判断の数（一致率の分母。押されずテキストで返した判断は含めない） */
  pressed: number;
  matched: number;
  alt_top: Array<{ aix: string; n: number }>;
  window_days: number;
};

type Acc = { n: number; pressed: number; matched: number; alt: Map<string, number> };
const newAcc = (): Acc => ({ n: 0, pressed: 0, matched: 0, alt: new Map() });
const topAlt = (m: Map<string, number>, k = 3) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([aix, n]) => ({ aix, n }));

/** 押す直前の場面ごとのスタッフの押し方（scene_staff 用の入力） */
export type ScenePress = { scene: string; candidateAction: string; aix: string };

/** 対と場面別の押し方から brain_aix_feedback の行を作る（n >= minN だけ） */
export function aggregateBrainAixFeedback(
  pairs: ReadonlyArray<PairedDecision>,
  scenePresses: ReadonlyArray<ScenePress>,
  windowDays: number,
  minN: number = FEEDBACK_MIN_N,
): FeedbackRow[] {
  const byAction = new Map<string, Acc>();
  const byActionCp = new Map<string, Acc>();
  const bySource = new Map<string, Acc>();
  const bump = (m: Map<string, Acc>, key: string, p: PairedDecision) => {
    const a = m.get(key) ?? newAcc();
    a.n++;
    if (p.press) a.pressed++;
    if (p.matched) a.matched++;
    else if (p.press?.aix_type) {
      const alt = normalizeAixForMatch(p.press.aix_type);
      a.alt.set(alt, (a.alt.get(alt) ?? 0) + 1);
    }
    m.set(key, a);
  };
  for (const p of pairs) {
    if (p.pending) continue;
    const action = normalizeAixForMatch(p.decision.suggested_action) || "none";
    bump(byAction, action, p);
    const cp = p.decision.suggested_check_pattern ?? null;
    if (action !== "none" && cp) bump(byActionCp, `${action}|${cp}`, p);
    if (p.decision.decision_source) bump(bySource, p.decision.decision_source, p);
  }
  const rows: FeedbackRow[] = [];
  for (const [action, a] of byAction) {
    if (a.n < minN) continue;
    rows.push({ key: `action:${action}`, kind: "action", action, check_pattern: null, scene: null, decision_source: null, n: a.n, pressed: a.pressed, matched: a.matched, alt_top: topAlt(a.alt), window_days: windowDays });
  }
  for (const [k, a] of byActionCp) {
    if (a.n < minN) continue;
    const [action, cp] = k.split("|");
    rows.push({ key: `action_cp:${k}`, kind: "action_cp", action, check_pattern: cp, scene: null, decision_source: null, n: a.n, pressed: a.pressed, matched: a.matched, alt_top: topAlt(a.alt), window_days: windowDays });
  }
  for (const [ds, a] of bySource) {
    if (a.n < minN) continue;
    rows.push({ key: `decision_source:${ds}`, kind: "decision_source", action: null, check_pattern: null, scene: null, decision_source: ds, n: a.n, pressed: a.pressed, matched: a.matched, alt_top: topAlt(a.alt), window_days: windowDays });
  }
  const byScene = new Map<string, Acc & { candidate: string }>();
  for (const s of scenePresses) {
    const a = byScene.get(s.scene) ?? { ...newAcc(), candidate: s.candidateAction };
    a.n++;
    a.pressed++;
    const aix = normalizeAixForMatch(s.aix);
    if (aix === normalizeAixForMatch(s.candidateAction)) a.matched++;
    a.alt.set(aix, (a.alt.get(aix) ?? 0) + 1);
    byScene.set(s.scene, a);
  }
  for (const [scene, a] of byScene) {
    if (a.n < minN) continue;
    // scene_staff の alt_top は「その場面でスタッフが押した AIX の分布（上位）」。matched は場面の候補と同じ AIX が押された件数
    rows.push({ key: `scene_staff:${scene}`, kind: "scene_staff", action: a.candidate, check_pattern: null, scene, decision_source: null, n: a.n, pressed: a.pressed, matched: a.matched, alt_top: topAlt(a.alt, 4), window_days: windowDays });
  }
  return rows;
}

// ─── ブレインの入力（今回の顧客発言の場面の証拠） ───────────────────────────

type MsgLite = { sender: string; text: string | null; created_at?: string };

/**
 * 最後のスタッフ発言より後の顧客発言（未返信の連投全体）を古い順に返す。
 * @param newestFirst 新しい順のメッセージ
 */
export function unrepliedCustomerTurn(newestFirst: ReadonlyArray<MsgLite>): { text: string; hasImage: boolean } {
  const block: string[] = [];
  let hasImage = false;
  for (const m of newestFirst) {
    if (m.sender !== "customer") break;
    const t = (m.text ?? "").trim();
    if (/^\[画像\]/.test(t)) { hasImage = true; continue; }
    if (/^\[動画\]/.test(t) || !t) continue;
    block.push(t);
  }
  return { text: block.reverse().join("\n"), hasImage };
}

/**
 * スタッフが AIX を押す直前の顧客発言（押す直前にスタッフのテキストが挟まっていても、その前の顧客の連投を拾う）。
 * 押す時刻より前・48時間以内の顧客の連投だけを見る。
 */
export function customerTurnBeforePress(newestFirstBeforePress: ReadonlyArray<MsgLite>, pressAtMs: number): { text: string; hasImage: boolean } {
  let i = 0;
  while (i < newestFirstBeforePress.length && newestFirstBeforePress[i].sender !== "customer") i++;
  const first = newestFirstBeforePress[i];
  if (!first || (first.created_at && pressAtMs - ms(first.created_at) > 48 * 60 * 60 * 1000)) return { text: "", hasImage: false };
  return unrepliedCustomerTurn(newestFirstBeforePress.slice(i));
}

/**
 * LLM の aix が null の時だけ使う「場面の証拠による信号」。S2（入居日）/ S3（審査）/ S5（日時指定）だけ。
 * 決定ではなく信号（decision_source='signal:scene_*' を付けて brain-aix-eval の学習対象にする）。
 * S1（空室）・S4（内覧）・S6（見積）・S7（条件変更）はテキスト返信での誤発火が多いので信号にしない（段2 設計・S1 は127件中51件）。
 */
export function sceneSignalFallback(e: AixSceneEvidence | null | undefined): { action: string; checkPattern: string | null; decisionSource: string } | null {
  if (!e) return null;
  if (e.scene === "S2_move_in" || e.scene === "S3_screening") {
    return { action: "property_check_result", checkPattern: e.checkPattern, decisionSource: `signal:scene_${e.scene.slice(0, 2)}` };
  }
  if (e.scene === "S5_time_spec") return { action: "meeting_place", checkPattern: null, decisionSource: "signal:scene_S5" };
  return null;
}

/**
 * ブレインの check_pattern の出どころ（finalAix=property_check_result の時だけ）。
 *   1) 場面の信号（S2/S3）で決まった時はその check_pattern
 *   2) 今回の顧客発言の場面の証拠が S2/S3 で check_pattern を持つ時はそれ
 *   3) それ以外は detectPropertyCheckPattern を **未返信の顧客発言だけ** に当てる
 *      （旧: 直近8件・スタッフ文込み。メッセージ単位の判定に会話全体を使わない原則に合わせる）
 */
export function resolveBrainCheckPattern(
  finalAix: string | null,
  evidence: AixSceneEvidence | null | undefined,
  sceneSignalCheckPattern: string | null,
  unrepliedCustomerText: string,
): PropertyCheckKind | null {
  if (finalAix !== "property_check_result") return null;
  if (sceneSignalCheckPattern) return propertyCheckKindFor(sceneSignalCheckPattern);
  if (evidence && (evidence.scene === "S2_move_in" || evidence.scene === "S3_screening") && evidence.checkPattern) {
    return propertyCheckKindFor(evidence.checkPattern);
  }
  return detectPropertyCheckPattern(unrepliedCustomerText);
}

/**
 * ブレインの降格ゲートが読む一致率（brain_aix_feedback kind=action）。行が無い時は null（フェイルオープン）。
 * 分母は「スタッフが何かの AIX を押した判断」（pressed）。押されずテキストで返した判断を不一致に数えると
 * どの action も一致率が1割前後になり、required がほぼ全部降格してしまうため（2026-09-12 基準: action あり 27/190・押された中では 27/56）。
 * acknowledge_check は property_check_result と同じ行を読む。
 */
export function feedbackGateRate(
  rows: ReadonlyArray<Pick<FeedbackRow, "kind" | "action" | "pressed" | "matched">>,
  action: string,
): { n: number; rate: number } | null {
  const a = normalizeAixForMatch(action);
  const r = rows.find((x) => x.kind === "action" && x.action === a);
  if (!r || !r.pressed) return null;
  return { n: r.pressed, rate: r.matched / r.pressed };
}

/** meta / brain_decision_logs に残す場面の証拠（小さく） */
export function compactSceneEvidence(e: AixSceneEvidence | null | undefined) {
  if (!e) return null;
  return { scene: e.scene, candidate: e.candidateAction, check_pattern: e.checkPattern, reason: e.reasonCode, property_by: e.propertySpecifiedBy };
}

const SCENE_LABEL: Record<string, string> = {
  S1_vacancy: "空室・募集状況の質問", S2_move_in: "入居日の質問", S3_screening: "審査・保証の質問", S4_viewing: "内覧の希望",
  S5_time_spec: "内覧日時の指定", S6_estimate: "見積・費用", S7_condition_change: "条件の変更", S8_cost_doubt: "費用の安さへの不安・疑問", application: "申込",
};

/**
 * ブレインのプロンプトに入れる「証拠」と「実績」の欄。規則としては書かない（AIX を決めるのはブレイン）。
 * @param feedback brain_aix_feedback の行（kind=scene_staff / action）
 */
export function buildSceneEvidencePromptText(
  e: AixSceneEvidence | null,
  feedback: ReadonlyArray<Pick<FeedbackRow, "kind" | "action" | "scene" | "n" | "pressed" | "matched" | "alt_top">>,
): string {
  const lines: string[] = [];
  if (e) {
    const cp = e.checkPattern ? `（check_pattern 候補: ${e.checkPattern}）` : "";
    const by = e.propertySpecifiedBy ? `／物件を特定した根拠: ${e.propertySpecifiedBy}` : "";
    lines.push(`\n【今回の顧客発言の場面（決定論の証拠。AIX を決めるのはあなた）】${SCENE_LABEL[e.scene] ?? e.scene}／候補の AIX: ${e.candidateAction}${cp}${by}`);
    const sc = feedback.find((f) => f.kind === "scene_staff" && f.scene === e.scene);
    if (sc && sc.alt_top.length > 0) {
      lines.push(`【この場面でスタッフが実際に押した AIX の実績（事実・直近${sc.n}件）】${sc.alt_top.map((a) => `${a.aix} ${a.n}件`).join("・")}`);
    }
  }
  const actionRows = feedback.filter((f) => f.kind === "action" && f.action && f.action !== "none" && f.alt_top.length > 0).slice(0, 4);
  if (actionRows.length > 0) {
    lines.push(`【あなたの過去の AIX 判断と、スタッフが代わりに押した AIX（事実）】${actionRows.map((f) => `${f.action}→AIX が押された${f.pressed}件中 同じ AIX ${f.matched}件（代わりに ${f.alt_top.slice(0, 2).map((a) => `${a.aix} ${a.n}件`).join("・")}）`).join("／")}`);
  }
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n※上は証拠と実績。今回の会話の実態に合わない時は従わなくてよい。`;
}

/** 押す直前の顧客発言から場面の証拠を出す（cron で scene_staff を作る時と brain-core で同じ関数） */
export function sceneEvidenceForTurn(turn: { text: string; hasImage: boolean }, o: { sentPropertyCount: number; aixHistory?: ReadonlyArray<{ aix_type?: string | null; check_pattern?: string | null }>; recentMessages?: ReadonlyArray<{ sender: string; text?: string | null }>; moveOutScheduled?: boolean }): AixSceneEvidence | null {
  return detectAixSceneEvidence({
    latestCustomerTurn: turn.text,
    hasCustomerImage: turn.hasImage,
    sentPropertyCount: o.sentPropertyCount,
    aixHistory: o.aixHistory,
    recentMessages: o.recentMessages,
    propertyStatus: o.moveOutScheduled ? "move_out_scheduled" : "unknown",
  });
}
