/**
 * 「記録と写真で欄の種類が違う」の正体を見る（2026-11-14）
 *   竹内さん「これでちゃんと学習して反映して強化はされていっているのか」
 * 実行: npx tsx scripts/audit-weak-photo.ts
 */
type R = Record<string, unknown>;

void (async () => {
  const url = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
  const r = await fetch(url + "/api/human-motion?recent=1&limit=200&days=3");
  const j = (await r.json()) as { rows?: R[]; dropped_cols?: string[] } | R[];
  const rows = (Array.isArray(j) ? j : (j.rows ?? [])) as R[];
  if (!Array.isArray(j)) console.log("dropped:", JSON.stringify(j.dropped_cols ?? null));
  console.log(`記録: ${rows.length}行`);

  console.log("\n=== 同じ欄で「記録(点)の種類」と「写真(shot_learn)の種類」が違う物 ===");
  const diffs = new Map<string, { point: string; photo: string; n: number }>();
  let withShotLearn = 0;
  for (const x of rows) {
    const sl = x.shot_learn as R | null;
    const pf = x.point_fields as Record<string, R> | null;
    if (!sl) continue;
    withShotLearn++;
    const fields = Array.isArray(sl.fields) ? (sl.fields as R[]) : [];
    if (!pf) continue;
    for (const f of fields) {
      const nm = String(f.name ?? "");
      const pk = String(f.kind ?? "");
      const pv = pf[nm];
      if (!pv) continue;
      const wk = String(pv.w ?? "");
      if (!pk || !wk) continue;
      if (pk === wk) continue;
      const key = nm + "|" + wk + "|" + pk;
      const cur = diffs.get(key) ?? { point: wk, photo: pk, n: 0 };
      cur.n += Number(pv.n) || 1;
      diffs.set(key, cur);
    }
  }
  console.log(`  shot_learn がある記録: ${withShotLearn}行`);
  if (!diffs.size) console.log("  → 実際には1件も違っていません（統括の『弱い所』が古い記録を見ています）");
  for (const [k, v] of [...diffs.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) {
    console.log(`  ${k.split("|")[0]} … 記録=${v.point} / 写真=${v.photo}（${v.n}回）`);
  }

  console.log("\n=== shot_learn がある記録の版 ===");
  const byVer: Record<string, number> = {};
  for (const x of rows) {
    if (!x.shot_learn) continue;
    const v = String(x.ext_version ?? "").trim() || "(空)";
    byVer[v] = (byVer[v] ?? 0) + 1;
  }
  console.log(" ", JSON.stringify(byVer));
})();
