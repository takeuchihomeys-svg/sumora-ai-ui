// app/lib/customer-sim-score.ts
// お客様役（YUMA）の記録（%TEMP%/sumora-customer-sim/*.jsonl の1行＝1往復）から、本番の「自動化の度合いの表」と同じ物差しで点数を出す（純関数）。
// 2026-09-27 竹内「このようにテスト繰り返して質上げていくために足りない部分等見つけていく／そうすれば完全自動化できるから」
//
// 本番の物差し（app/lib/automation-readiness.ts）との対応:
//   本番「手直しなしで送った率」 ↔ テスト「検査に手直しの要る指摘が1つも無い往復の率」（お客様役の文はスタッフが直さないので、
//                                    スタッフなら直す所＝検査の指摘で数える: お待たせ・作業メモ・創作の疑い・約束の言い直し・材料の取りこぼし・影の二重/別の道）
//   本番「ブレインの予想との一致」 ↔ テスト「画面のズレ」（staff-send-pattern の5種: 画面にブレインの AIX が出ていない・違う AIX 等）
//   本番「判断の後の行動」         ↔ テスト「止まった往復」（材料が要る・判断が来ない＝自動では進めない所）
// 1往復の「自動で届いた」＝送った・手直しの要る指摘なし・画面のズレなし・影のズレなし・状況の取り違えなし。
//
// 使い方（scripts/customer-sim.ts は別の担当が持つので組み込みはそちらで）:
//   const rows = readFileSync(jsonl).split("\n").filter(Boolean).map((l) => JSON.parse(l));
//   const s = scoreSimRun(rows);  console.log(formatSimScore(s));
//   複数の筋書きをまとめる時は scoreSimRun(全行) か、筋書きごとの scoreSimRun を並べる。
// テスト: app/lib/__tests__/customer-sim-score.test.ts（実物の jsonl の行）

/** jsonl の1行（使う欄だけ・他の欄は無視） */
export type SimRoundRow = {
  round?: number;
  plan?: string | null;
  note?: string | null;
  draft?: string | null;
  sent?: string | null;
  sentKind?: string | null;
  conflicts?: number | null;
  material?: string | null;
  findings?: ReadonlyArray<{ kind: string; detail?: string }> | null;
  shadowFindings?: ReadonlyArray<{ kind: string; aix?: string; detail?: string }> | null;
  /** 画面のズレ（staff-send-pattern の ViewMismatch の kind）。記録に入るようになったら読む（今の jsonl には無い） */
  screenFindings?: ReadonlyArray<{ kind: string; detail?: string }> | null;
  screen?: { mismatches?: ReadonlyArray<{ kind: string }> | null } | null;
  usd?: number | null;
  simUsd?: number | null;
};

/** スタッフなら直す指摘（本番の「手直し」に当たる） */
export const SIM_FIX_KINDS: ReadonlySet<string> = new Set([
  "waited", "work_note", "invented", "repeat_promise", "material_missing",
  "draft_conflicts_aix", "draft_does_aix_job", "aix_followup_missing",
]);
/** 状況の取り違え（ブレイン・表示の読み違い） */
export const SIM_STATE_KINDS: ReadonlySet<string> = new Set(["stage_mismatch", "state_conflict"]);

export type SimStopKind = "needs_material" | "no_decision" | "dry" | "other";
export const SIM_STOP_JA: Record<SimStopKind, string> = {
  needs_material: "材料が要る（画面で送る）", no_decision: "判断が来ない", dry: "送る直前で止めた（--no-send/--dry）", other: "その他",
};
export function simStopKind(r: SimRoundRow): SimStopKind {
  const p = `${r.plan ?? ""} ${r.note ?? ""}`;
  if (/--no-send|--dry|送る直前/.test(p)) return "dry";
  if (/材料/.test(p)) return "needs_material";
  if (/判断が来ない/.test(p)) return "no_decision";
  return "other";
}

/** 送った物の種類（AIX の種類・下書き）。sentKind「AIX property_check_result/available」→「AIX property_check_result」 */
export function simSentLabel(r: SimRoundRow): string {
  const k = String(r.sentKind ?? "").trim();
  if (!k) return r.sent ? "下書き" : "（送っていない）";
  return k.replace(/\/.*$/, "");
}

function screenKinds(r: SimRoundRow): string[] | null {
  if (r.screenFindings) return r.screenFindings.map((x) => x.kind);
  if (r.screen?.mismatches) return r.screen.mismatches.map((x) => x.kind);
  return null;
}

export type SimRoundJudged = {
  round: number | null;
  sent: boolean;
  label: string;
  stop: SimStopKind | null;
  fixKinds: string[];
  stateKinds: string[];
  shadowKinds: string[];
  screenKinds: string[] | null;
  /** 自動で届いた（送った・手直しの要る指摘なし・画面/影/状況のズレなし） */
  auto: boolean;
};

export function judgeSimRound(r: SimRoundRow): SimRoundJudged {
  const sent = !!(r.sent && String(r.sent).trim());
  const all = (r.findings ?? []).map((f) => f.kind);
  const shadow = (r.shadowFindings ?? []).map((f) => f.kind);
  // findings に影の指摘が重ねて入る事がある（同じ kind）ので、手直しの型は両方から重なりを除いて数える
  const fixKinds = [...new Set([...all.filter((k) => SIM_FIX_KINDS.has(k)), ...shadow.filter((k) => SIM_FIX_KINDS.has(k))])];
  const stateKinds = [...new Set(all.filter((k) => SIM_STATE_KINDS.has(k)))];
  const scr = screenKinds(r);
  const auto = sent && fixKinds.length === 0 && stateKinds.length === 0 && shadow.length === 0 && (scr == null || scr.length === 0);
  return {
    round: typeof r.round === "number" ? r.round : null,
    sent, label: simSentLabel(r), stop: sent ? null : simStopKind(r),
    fixKinds, stateKinds, shadowKinds: shadow, screenKinds: scr, auto,
  };
}

