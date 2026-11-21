/**
 * 統括Pro（物件検索）の段A（2026-11-21 作業員G・統括役の指示）
 *
 *   凍結した問題集（learn_supervisor_log の過去の統括Pro の根拠の行）を、今のコードの決定論の部品で再生し、
 *   「本当の原因（層・F番号）」の正解ラベルと比べる。費用0（LLM なし）・毎晩。
 *   あわせて、最新の統括Pro の根拠の行から quality_daily の5つの数を作る（search-quality-daily）。
 *
 * ★ なぜ要るか
 *   統括Pro の判断を前と今で比べる試験が無かった（単体テストは純関数の形だけ）。
 *   dept_search_tool.md に残した誤判定の実例（学べ0・古い数え方・根因の取り違え）を凍結し、
 *   部品を直した時に「同じ誤判定をまた出さないか」「正しい層・F番号を出すか」を決まった計算で確かめる。
 *
 * ⚠ 純関数（DB は読まない）。凍結した材料は .claude/exam-cache/search-pro-exam/cases.json（git に入れない・お客様の名前が混ざりうる）。
 *   正解ラベルは scripts/search-pro-exam/truth.json（名前・文は入れない）。
 */
import { causeRelearnFromEvidence, photoReachFromBundle } from "./learn-supervisor-pro";
import { buildVisionProLink } from "./vision-pro-link";

export type EvRow = { label?: string; value?: string; guessed?: boolean };

/** 原因の層（pro-cause-relearn の CauseLayer）→ quality_daily の名前 */
export const CAUSE_LAYER_JA: Record<string, string> = {
  learn: "学習",
  foundation: "土台",
  link: "連携",
  grasp: "把握",
  reflect: "反映",
  auto: "自動",
};

/** 再生の時は、決定論で後から足した行を外して組み直す（残すと ensure* が早く返り、今のコードの答えにならない） */
export const DERIVED_LABEL_RE = /^(原因→改善の再学習|人間のように原因を考える|足りない土台（原因再学習・決定論）)$/;

export function stripDerived(ev: EvRow[] | null | undefined): EvRow[] {
  return (ev || []).filter((e) => !DERIVED_LABEL_RE.test(String(e?.label || "")));
}

function findValue(ev: EvRow[], re: RegExp): string | null {
  const row = ev.find((e) => re.test(String(e?.label || "")));
  return row ? String(row.value || "") : null;
}

/** 土台の ✓数／全数と重要欠（「学習完成（期間・土台・つながり・一連）」→ 無ければ「学習土台点検（F番号）」） */
export function parseFoundationScore(ev: EvRow[]): { ok: number | null; total: number | null; critical: string[] } {
  const done = findValue(ev, /^学習完成（期間・土台・つながり・一連）$/) || "";
  const audit = findValue(ev, /^学習土台点検（F番号）$/) || "";
  // 前の形（11/19 まで）は「学習完成」の側が「土台 26/0 ✓」（全数 0）と書いていた → 全数が 0 の時は点検の行を使う
  const m1 = /土台\s*(\d+)\s*\/\s*(\d+)\s*✓/.exec(done);
  const m = m1 && Number(m1[2]) > 0 ? m1 : (/(\d+)\s*\/\s*(\d+)\s*✓/.exec(audit) || m1);
  const crit = /重要欠[:：]([^／\n]+)/.exec(done)?.[1] || "";
  const critical = crit.split(/[・,、]/).map((s) => s.trim()).filter((s) => /^F\d+/.test(s));
  return { ok: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, critical };
}

/** 自動モード完成度（0〜100） */
export function parseCompletion(ev: EvRow[]): number | null {
  const v = findValue(ev, /^自動モード完成度$/) || "";
  const m = /完成度\s*(\d+)\s*\/\s*100/.exec(v);
  return m ? Number(m[1]) : null;
}

export type CauseSummary = {
  layers: Record<string, number>;
  /** 先頭の原子の層（ボトルネック） */
  bottleneck_layer: string | null;
  atom_ids: string[];
  /** foundation_gaps の F 番号（並び順） */
  f_ids: string[];
  lines: string[];
};

