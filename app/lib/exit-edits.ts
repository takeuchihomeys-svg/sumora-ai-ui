// exit-edits.ts — 出口ごとの変化の記録（2026-10-14 竹内さん「出口の規則が正しい文を消す」・区切り1 記録の穴）
//
// 返信の生成の後、本文は 20 前後の出口（validate-reply の外の guardPropertyNames・strip*・applyLedgerAutoFix・enforceOpening・
// 最終チェックの書き直し・書き直しの後の applySurfaceFixes 等）を通る。旧は validate-reply の enforceAixGates の分（gateEdits）しか残らず、
// 「人の正しい文をどの出口が消したか」を数えられなかった（scratchpad nonbrain の洗い出し）。
// ここは純関数だけ: 出口の前と後の文を文の単位で比べ、消えた文・足された文を tpo_debug.postprocess.exitEdits に残す（本文は変えない）。
// 戻す: EXIT_EDITS_LOG=off（記録しない）

export type ExitEdit = {
  /** 1＝1回目の生成・2＝最終チェックの作り直し・0＝最終チェックの後（gen を問わない掛け直し） */
  gen: number;
  /** 出口の名前（例 guardPropertyNames・stripVagueDeferral・final_check_revision） */
  exit: string;
  /** 消えた文（先頭 60 字・最大 6） */
  removed: string[];
  /** 足された文（先頭 60 字・最大 6） */
  added: string[];
  /** 出口が自分で返した理由（applySurfaceFixes の applied・最終チェックの指摘のコード 等・最大 8） */
  why?: string[];
};

const MAX_SENT = 6;
const MAX_EDITS = 60;
const CUT = 60;

export function exitEditsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EXIT_EDITS_LOG !== "off";
}

/** 文に分ける（改行・文末の記号。「！！」等の連続は1文） */
export function splitExitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/\n|(?<=[。！!？?])(?![。！!？?])/)
    .map((s) => s.replace(/[\s　]+$/g, "").replace(/^[\s　]+/g, ""))
    .filter((s) => s.length > 0);
}

/** 多重集合の差（before にあって after に無い文・after にあって before に無い文） */
export function diffExitSentences(before: string, after: string): { removed: string[]; added: string[] } {
  const a = splitExitSentences(before);
  const b = splitExitSentences(after);
  const count = new Map<string, number>();
  for (const s of b) count.set(s, (count.get(s) ?? 0) + 1);
  const removed: string[] = [];
  for (const s of a) {
    const n = count.get(s) ?? 0;
    if (n > 0) count.set(s, n - 1);
    else removed.push(s);
  }
  const countA = new Map<string, number>();
  for (const s of a) countA.set(s, (countA.get(s) ?? 0) + 1);
  const added: string[] = [];
  for (const s of b) {
    const n = countA.get(s) ?? 0;
    if (n > 0) countA.set(s, n - 1);
    else added.push(s);
  }
  return { removed, added };
}

export type ExitRecorder = {
  readonly edits: ExitEdit[];
  /** before と after を比べて変わっていれば1件積む（文の違いが無い＝空白だけの変化は積まない）。after をそのまま返す */
  record: (gen: number, exit: string, before: string, after: string, why?: string[]) => string;
};

export function createExitRecorder(enabled = exitEditsEnabled()): ExitRecorder {
  const edits: ExitEdit[] = [];
  return {
    edits,
    record(gen, exit, before, after, why) {
      if (!enabled || before === after || edits.length >= MAX_EDITS) return after;
      const d = diffExitSentences(before, after);
      if (!d.removed.length && !d.added.length && !(why && why.length)) return after;
      const e: ExitEdit = {
        gen, exit,
        removed: d.removed.slice(0, MAX_SENT).map((s) => s.slice(0, CUT)),
        added: d.added.slice(0, MAX_SENT).map((s) => s.slice(0, CUT)),
      };
      if (why && why.length) e.why = why.slice(0, 8).map((w) => String(w).slice(0, 80));
      edits.push(e);
      return after;
    },
  };
}
