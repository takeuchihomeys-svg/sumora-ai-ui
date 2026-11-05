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
export type NightlyRecord = NightlyBase & { cfg: string };

/** 確かめ直しの対象: 夜の基準と比べて悪化に見えた問題（確かな悪化・揺れの範囲の差の両方）。良くなった・同じは確かめない */
export function confirmTargets(cmps: Array<{ id: string; cmp: string }>): string[] {
  return cmps.filter((c) => /^worse/.test(c.cmp)).map((c) => c.id);
}