/** 根拠の行（決定論の行を外した物）から、今のコードで原因の再学習を組み直す */
export function causeSummaryFromEvidence(ev: EvRow[]): CauseSummary {
  const rep = causeRelearnFromEvidence(stripDerived(ev));
  const layers: Record<string, number> = {};
  for (const a of rep.atoms) {
    const k = CAUSE_LAYER_JA[a.layer] || a.layer;
    layers[k] = (layers[k] || 0) + 1;
  }
  const f_ids: string[] = [];
  for (const a of rep.atoms) {
    const m = /(F\d+)/.exec(String(a.foundation || ""));
    if (m && !f_ids.includes(m[1])) f_ids.push(m[1]);
  }
  return {
    layers,
    bottleneck_layer: rep.atoms[0] ? CAUSE_LAYER_JA[rep.atoms[0].layer] || rep.atoms[0].layer : null,
    atom_ids: rep.atoms.map((a) => a.id),
    f_ids,
    lines: [rep.line, rep.relearn_line, ...rep.foundation_gaps],
  };
}

// ─── 問題集 ───────────────────────────────────────────────

export type ProExamCase = {
  /** 例 "pro-4110" */
  id: string;
  log_id: number;
  scope: string;
  logged_at: string;
  frozen_at: string;
  evidence: EvRow[];
  /** 写真の届き（photoReachFromBundle）を見る時だけ。束の一部（shot_gaps 等）の写し */
  bundle?: Record<string, unknown> | null;
};

export type ProExamTruth = {
  id: string;
  /** dept_search_tool.md の記録（日時・見出し） */
  source: string;
  /** 本当の原因（人の言葉・名前は入れない） */
  note: string;
  /** 原因の層に必ず入っている事（どれか1つ以上ではなく全部） */
  layers_all?: string[];
  /** 入ってはいけない層 */
  layers_none?: string[];
  /** 先頭（ボトルネック）の層 */
  bottleneck_layer?: string;
  /** foundation_gaps に必ず入る F 番号 */
  f_all?: string[];
  /** foundation_gaps に入ってはいけない F 番号（原因ではない） */
  f_none?: string[];
  /** 原因の原子（pro-cause-relearn の id）に必ず入る／入ってはいけない */
  atoms_all?: string[];
  atoms_none?: string[];
  /** 決定論の行に出てはいけない言い方（正規表現の文字列） */
  forbid?: string[];
  /** 写真の学べた数の下限（束の写しがある時） */
  photo_learned_min?: number;
  /** 土台の数・完成度が読めること */
  needs_scores?: boolean;
  /** 段B（LLM の文）でだけ見る誤り。段Aでは数えない */
  stage_b_only?: string;
};

export type ProExamReplay = {
  id: string;
  cause: CauseSummary;
  foundation: ReturnType<typeof parseFoundationScore>;
  completion: number | null;
  photo_learned: number | null;
  /** 写真の段（flashで読む等）の決定論の文（束の写しがある時） */
  photo_claim: string | null;
};

export function replayCase(c: ProExamCase): ProExamReplay {
  const ev = c.evidence || [];
  let photo_learned: number | null = null;
  let photo_claim: string | null = null;
  if (c.bundle) {
    try {
      const pr = photoReachFromBundle(c.bundle);
      photo_learned = pr.learnedUnknown ? null : pr.learnedOk;
      const link = buildVisionProLink({ photoInStorage: pr.photoReach, learnedOk: pr.learnedOk, learnedUnknown: pr.learnedUnknown, todo: pr.todo, photoKindsN: pr.photoKindsN, imageFields: pr.imageFields, withScreenPos: pr.withScreenPos, matched: pr.matched });
      photo_claim = link.steps.map((s) => String(s.detail || "")).join("\n");
    } catch { photo_learned = null; }
  }
  return {
    id: c.id,
    cause: causeSummaryFromEvidence(ev),
    foundation: parseFoundationScore(ev),
    completion: parseCompletion(ev),
    photo_learned,
    photo_claim,
  };
}

