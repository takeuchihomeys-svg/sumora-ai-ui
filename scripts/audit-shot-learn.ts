/**
 * 写真から学習できているかを点検（2026-11-14 竹内さん「データベースの写真から学習する」）
 * 実行: npx tsx scripts/audit-shot-learn.ts
 */
type ShotRec = Record<string, unknown>;

void (async () => {
  const url = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
  const r = await fetch(url + "/api/human-motion?shots=1&limit=200");
  const j = (await r.json()) as { rows?: ShotRec[]; cols?: string[]; dropped_cols?: string[] } | ShotRec[];
  const rows = (Array.isArray(j) ? j : (j.rows ?? [])) as ShotRec[];
  if (!Array.isArray(j)) console.log("cols:", (j.cols ?? []).join(","), "/ dropped:", JSON.stringify(j.dropped_cols ?? null));
  console.log(`写真のある行: ${rows.length}行`);

  const withOps = rows.filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).length > 0);
  const withLearn = rows.filter((x) => !!x.shot_learn);
  const withUrl = rows.filter((x) => typeof x.shot_url === "string" && String(x.shot_url).length > 10);
  const withPf = rows.filter((x) => x.point_fields && typeof x.point_fields === "object");
  console.log(`  操作の並び（shot_ops）あり: ${withOps.length}行`);
  console.log(`  写真から読んだ種類（shot_learn）あり: ${withLearn.length}行`);
  console.log(`  押した欄（point_fields）あり: ${withPf.length}行`);
  console.log(`  見られる URL あり: ${withUrl.length}行`);

  const byVer: Record<string, number> = {};
  for (const x of rows) { const v = String(x.ext_version ?? "").trim() || "(空)"; byVer[v] = (byVer[v] ?? 0) + 1; }
  console.log("  版:", JSON.stringify(byVer));

  console.log("\n=== いちばん新しい写真つきの行 ===");
  const n = rows[0];
  if (n) {
    console.log(`  時刻: ${String(n.created_at)} / 版 ${String(n.ext_version)} / mode ${String(n.mode)}`);
    console.log(`  shot_key: ${String(n.shot_key)}`);
    console.log(`  URL: ${String(n.shot_url).slice(0, 90)}`);
    const ops = Array.isArray(n.shot_ops) ? (n.shot_ops as ShotRec[]) : [];
    console.log(`  shot_ops: ${ops.length}件`);
    for (const o of ops.slice(-10)) console.log(`     ${String(o.k ?? "")} ${String(o.f ?? "")} w=${String(o.w ?? "-")}`);
    const pf = n.point_fields as Record<string, ShotRec> | null;
    if (pf) {
      const keys = Object.keys(pf);
      console.log(`  point_fields: ${keys.length}件 → ${keys.slice(0, 8).join(", ")}`);
    }
    const sl = n.shot_learn as ShotRec | null;
    if (sl) console.log("  shot_learn:", JSON.stringify(sl).slice(0, 400));
    else console.log("  shot_learn: 無し（写真をまだ読んでいない）");
  }

  console.log("\n=== 写真はあるが操作の並びが無い行（＝写真と押した欄からしか学べない） ===");
  const onlyShot = rows.filter((x) => !(Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).length > 0));
  console.log(`  ${onlyShot.length}行 / ${rows.length}行`);
  const both = onlyShot.filter((x) => x.point_fields && typeof x.point_fields === "object");
  console.log(`  そのうち押した欄（point_fields）がある: ${both.length}行 ← ここから学べる`);
})();
