// scripts/lib/exam-base-pin.ts — 昼の依頼が比べる「前」を、夜に1回作った main の答え（夜の基準）に固定するかを決める（純関数・LLM も DB も git も使わない）
//
// 2026-11-05 作業員8（竹内さんの了承「前の答えを、本番の commit ごとに1回だけ作って使い回す（夜に1回）」・統括役の 1）:
//   測った事: 11/04〜05 に前を作る子が r58本・commit 25個（main が進むたびに作り直し）・DeepSeek 実額 約$51（依頼の側の約2倍）・
//   下見（入力が前の main と同じなら呼ばない）は 47依頼で 0問・持ち越しは1回。昼の依頼ごとに今の main で前を作るのをやめ、
//   夜（安い時間）に1回作った main の答えを、その日の依頼の「前」にする。
//   夜の後に main に入った物で、依頼の答えが変わりうる（試験の線に触れる・既定 on）時だけ、悪化に見えた問題を今の main で確かめ直す（確かめは少数）。
//   KB: a62a4164（使い回し・決着で止める）・2acd77de（P0 使い回す）・d57f27eb（組ごと）。点検表 12（古い作業ツリー）も見る。

export type NightlyBase = {
  /** 夜の基準を作った main の commit（40桁でも7桁でもよい） */
  commit: string;
  /** 作り終えた時刻（ISO） */
  at: string;
  /** 答えのある問題 */
  problems: string[];
};
export type SinceNightly = {
  /** 夜の基準の commit から今の origin/main までに変わったファイル（git diff --name-only） */
  files: string[];
  /** そのうち既定 on のスイッチ・既定 on へ変えたコミットがあるか（統括の記録・コミットの文面から。分からなければ true＝安全側） */
  defaultOnChange?: boolean;
};
export type BasePinDecision = {
  /** --baseline=main@<ref> に入れる ref。null＝今まで通り（今の main で前を作る） */
  ref: string | null;
  /** 悪化に見えた問題だけ、今の main でも前を作って確かめ直すか */
  confirmOnCurrent: boolean;
  /** 夜の基準に無い問題（夜の commit で前を作る＝少数） */
  missing: string[];
  why: string;
};

