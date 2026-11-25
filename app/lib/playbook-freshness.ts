// app/lib/playbook-freshness.ts — 手順書の「新しさ」の比べ方（純関数・DB を使わない・2.8.297）
//
// 竹内さん「なんで手順書ちゃんと反映されないこと多いのか／連動して反映されるように／抜けている部分強化する」（2026-11-25）。
//   実測 22:00〜22:24: 本番（main・手順書の見直し 2.8.154・build_v=6・決まり23件）が束を7回作り直し、
//   手元で揃えた新しい手順書（2.8.296・build_v=13・91件）を古い版で上書きした。
//   書く経路（API・cron・写真学習・attach）は全部「その場のコードで手順書を作り直す」ので、古いコードが動くたびに戻る。
//   → 手順書に作った版（rules_up_to）を持たせ、書く側は「今あるのがコードより新しい」なら作り直さず残す。
//
// ⚠ 版が付いていない（古い手順書）は新しさ 0 扱い＝何にも勝たない（古い手順書を守らない・新しいコードは必ず上書きできる）。
// ⚠ 同じ版どうしは build_v（作り方の版）が大きい方が新しい。同じなら上書きしてよい（同じ新しさ）。

export type PlaybookStamp = { rules_up_to?: unknown; build_v?: unknown } | null | undefined;

/** "2.8.296" → [2,8,296]。数字でない・空は [0]（桁ごとに数で比べる＝2.8.1000 > 2.8.295） */
export function parseVer(v: unknown): number[] {
  const s = String(v ?? "").trim();
  if (!s) return [0];
  const parts = s.split(".").map((x) => Number(x));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return [0];
  return parts;
}

/** a が新しければ正・同じなら 0・古ければ負 */
export function cmpVer(a: unknown, b: unknown): number {
  const x = parseVer(a);
  const y = parseVer(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** いまある手順書が、このコード（版 upTo・作り方 build）が作る物より「厳密に」新しいか */
export function isPlaybookNewerThanCode(
  existing: PlaybookStamp,
  code: { upTo: string; build: number },
): boolean {
  if (!existing || typeof existing !== "object") return false;
  const up = existing.rules_up_to;
  if (up == null || String(up).trim() === "") return false; // 版が無い＝古い手順書。守らない
  const c = cmpVer(up, code.upTo);
  if (c > 0) return true;
  if (c < 0) return false;
  const b = Number(existing.build_v) || 0;
  return b > code.build;
}

/** 手順書の候補の中から一番新しい物を選ぶ（版 → 作り方の版・同じなら先に出た物＝新しい行を先に渡す前提）。無ければ null */
export function pickNewestPlaybook<T extends PlaybookStamp>(candidates: T[]): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const up = (c as { rules_up_to?: unknown }).rules_up_to;
    if (up == null || String(up).trim() === "") continue;
    if (!best) { best = c; continue; }
    const k = cmpVer(up, (best as { rules_up_to?: unknown }).rules_up_to);
    if (k > 0 || (k === 0 && (Number((c as { build_v?: unknown }).build_v) || 0) > (Number((best as { build_v?: unknown }).build_v) || 0))) best = c;
  }
  return best;
}
