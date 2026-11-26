/**
 * 手順書の「廃止された手順」を見張る（純関数・DOM無し）
 *   2026-11-26 竹内さん「改善の際に手順書のずれを確認して細かく改善する仕組みが弱いのでは」→「順に改善」。
 *
 *   ・B: 通常の手順として「1つずつ外す」を書いていないか（保険だと断っていない文は NG）
 *   ・D: 新しい決まり（リセットで外しを置き換える・2.8.305）より古い決まりで、リセットに触れず外しの手順だけ書いている物を出す
 *
 *   ⚠ 「前に貼り足して断る」は直したことにならない（本文が古いまま残る）。本文そのものを書き直す。
 */

/** 通常の手順としては書いてはいけない、1つずつ外す系の言い回し */
export const RETIRED_STEP_RE = /1つずつカーソルで外す|1つずつ外す|箱を開ける|箱ごとに開ける|外し忘れ1つずつ|外し→きれい/;
/** 保険（リセットが押せない時だけ）と断っている言い方 */
export const FALLBACK_QUAL_RE = /保険|reset_fallback|押せない|空にならない/;
/** 「外さない・使わない」と否定している文は、古い手順の説明ではない */
export const NEGATED_RE = /外さない|使わない|使わず|行わない|行わず/;
/** 「以下は…代わりの手順」という後付けの断り（貼り足しの型）は使わない */
export const BANNED_PREFIX_RE = /以下は[^。]{0,40}代わりの手順/;
/** リセットで外しを置き換えた版（reset_replaces_clear の since） */
export const RESET_SUPERSEDE_SINCE = "2.8.305";
/** 外しの手順を書いている言い方（リセットより古い決まりに多い） */
export const DRIFT_WORD_RE = /(前のお客さん|前客)[^。]{0,12}外し|1つずつカーソル|箱を開ける|箱ごとに開ける/;

/** 版の大小（2.8.305 のような並び）。a<b なら負 */
export function cmpVer(a: string, b: string): number {
  const pa = String(a).split(".").map((x) => Number(x) || 0);
  const pb = String(b).split(".").map((x) => Number(x) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** B: 通常の手順として1つずつ外すを書いている文を出す（空＝問題なし） */
export function retiredPhraseIssues(items: ReadonlyArray<{ where: string; text: string }>): string[] {
  const out: string[] = [];
  for (const it of items) {
    const text = String(it.text || "");
    if (BANNED_PREFIX_RE.test(text)) {
      out.push(`${it.where}: 「以下は…代わりの手順」という後付けの断りが残っている（本文を書き直す）`);
    }
    for (const s of text.split(/[。\n]/)) {
      if (!RETIRED_STEP_RE.test(s)) continue;
      if (FALLBACK_QUAL_RE.test(s) || NEGATED_RE.test(s)) continue;
      out.push(`${it.where}: 「${s.trim().slice(0, 40)}…」を通常の手順として書いている（保険・押せない時だけと断る）`);
    }
  }
  return out;
}

/** D: リセットより古い決まりで、リセットに触れず外しの手順だけ書いている物（空＝ずれ無し） */
export function driftFlags(
  rules: ReadonlyArray<{ id: string; scene: string; since: string | null; text: string }>,
): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (!r.since || cmpVer(r.since, RESET_SUPERSEDE_SINCE) >= 0) continue;
    if (!DRIFT_WORD_RE.test(r.text)) continue;
    if (/リセット/.test(r.text)) continue;
    out.push(`${r.id}（since ${r.since}・場面 ${r.scene}）: 外しの手順がリセット（${RESET_SUPERSEDE_SINCE}）と食い違う疑い`);
  }
  return out;
}