/** 試験の線（ブレイン・下書き・試験の道具・設定）に触れるファイルか。exam-scope.ts の入口と同じ見方の粗い版（安全側＝分からなければ触れる） */
export function touchesExam(file: string): boolean {
  if (/^(?:memory|docs|public|chrome-extension)\//.test(file) || /\.(?:md|txt|png|jpe?g|svg|css|html)$/.test(file)) return false;
  if (/(?:^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/.test(file)) return false;
  if (/^scripts\//.test(file) && !/^scripts\/(?:brain-exam|lib\/(?:brain-exam|exam-|llm-))/.test(file)) return false; // 試験の道具以外の台本
  if (/^app\/(?:\(|admin|estimate|components)/.test(file) || /\.tsx$/.test(file)) return false; // 画面
  return true;
}

/**
 * 依頼の「前」をどれにするか。
 *   - 夜の基準が無い・古い（maxAgeH・既定 30時間）→ 今まで通り
 *   - 依頼の作業ツリーが夜の commit を含まない（古い作業ツリー・点検表 12）→ 今まで通り（取り込みを促す）
 *   - 夜の後の main の変更が試験の線に触れない → 夜の基準だけ（確かめ直し無し）
 *   - 触れる ＋ 既定 on の変更がある（か分からない）→ 夜の基準＋悪化に見えた問題だけ今の main で確かめ直す
 *   - 触れるが既定 off だけ（スイッチを足しただけ）→ 夜の基準だけ（既定 off の中身は答えを変えない）
 */
export function decideBasePin(input: {
  nightly: NightlyBase | null;
  nowMs: number;
  requestHasNightly: boolean;
  since: SinceNightly;
  problems: string[];
  maxAgeH?: number;
}): BasePinDecision {
  const { nightly } = input;
  const maxAgeMs = (input.maxAgeH ?? 30) * 3_600_000;
  if (!nightly) return { ref: null, confirmOnCurrent: false, missing: [], why: "夜の基準が無い（今まで通り今の main で前を作る）" };
  const age = input.nowMs - Date.parse(nightly.at);
  if (!Number.isFinite(age) || age > maxAgeMs) return { ref: null, confirmOnCurrent: false, missing: [], why: `夜の基準が古い（${Math.round(age / 3_600_000)}時間前）` };
  if (!input.requestHasNightly) return { ref: null, confirmOnCurrent: false, missing: [], why: `依頼の作業ツリーが夜の基準 ${nightly.commit.slice(0, 7)} を含まない（origin/main を取り込んでから）` };
  const have = new Set(nightly.problems);
  const missing = input.problems.filter((id) => !have.has(id));
  const touched = input.since.files.filter(touchesExam);
  if (!touched.length) return { ref: nightly.commit, confirmOnCurrent: false, missing, why: `夜の基準 ${nightly.commit.slice(0, 7)}（その後の main は試験の線に触れない・${input.since.files.length}ファイル）` };
  const onChange = input.since.defaultOnChange ?? true;
  if (!onChange) return { ref: nightly.commit, confirmOnCurrent: false, missing, why: `夜の基準 ${nightly.commit.slice(0, 7)}（その後は既定 off の足し込みだけ・${touched.length}ファイル）` };
  return { ref: nightly.commit, confirmOnCurrent: true, missing, why: `夜の基準 ${nightly.commit.slice(0, 7)}＋悪化に見えた問題だけ今の main で確かめ直す（夜の後に試験の線の既定 on の変更・${touched.slice(0, 3).join(",")}${touched.length > 3 ? " …" : ""}）` };
}

/**
 * 夜の後の main のコミットの題から「既定 on の変更があるか」（純関数・安全側）: 題に「既定 on」「を on」「default on」があるか、
 *   「既定 off」も「記録だけ」も無い題が1つでもあれば true。全部が「既定 off」「記録だけ」「テスト」「文書」なら false。
 */
export function defaultOnFromSubjects(subjects: string[]): boolean {
  for (const s of subjects) {
    if (/既定\s*on|を\s*on\b|default\s*on/i.test(s)) return true;
    if (!/既定\s*off|記録だけ|^test|^docs|^chore\(試験の列・手元だけ\)/i.test(s)) return true;
  }
  return false;
}

/** 夜の基準の控えの形（<置き場>/nightly-base-<構成>.json） */
export type NightlyRecord = NightlyBase & { cfg: string; /** 夜の基準が読んだ DB の写しの日（弱い所 354） */ snapDay?: string };

/**
 * 夜の基準を作る依頼（係の列に毎晩1つ積む・純関数）。夜（JST fromHour 時以降・既定 21時）に、その日の分がまだ積まれていなければ返す。
 *   中身: brain-exam --baseline=main --baseline-only（取り置きが無い・入力が変わった問題だけ回す＝決まった入力なら下見で済む）・stage=brain・夜だけ流す。
 *   終わると brain-exam が nightly-base-<構成>.json を書き、次の日の昼の依頼がその commit で比べる。
 */
/**
 * 2026-11-07 作業員8（夜の基準が一度も効いていなかった原因の2つ目）: 前の答えの置き場と控えは構成（--repeat を含む）ごと。
 *   夜を --repeat=2 で作ると構成 118f718528、昼の依頼は --repeat=4（揺れる問題の回）で構成 8381e072a8＝夜の控えが昼の依頼から見つからない。
 *   夜も昼と同じ --repeat=4 で作る（前の子は揺れる問題だけ回を足す＝EXAM_BASE_REPEAT_FLAKY・安定の問題は1回で揃い扱い）
 */
export const NIGHT_BASE_REPEAT = 4;

export function nightBaseJobDue(lastJstDay: string | null, now: Date, opts: { fromHour?: number; cwd: string; repeat?: number }): { due: boolean; day: string; job: Record<string, unknown> | null } {
  const j = new Date(now.getTime() + 9 * 3_600_000);
  const day = j.toISOString().slice(0, 10), h = j.getUTCHours();
  const due = lastJstDay !== day && h >= (opts.fromHour ?? 21);
  if (!due) return { due, day, job: null };
  const label = `night-base-${day}`;
  const createdAt = now.toISOString();
  return {
    due, day, job: {
      id: `${now.getTime()}`, label, owner: "夜の基準", switch: "（夜の基準を作る）", cwd: opts.cwd, only: "", stage: "brain", repeat: 1,
      // 2026-11-06: 始めの main で最後まで作る（main が進んでも止めない）・DB の材料はその夜の日の写し
      env: { LLM_TEST_MODE: "deepseek-all", EXAM_BASELINE_IGNORE_MAIN_MOVED: "1", EXAM_DB_SNAPSHOT_DAY: new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 10) },
      createdAt, tries: 0, runner: "cmd", nightOnly: true, priority: 9, maxMin: 300,
      cmds: [`scripts/brain-exam.ts --label=${label} --conv=auto --baseline=main --baseline-only --stage=brain --repeat=${Math.max(1, opts.repeat ?? NIGHT_BASE_REPEAT)}`],
    },
  };
}

/** その日の夜の基準の依頼が、列・済み・結果のどこかに既にあるか（印のファイルが無くても二重に積まない・11/05 21:49 の落ちの後） */
export function nightBaseAlready(day: string, fileNames: readonly string[]): boolean {
  const label = `night-base-${day}`;
  return fileNames.some((f) => f.includes(label));
}

/**
 * 係の列のフォルダの .json が依頼の形か（純関数）。11/05 21:49 に夜の基準の印（{day, at}）を列に置いて、流す係が依頼と読み j.only.split で落ちた。
 *   依頼の形＝id と label が文字列・runner が知っている物か無し・brain-exam の依頼（runner 無し）は only が文字列
 */
export function isExamJobShape(x: unknown): boolean {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const j = x as Record<string, unknown>;
  if (typeof j.id !== "string" || typeof j.label !== "string" || !j.label) return false;
  const r = j.runner;
  if (r != null && r !== "brain-exam" && r !== "cmd" && r !== "tsc" && r !== "tsc-remote") return false;
  if (r === "cmd") return Array.isArray(j.cmds);
  if (r == null || r === "brain-exam") return typeof j.only === "string";
  return true;
}

/** 確かめ直しの対象: 夜の基準と比べて悪化に見えた問題（確かな悪化・揺れの範囲の差の両方）。良くなった・同じは確かめない */
export function confirmTargets(cmps: Array<{ id: string; cmp: string }>): string[] {
  return cmps.filter((c) => /^worse/.test(c.cmp)).map((c) => c.id);
}

/**
 * 前を夜の基準に固定した回の確かめ直しの対象（純関数・2026-11-06 統括役）: この回で1回でも外れた問題。
 *   悪化＝前が○で今が✕＝今が全部○の問題は悪化になりえない＝確かめ直さなくても見落としは増えない。
 *   夜の基準の後の main の直しで前が○に変わった問題（夜は✕・今の main は○・依頼は✕）も、外れた問題に入るので拾える
 */
export function pinConfirmIds(rows: ReadonlyArray<{ id: string; score?: { pass?: boolean } | null; error?: string }>): string[] {
  return [...new Set(rows.filter((r) => !r.error && r.score && r.score.pass === false).map((r) => r.id))];
}

/** 比べる前の行を合わせる（純関数）: 確かめ直した問題は今の main の前、それ以外は夜の基準の前 */
export function mergePinnedBase<R extends { id: string }>(nightly: ReadonlyArray<R>, current: ReadonlyArray<R>, confirmed: ReadonlyArray<string>): R[] {
  const c = new Set(confirmed), have = new Set(current.map((r) => r.id));
  return [...nightly.filter((r) => !(c.has(r.id) && have.has(r.id))), ...current.filter((r) => c.has(r.id))];
}