export function judgeCase(t: ProExamTruth, r: ProExamReplay): { ok: boolean; misses: string[] } {
  const misses: string[] = [];
  const has = (k: string) => (r.cause.layers[k] || 0) > 0;
  for (const k of t.layers_all || []) if (!has(k)) misses.push(`層「${k}」が無い`);
  for (const k of t.layers_none || []) if (has(k)) misses.push(`層「${k}」は原因ではない`);
  if (t.bottleneck_layer && r.cause.bottleneck_layer !== t.bottleneck_layer) {
    misses.push(`先頭の層が ${r.cause.bottleneck_layer ?? "無し"}（正: ${t.bottleneck_layer}）`);
  }
  for (const f of t.f_all || []) if (!r.cause.f_ids.includes(f)) misses.push(`${f} が土台の抜けに無い`);
  for (const f of t.f_none || []) if (r.cause.f_ids.includes(f)) misses.push(`${f} は原因ではない`);
  for (const a of t.atoms_all || []) if (!r.cause.atom_ids.includes(a)) misses.push(`原子 ${a} が無い`);
  for (const a of t.atoms_none || []) if (r.cause.atom_ids.includes(a)) misses.push(`原子 ${a} は誤り（材料の数と食い違う）`);
  const text = [...r.cause.lines, r.photo_claim || ""].join("\n");
  for (const pat of t.forbid || []) {
    if (new RegExp(pat).test(text)) misses.push(`出てはいけない言い方: ${pat}`);
  }
  // 分からない（null）は誤りに数えない（作らないのが正しい）。0 と言い切った時だけ誤り
  if (t.photo_learned_min != null && r.photo_learned != null && r.photo_learned < t.photo_learned_min) {
    misses.push(`写真の学べた数 ${r.photo_learned ?? "無し"}（正: ≥${t.photo_learned_min}）`);
  }
  if (t.needs_scores && (r.foundation.ok == null || r.completion == null)) misses.push("土台の数・完成度が読めない");
  return { ok: misses.length === 0, misses };
}

export type ProExamResult = { id: string; ok: boolean; misses: string[]; replay: ProExamReplay };

/** 前（基準）と今の比べ。悪くなった＝前は正しく今は違う */
export function compareProExam(
  base: ProExamResult[],
  now: ProExamResult[],
): { worse: string[]; better: string[]; changed: string[] } {
  const b = new Map(base.map((x) => [x.id, x]));
  const worse: string[] = [], better: string[] = [], changed: string[] = [];
  for (const n of now) {
    const p = b.get(n.id);
    if (!p) continue;
    if (p.ok && !n.ok) worse.push(n.id);
    else if (!p.ok && n.ok) better.push(n.id);
    if (JSON.stringify(p.replay.cause.atom_ids) !== JSON.stringify(n.replay.cause.atom_ids)) changed.push(n.id);
  }
  return { worse, better, changed };
}

// ─── quality_daily の5つの数 ─────────────────────────────────

export type SearchQualityRow = { metric: string; value: number | null; n: number | null; detail: Record<string, unknown> };

/**
 * 最新の統括Pro の根拠の行（scope ごと）から quality_daily の行を作る。
 *   search_found_ok:<scope>（✓数／全数）・search_found_critical:<scope>（重要欠の数）・search_pro_completion:<scope>（完成度）・
 *   search_cause_layer:<層>:<scope>（原因の型の数）。search_pro_misjudge は段Aの結果から（misjudgeRow）。
 * ⚠ quality_daily.scope は takeuchi/all/draft/employee だけなので、サイトは metric の名前の後ろに付ける（scope='all'）。
 */
export function searchQualityRows(site: string, ev: EvRow[], meta: { log_id: number; logged_at: string }): SearchQualityRow[] {
  const out: SearchQualityRow[] = [];
  const f = parseFoundationScore(ev);
  const base = { log_id: meta.log_id, logged_at: meta.logged_at };
  if (f.ok != null && f.total) {
    out.push({ metric: `search_found_ok:${site}`, value: Math.round((f.ok / f.total) * 1000) / 1000, n: f.total, detail: { ...base, ok: f.ok, total: f.total } });
    out.push({ metric: `search_found_critical:${site}`, value: f.critical.length, n: f.total, detail: { ...base, critical: f.critical } });
  }
  const c = parseCompletion(ev);
  if (c != null) out.push({ metric: `search_pro_completion:${site}`, value: c, n: null, detail: base });
  const cause = causeSummaryFromEvidence(ev);
  for (const k of Object.values(CAUSE_LAYER_JA)) {
    out.push({ metric: `search_cause_layer:${k}:${site}`, value: cause.layers[k] || 0, n: cause.atom_ids.length, detail: { ...base, atoms: cause.atom_ids.slice(0, 12) } });
  }
  return out;
}

export function misjudgeRow(results: ProExamResult[], stageBOnly: number): SearchQualityRow {
  const bad = results.filter((r) => !r.ok);
  return {
    metric: "search_pro_misjudge",
    value: bad.length,
    n: results.length,
    detail: { bad: bad.map((r) => ({ id: r.id, misses: r.misses.slice(0, 4) })), stage_b_only: stageBOnly },
  };
}
