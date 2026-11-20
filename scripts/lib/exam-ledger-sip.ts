// 2026-11-21 作業員H（統括役の頼み・G の #448 の比べ）: 試験の写しの「送った資料の読み」（sent_image_properties）の行の選び方と除き方。
//   G が本番に過去の 190行（source=aix_log:<種類>・created_at は元の送信の時刻）を足した。SENT_IMAGE_AIX_ATTRIBUTE は送信（send-line-message）の中だけで動く
//   ＝試験でスイッチを on にしても何も変わらない。測るのは「足した行がブレインに届いて答えが変わるか」＝同じ写しで、前は G の行を除き・今は含める。
//   - EXAM_LEDGER_SIP_EXCLUDE=aix_log（, 区切り・source の頭）: 借りた会話に入れる時に、その source の行を除く（前・今の両方に効く）
//   - EXAM_LEDGER_SIP_BASE_EXCLUDE=aix_log: 前（main の子）だけに EXAM_LEDGER_SIP_EXCLUDE を渡す（今は含める）＝1本の依頼で「除いた写し／含めた写し」を比べる
//   - 写しを作る時の上限（40行）: aix_log の行が入ると古い行が押し出される（q057 系で 1〜2行）＝前と今で他の行まで違ってしまう。
//     → 写しは「aix_log 以外の新しい 40行」＋「その範囲の aix_log の行」にする（除いた時に前と今の他の行が同じになる）
export type SipLedgerRow = { ago: number; row: Record<string, unknown> };

/** 除く source の頭（空＝除かない） */
export function sipExcludePrefixes(v: string | undefined): string[] {
  return String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** source がどれかの頭で始まるか（"aix_log" は "aix_log:property_check_result" に当たる） */
export function sipSourceExcluded(source: unknown, prefixes: string[]): boolean {
  if (!prefixes.length || typeof source !== "string") return false;
  return prefixes.some((p) => source === p || source.startsWith(`${p}:`) || (p.endsWith(":") && source.startsWith(p)));
}

/** 借りた会話に入れる前に除く */
export function filterSipRows<T extends SipLedgerRow>(rows: T[], prefixes: string[]): { kept: T[]; dropped: number } {
  const kept = rows.filter((r) => !sipSourceExcluded(r.row.source, prefixes));
  return { kept, dropped: rows.length - kept.length };
}

/** 新しい順の行から写しを選ぶ: 頭に当たらない行は limit まで・頭に当たる行（後から足した行）は、選んだ他の行の範囲（一番古い行より新しい）なら全部 */
export function pickSipRowsDesc<T extends Record<string, unknown>>(rowsDesc: T[], limit: number, extraPrefixes: string[], timeCol = "created_at"): T[] {
  const base: T[] = [];
  for (const r of rowsDesc) { if (!sipSourceExcluded(r.source, extraPrefixes)) { if (base.length < limit) base.push(r); } }
  const full = base.length < limit; // 他の行が上限に届かない＝古い方まで全部入っている
  const oldest = base.length ? Date.parse(String(base[base.length - 1][timeCol])) : -Infinity;
  return rowsDesc.filter((r) => base.includes(r) || (sipSourceExcluded(r.source, extraPrefixes) && (full || Date.parse(String(r[timeCol])) >= oldest)));
}

/** 前（main の子）に渡す除き（EXAM_LEDGER_SIP_BASE_EXCLUDE）。無ければ null */
export function sipBaseExcludeOf(env: Record<string, string | undefined>): string | null {
  const v = sipExcludePrefixes(env.EXAM_LEDGER_SIP_BASE_EXCLUDE).join(",");
  return v || null;
}
