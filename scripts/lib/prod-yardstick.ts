// scripts/lib/prod-yardstick.ts — 本番の記録を毎晩の物差しにする（ブレインの答え×竹内さんの最初の一手・LLM なし）。純関数だけ
//
// 2026-11-05 作業員8（竹内さんの了承の 2「本番の記録を毎晩の物差しにする（LLM なし・下がった場面だけ試験）」）:
//   audit-prod-as-exam.ts（つなぎの芯・11/04）が数える「番ごとの当たり（ブレインの道の系統＝竹内さんの最初の一手の系統）」を、
//   ①前の窓と今の窓（例: 直す前の7日／直した後）で場面ごとに比べ、はっきり下がった場面だけを出す（数が少ない場面は「待つ」）
//   ②下がった場面の試験の問題だけを流す（場面 → 問題の対応は呼ぶ側が渡す）
//   を決める。本番は brain_version ごとの番が 1〜11番と少ない（11/04）ので、版ごとではなく窓で比べる。
//   竹内さんの決定（KB P1・11/05「竹内さんの送り方は基準・絶対の正解ではない」）: 竹内さんと違っても、原則で見て良い番（答える・信頼・訴求の抜けが0）は
//   外れに数えず「超えた候補」に並べる（竹内さんの承認の後に正解へ）。原則の見方は呼ぶ側が principleOk で渡す（無ければ普通の外れ）。
//   KB: a62a4164③（本番の記録を試験に）・2acd77de（竹内さんの番）・e9d2303e（決定論を先に）

export type YardTurn = {
  scene: string | null;
  /** ブレインの道の系統（返信／確認／見積／物件／内覧…）＝ audit-prod-as-exam の aixFamily */
  brain: string;
  /** 竹内さん（か書き手）の最初の一手の系統 */
  staff: string;
  writer: string;
  /** 原則の揃い方（答える・信頼・訴求の抜けが0）。true＝竹内さんと違っても良い番の候補 */
  principleOk?: boolean | null;
  at: string;
};
export type SceneCount = { n: number; hit: number; beyond: number; miss: number };

/** 1番の扱い: 当たり／超えた候補／外れ */
export function judgeTurn(t: YardTurn): "hit" | "beyond" | "miss" {
  if (t.brain === t.staff) return "hit";
  return t.principleOk === true ? "beyond" : "miss";
}

/** 場面ごとの数え（writer を絞る時は writers に入れる・既定は竹内さん本人＝KB 41dadfe6「基準は竹内さんの番だけ」） */
export function countByScene(turns: YardTurn[], opts: { writers?: string[] } = {}): Map<string, SceneCount> {
  const ws = new Set(opts.writers ?? ["takeuchi"]);
  const m = new Map<string, SceneCount>();
  for (const t of turns) {
    if (!ws.has(t.writer)) continue;
    const k = t.scene ?? "（場面なし）";
    const v = m.get(k) ?? { n: 0, hit: 0, beyond: 0, miss: 0 };
    v.n++; v[judgeTurn(t)]++;
    m.set(k, v);
  }
  return m;
}

/** Wilson の幅（95%）。率は「当たり＋超えた候補」を良い番として数える */
export function wilson(good: number, n: number, z = 1.96): { lo: number; hi: number; p: number } {
  if (n <= 0) return { lo: 0, hi: 1, p: 0 };
  const p = good / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - w) / d), hi: Math.min(1, (c + w) / d), p };
}

export type SceneDrift = { scene: string; before: SceneCount; after: SceneCount; pBefore: number; pAfter: number; verdict: "down" | "up" | "same" | "few" };

/**
 * 前の窓と今の窓の場面ごとの比べ。はっきり下がった＝今の上の幅が前の下の幅より下（幅が重ならない）。
 *   minN（既定 5）未満の場面は few（待つ・竹内さんに聞く。従業員の番で埋めない）。
 */
export function sceneDrift(before: Map<string, SceneCount>, after: Map<string, SceneCount>, opts: { minN?: number } = {}): SceneDrift[] {
  const minN = opts.minN ?? 5;
  const out: SceneDrift[] = [];
  const empty: SceneCount = { n: 0, hit: 0, beyond: 0, miss: 0 };
  for (const s of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(s) ?? empty, a = after.get(s) ?? empty;
    const wb = wilson(b.hit + b.beyond, b.n), wa = wilson(a.hit + a.beyond, a.n);
    let verdict: SceneDrift["verdict"] = "same";
    if (b.n < minN || a.n < minN) verdict = "few";
    else if (wa.hi < wb.lo) verdict = "down";
    else if (wa.lo > wb.hi) verdict = "up";
    out.push({ scene: s, before: b, after: a, pBefore: wb.p, pAfter: wa.p, verdict });
  }
  return out.sort((x, y) => (x.verdict === "down" ? -1 : 0) - (y.verdict === "down" ? -1 : 0) || y.after.n - x.after.n);
}

