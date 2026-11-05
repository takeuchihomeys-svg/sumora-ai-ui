// scripts/lib/exam-copy-check.ts — 試験の写しの正しさを、流す前に機械で確かめる（純関数・LLM も DB も使わない。読み直した数は呼ぶ側が渡す）
//
// 2026-11-05 作業員8（統括役の了承の 4「写しの正しさを流す前に機械で確かめる」・弱い所 313）:
//   テスト用の会話（YUMA2〜7）に、片付けられなかった台帳の行が積もっていた（24時間で sent_properties 743行・aix_usage_logs 274行）。
//   brain-exam の走り始めの片付けは自分の label の控えしか読まず、前の子（label が毎回新しい）・上限で止めた回の行が残る。線（gte floor）は
//   場面の始まり（EXAM_REAL_GAPS で数時間前）より後の残りを全部通す＝同じ問題でも「送った物件=13→20→32件」「直近 AIX 0分前・4分前」と回ごとに変わった。
//   ①入れる前に、借りた会話に台帳の行が残っていないか（leftoverBefore）②入れた後に、表ごとの行の数が問題の写しと同じか（verifyCopy）
//   ③通の数・時刻の間・引用の先（problems.json の写しと YUMA に入れた通）を比べ、ずれた問題は流さない。
//   点検表: 11（同じ会話を2本）・16（写しが本番に混ざる）と同じ型。KB e9d2303e（質）・a62a4164（使い回し）。

export type TableCounts = Record<string, number>;

export type CopyIssue = { kind: "leftover" | "count" | "messages" | "gap" | "quote"; detail: string };
export type CopyVerdict = { ok: boolean; issues: CopyIssue[] };

/** 入れる前: 借りた会話に残っている台帳の行（0 でなければ、消してから入れる。消せなければ流さない） */
export function leftoverBefore(counts: TableCounts): CopyIssue[] {
  return Object.entries(counts).filter(([, n]) => n > 0).map(([t, n]) => ({ kind: "leftover" as const, detail: `${t} に前の回の行が ${n}件` }));
}

/** 入れた後: 表ごとの行の数（読み直し）＝問題の写しの数（problems.json の ledger）か */
export function verifyLedgerCounts(expected: TableCounts, observed: TableCounts): CopyIssue[] {
  const out: CopyIssue[] = [];
  for (const t of new Set([...Object.keys(expected), ...Object.keys(observed)])) {
    const e = expected[t] ?? 0, o = observed[t] ?? 0;
    if (e !== o) out.push({ kind: "count", detail: `${t}: 写し ${e}件・入った ${o}件` });
  }
  return out;
}

export type MsgLite = { at: string; quoteOf?: string | null; id?: string | null };

/**
 * 通の写し: 数が同じ・順が同じ・時刻の間が元の間と大きく違わない（既定 元の間の半分〜2倍・ただし元が90秒未満の間は見ない）・
 * 引用の先（quoteOf）が写しの中にある（古い引用の先が落ちる穴）。
 */
export function verifyMessages(orig: MsgLite[], copied: MsgLite[], opts: { ratioLo?: number; ratioHi?: number; minGapMs?: number } = {}): CopyIssue[] {
  const out: CopyIssue[] = [];
  if (orig.length !== copied.length) { out.push({ kind: "messages", detail: `通の数 元 ${orig.length}・写し ${copied.length}` }); return out; }
  const lo = opts.ratioLo ?? 0.5, hi = opts.ratioHi ?? 2, minGap = opts.minGapMs ?? 90_000;
  let bad = 0; let first = "";
  for (let i = 1; i < orig.length; i++) {
    const g0 = Date.parse(orig[i].at) - Date.parse(orig[i - 1].at), g1 = Date.parse(copied[i].at) - Date.parse(copied[i - 1].at);
    if (!Number.isFinite(g0) || !Number.isFinite(g1)) continue;
    if (g1 < 0) { bad++; first ||= `#${i} 順が逆`; continue; }
    if (g0 < minGap) continue;
    const r = g1 / g0;
    if (r < lo || r > hi) { bad++; first ||= `#${i} 元 ${Math.round(g0 / 1000)}秒 → 写し ${Math.round(g1 / 1000)}秒`; }
  }
  if (bad) out.push({ kind: "gap", detail: `時刻の間のずれ ${bad}か所（${first}）` });
  const ids = new Set(copied.map((m) => m.id).filter(Boolean) as string[]);
  const lost = copied.filter((m) => m.quoteOf && !ids.has(m.quoteOf)).length;
  const origQuotes = orig.filter((m) => m.quoteOf).length;
  if (lost) out.push({ kind: "quote", detail: `引用の先が写しに無い ${lost}/${origQuotes}通` });
  return out;
}

/** まとめ。issues が1つでもあれば流さない（ok=false） */
export function verifyCopy(input: { leftover?: TableCounts; expected?: TableCounts; observed?: TableCounts; orig?: MsgLite[]; copied?: MsgLite[] }): CopyVerdict {
  const issues = [
    ...(input.leftover ? leftoverBefore(input.leftover) : []),
    ...(input.expected && input.observed ? verifyLedgerCounts(input.expected, input.observed) : []),
    ...(input.orig && input.copied ? verifyMessages(input.orig, input.copied) : []),
  ];
  return { ok: issues.length === 0, issues };
}
