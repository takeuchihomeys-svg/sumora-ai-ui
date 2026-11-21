/**
 * 画像の読みの目の監査（種類を問わず使う純関数・2026-11-21 作業員G・台帳 #510＝#505 の子）
 *
 * 型: 読み（reads）＝ { id, read, ref? }。read は "ok"（有る・当たり）/"ng"（無い）/"unknown"（分からない）か、値の文字（物件名など）。
 *     正解（truth）＝ id → 目で見た値（同じ語彙・"unknown" は目でも決められない）。
 * 決まり:
 *   - 読みが「分からない」は誤りに数えない（作らないのが正しい）。目でも決められない物も数えない
 *   - 値の文字は NFKC・空白を除いて比べる
 *   - 判定に使ってよい（ready）＝誤り 0 かつ正しい件数が minRight（既定 20）以上
 */

export type AuditRead = { id: string; read: string | null; ref?: string | null };
export type AuditTruth = Record<string, string>;
export type AuditReport = {
  total: number; judged: number; right: number; wrong: number; unknown: number; notJudged: number; undecidable: number;
  wrongIds: Array<{ id: string; read: string; truth: string }>;
  ready: boolean; minRight: number;
};

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const isUnknown = (s: string | null | undefined) => s == null || s === "" || s === "unknown" || s === "null";

export function auditReport(reads: ReadonlyArray<AuditRead>, truth: AuditTruth, minRight = 20): AuditReport {
  // 同じ id を何度も読んだ時は最後の読みを使う
  const last = new Map<string, AuditRead>();
  for (const r of reads) last.set(String(r.id), r);
  const r0: AuditReport = { total: last.size, judged: 0, right: 0, wrong: 0, unknown: 0, notJudged: 0, undecidable: 0, wrongIds: [], ready: false, minRight };
  for (const [id, r] of last) {
    const t = truth[id];
    if (t === undefined) { r0.notJudged++; continue; }
    if (isUnknown(r.read)) { r0.unknown++; continue; }
    if (isUnknown(t)) { r0.undecidable++; continue; }
    r0.judged++;
    if (norm(String(r.read)) === norm(t)) r0.right++;
    else { r0.wrong++; r0.wrongIds.push({ id, read: String(r.read), truth: t }); }
  }
  r0.ready = r0.wrong === 0 && r0.right >= minRight;
  return r0;
}

/** --judge=<id>:<値>,... を読む（値に「,」は使えない） */
export function parseJudgeArg(arg: string): Array<{ id: string; value: string }> {
  return String(arg ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(":");
    if (i <= 0) throw new Error(`形が違う: ${p}（<id>:<値>）`);
    return { id: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
  });
}

/** 台帳（work_item_events の note）に残す1行 */
export function auditLedgerNote(topic: string, r: AuditReport): string {
  return `目の監査 ${topic}: 読み ${r.total}・正しい ${r.right}・誤り ${r.wrong}・分からない ${r.unknown}・目でも決められない ${r.undecidable}・まだ見ていない ${r.notJudged}`
    + `${r.wrongIds.length ? `・誤りの id ${r.wrongIds.slice(0, 8).map((w) => w.id).join(",")}` : ""}`
    + `・${r.ready ? `判定に使ってよい（誤り0・正しい ${r.right}≥${r.minRight}）` : `まだ使わない（誤り0かつ正しい ${r.minRight}件以上が要る）`}`;
}