/** 下がった場面の問題だけ（場面 → 問題の id は呼ぶ側が渡す）。回帰の必須（mustIds）は必ず足す */
export function problemsForDrift(drift: SceneDrift[], problemsByScene: Map<string, string[]>, mustIds: string[] = []): string[] {
  const ids = new Set(mustIds);
  for (const d of drift) if (d.verdict === "down") for (const id of problemsByScene.get(d.scene) ?? []) ids.add(id);
  return [...ids];
}

/**
 * 割れの表（統括役 11/05 了承）: 同じ番で、本番の Claude の答え（brain_decision_logs の道の系統）と試験の DeepSeek の答え（同じ番から作った問題の答案）が
 *   同じ系統か。場面ごとの一致率。一致率が低い場面は、DeepSeek の試験の悪化0を本番の Claude で信じきれない＝claudeCheckPlan の (c) に渡す。LLM なし
 */
export function modelSplitTable(pairs: Array<{ scene: string | null; claude: string; deepseek: string }>): Map<string, { n: number; agree: number; rate: number }> {
  const m = new Map<string, { n: number; agree: number; rate: number }>();
  for (const p of pairs) {
    const k = p.scene ?? "（場面なし）";
    const v = m.get(k) ?? { n: 0, agree: 0, rate: 0 };
    v.n++; if (p.claude === p.deepseek) v.agree++; v.rate = v.agree / v.n;
    m.set(k, v);
  }
  return m;
}

/** 超えた候補の一覧（竹内さんの承認待ち。承認の後に試験の正解へ） */
export function beyondCandidates(turns: YardTurn[], opts: { writers?: string[] } = {}): YardTurn[] {
  const ws = new Set(opts.writers ?? ["takeuchi"]);
  return turns.filter((t) => ws.has(t.writer) && judgeTurn(t) === "beyond");
}

// ─── 今の通／後の通の2枠（2026-11-12 作業員1・弱い所 268「本番の物差しに2段が残らない」・作業員16 の 11447・12189）──────────────
//   ブレインが2段（今は約束の返信・後で AIX）を選んだ番を、見張りの brain_action（後の AIX）とスタッフの最初の一手（今の返信）で比べると外れに数えていた。
//   逆に、スタッフが今は約束の返信・後で AIX を送った番で、後の AIX を今の番の外れに数えていた（後で送った AIX は 11/07 から外すだけ＝数えから消えていた）。
//   2枠: 今の通（ブレインの今の一手 ↔ スタッフの最初の一手）と後の通（ブレインが約束した後の AIX ↔ スタッフが24時間以内に送った最初の AIX）を別に数える。
//   当たり外れ（場面ごとの率・下がった場面）は今の通で決め、後の通は別の欄（約束を果たしたか）に出す。既定 off（入れる YARDSTICK_TWO_FRAMES=on）。
export function yardstickTwoFramesOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.YARDSTICK_TWO_FRAMES ?? "").trim().toLowerCase() === "on";
}
/** decision_source の2段（rule:two_stage_promise(pickup) 等）の種類 → 後で送る AIX の系統 */
const TWO_STAGE_LATER: Record<string, string> = { pickup: "物件", pickup_unless_ack: "物件", check: "確認", check_question: "確認", brought_both: "確認", brought_estimate: "見積", estimate: "見積", estimate_stale: "見積", photo: "確認", room_photo_shoot: "確認", viewing_check: "内覧", work_support: "サポート" };
export function twoStageKindOf(decisionSource: string | null | undefined): string | null {
  const m = String(decisionSource ?? "").match(/two_stage_promise\(([a-z_]+)\)/);
  return m ? m[1] : null;
}
export type BrainFrames = { now: string; later: string | null };
/** ブレインの2枠: 2段なら 今=返信・後=約束の AIX の系統／それ以外は 今=道の系統・後=なし */
export function brainFrames(brainFamily: string, decisionSource?: string | null): BrainFrames {
  const k = twoStageKindOf(decisionSource);
  if (k) return { now: "返信", later: TWO_STAGE_LATER[k] ?? (brainFamily !== "返信" ? brainFamily : null) };
  return { now: brainFamily, later: null };
}
export type StaffMoveLite = { at: number; family: string };
/** スタッフの2枠: 今=最初の一手の系統／後=最初の一手が返信の時、その後 laterHours 以内に送った最初の AIX の系統 */
/**
 * 2026-11-13 作業員7b（統括役の頼み・竹内さん 11/13「返信と AIX の組み合わせも」）: 最初の一手が返信で、その返信から comboMs（既定 2分）以内に AIX を送った番は、
 *   約束→後で AIX（2段）ではなく、同じ番の組（返信→AIX）＝今の通は AIX の系統（後の通は無し）。条件ヒアリングの初回（挨拶の返信の数秒後にフォーム）が 0/2 の外れに数えられていた。
 *   数えだけ（本番の動きは変わらない）。既定 off（YARDSTICK_COMBO_WINDOW=on）
 */