export type SimScore = {
  rounds: number;
  sent: number;
  /** 自動で届いた往復 / 全往復（止まった往復も分母＝自動では進めなかった。--no-send/--dry で止めた往復だけ除く） */
  autoRate: number | null;
  /** 送った往復のうち手直しの要る指摘が無い率（本番の「手直しなし」に当たる） */
  cleanRate: number | null;
  stops: Partial<Record<SimStopKind, number>>;
  /** 指摘の件数（種類ごと） */
  fixes: Record<string, number>;
  stateMismatch: number;
  shadowMismatch: number;
  /** 画面のズレ（記録がある往復だけ。無ければ null） */
  screenMismatch: number | null;
  screenJudged: number;
  /** 材料を使って送った往復のうち、材料の取りこぼし（material_missing）の率 */
  materialMissRate: number | null;
  /** 送った物の種類ごと */
  byLabel: Array<{ label: string; n: number; clean: number; cleanRate: number | null }>;
  usd: number;
};

const rate = (a: number, b: number) => (b > 0 ? a / b : null);

export function scoreSimRun(rows: ReadonlyArray<SimRoundRow>): SimScore {
  const js = rows.map(judgeSimRound);
  const sentJ = js.filter((j) => j.sent);
  const clean = sentJ.filter((j) => j.fixKinds.length === 0);
  const stops: SimScore["stops"] = {};
  for (const j of js) if (j.stop) stops[j.stop] = (stops[j.stop] ?? 0) + 1;
  const fixes: Record<string, number> = {};
  for (const j of js) for (const k of j.fixKinds) fixes[k] = (fixes[k] ?? 0) + 1;
  const screenRows = js.filter((j) => j.screenKinds != null);
  const withMaterial = rows.filter((r) => r.sent && r.material);
  const labels = new Map<string, SimRoundJudged[]>();
  for (const j of sentJ) { const a = labels.get(j.label) ?? []; a.push(j); labels.set(j.label, a); }
  return {
    rounds: js.length,
    sent: sentJ.length,
    // 送る直前で止めた往復（--no-send/--dry）はテストの都合なので分母に入れない
    autoRate: rate(js.filter((j) => j.auto).length, js.filter((j) => j.stop !== "dry").length),
    cleanRate: rate(clean.length, sentJ.length),
    stops,
    fixes,
    stateMismatch: js.filter((j) => j.stateKinds.length > 0).length,
    shadowMismatch: js.filter((j) => j.shadowKinds.length > 0).length,
    screenMismatch: screenRows.length ? screenRows.filter((j) => (j.screenKinds ?? []).length > 0).length : null,
    screenJudged: screenRows.length,
    materialMissRate: rate(withMaterial.filter((r) => (r.findings ?? []).some((f) => f.kind === "material_missing")).length, withMaterial.length),
    byLabel: [...labels].map(([label, xs]) => ({ label, n: xs.length, clean: xs.filter((x) => x.fixKinds.length === 0).length, cleanRate: rate(xs.filter((x) => x.fixKinds.length === 0).length, xs.length) }))
      .sort((a, b) => b.n - a.n),
    usd: rows.reduce((s, r) => s + (Number(r.usd) || 0) + (Number(r.simUsd) || 0), 0),
  };
}

const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);
const FIX_JA: Record<string, string> = {
  waited: "お待たせ", work_note: "作業メモ", invented: "創作の疑い", repeat_promise: "約束の言い直し", material_missing: "材料の取りこぼし",
  draft_conflicts_aix: "影: 下書きが AIX と別の道", draft_does_aix_job: "影: 下書きが AIX の送る物を書いた", aix_followup_missing: "AIX の後の一言が無い",
};

export function formatSimScore(s: SimScore, title = "お客様役の点数"): string {
  const L: string[] = [];
  L.push(`【${title}】往復 ${s.rounds}・送った ${s.sent}`);
  L.push(`  自動で届いた ${pct(s.autoRate)}（送った・手直しの要る指摘なし・画面/影/状況のズレなし ÷ 全往復〔送る直前で止めた往復を除く〕）`);
  L.push(`  手直しなし（送った往復のうち指摘なし） ${pct(s.cleanRate)}`);
  const stops = Object.entries(s.stops).map(([k, n]) => `${SIM_STOP_JA[k as SimStopKind]} ${n}`).join("・");
  L.push(`  止まった: ${stops || "なし"}`);
  const fx = Object.entries(s.fixes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${FIX_JA[k] ?? k} ${n}`).join("・");
  L.push(`  手直しの型: ${fx || "なし"}`);
  L.push(`  状況の取り違え ${s.stateMismatch}・影のズレ ${s.shadowMismatch}・画面のズレ ${s.screenMismatch == null ? "（記録なし）" : `${s.screenMismatch}/${s.screenJudged}`}・材料の取りこぼし ${pct(s.materialMissRate)}`);
  L.push(`  種類ごと（手直しなし）: ${s.byLabel.map((b) => `${b.label} ${b.clean}/${b.n}`).join("・") || "—"}`);
  L.push(`  費用 $${s.usd.toFixed(3)}`);
  return L.join("\n");
}