export function yardstickComboWindowOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.YARDSTICK_COMBO_WINDOW ?? "").trim().toLowerCase() === "on";
}
export function staffFrames(turnAtMs: number, moves: ReadonlyArray<StaffMoveLite>, opts: { laterHours?: number; comboMs?: number | null } = {}): { now: string | null; later: string | null; combo?: boolean } {
  const lim = (opts.laterHours ?? 24) * 3_600_000;
  const ms = moves.filter((m) => m.at >= turnAtMs && m.at - turnAtMs < lim).sort((a, b) => a.at - b.at);
  if (!ms.length) return { now: null, later: null };
  const now = ms[0].family;
  if (now !== "返信") return { now, later: null };
  const comboMs = opts.comboMs !== undefined ? opts.comboMs : yardstickComboWindowOn() ? 120_000 : null;
  if (comboMs != null) { const a = ms.find((m) => m.family !== "返信"); if (a && a.at - ms[0].at <= comboMs) return { now: a.family, later: null, combo: true }; }
  return { now, later: ms.find((m) => m.family !== "返信")?.family ?? null };
}
export type TwoFrameJudge = { now: "hit" | "miss"; later: "hit" | "miss" | "brain_only" | "staff_only" | "na" };
/** 2枠の判定。後の通は、両方に後の AIX がある時だけ当たり外れ・片方だけは brain_only（約束したが果たしていない）/ staff_only（スタッフだけ後で送った） */
export function judgeTwoFrames(b: BrainFrames, s: { now: string | null; later: string | null }): TwoFrameJudge {
  const now = b.now === (s.now ?? "返信") ? "hit" : "miss";
  let later: TwoFrameJudge["later"] = "na";
  if (b.later && s.later) later = b.later === s.later ? "hit" : "miss";
  else if (b.later) later = "brain_only";
  else if (s.later) later = "staff_only";
  return { now, later };
}
export type TwoFrameCount = { n: number; nowHit: number; laterHit: number; laterMiss: number; brainOnly: number; staffOnly: number };
export function countTwoFrames(rows: ReadonlyArray<{ scene: string | null; judge: TwoFrameJudge }>): Map<string, TwoFrameCount> {
  const m = new Map<string, TwoFrameCount>();
  for (const r of rows) {
    const k = r.scene ?? "（場面なし）";
    const v = m.get(k) ?? { n: 0, nowHit: 0, laterHit: 0, laterMiss: 0, brainOnly: 0, staffOnly: 0 };
    v.n++; if (r.judge.now === "hit") v.nowHit++;
    if (r.judge.later === "hit") v.laterHit++; else if (r.judge.later === "miss") v.laterMiss++; else if (r.judge.later === "brain_only") v.brainOnly++; else if (r.judge.later === "staff_only") v.staffOnly++;
    m.set(k, v);
  }
  return m;
}

// ─── 見張りの staff_aix が空の番を aix_usage_logs で補う（2026-11-13 作業員8b・統括役・弱い所 836 の調べで見つけた）──────────────
//   見張り 11447 は line_watch_turns.staff_aix が空で、竹内さんの25分後の AIX（property_check_result・condition_hearing）が「aix_unknown」に数えられていた。
//   見張りの行に AIX が無い時だけ、その会話の aix_usage_logs の番の後 hours 時間以内の行で補う（見張りに有る時は見張りのまま）。
//   staffFrames（作業員7b の組の窓）と staffFirstMove に同じ AIX の一覧が入る＝系統の決め方は変えない。既定 off（YARDSTICK_AIX_LOG_FILL=on）
export function yardstickAixLogFillOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.YARDSTICK_AIX_LOG_FILL ?? "").trim().toLowerCase() === "on";
}
export type AixLogLite = { at: number; aixType: string; checkPattern: string | null };
export function fillStaffAix(watch: ReadonlyArray<AixLogLite>, convLogs: ReadonlyArray<AixLogLite>, turnAtMs: number, opts: { hours?: number } = {}): AixLogLite[] {
  if (watch.length) return [...watch];
  const lim = (opts.hours ?? 24) * 3_600_000;
  return convLogs.filter((a) => a.at >= turnAtMs && a.at - turnAtMs < lim).sort((a, b) => a.at - b.at);
}
