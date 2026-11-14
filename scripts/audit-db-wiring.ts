/**
 * 総合点検: DB連携が**本当に**通っているか（送る→入る→読む→使う の4段を1つずつ）
 *
 * 竹内さん「ちゃんとデータベースとの連携ができているのか。この点も強化するのと補強する。そして強化する」
 *
 * 実行: npx tsx scripts/audit-db-wiring.ts
 */
void (async () => {
  const BASE = "https://sumora-ai-ui.vercel.app";
  type R = Record<string, unknown>;
  const getJson = async (p: string): Promise<{ status: number; j: R }> => {
    const r = await fetch(BASE + p, { cache: "no-store" });
    return { status: r.status, j: (await r.json().catch(() => ({}))) as R };
  };

  console.log("=== ① 送る（拡張 → サーバー）");
  const shots = await getJson("/api/human-motion?shots=1&days=14&limit=2000");
  const rows = (shots.j.rows ?? []) as R[];
  console.log("  /api/human-motion?shots=1 →", shots.status, "／行:", rows.length);  if (rows[0]) {
    const k = Object.keys(rows[0]);
    console.log("  返す列:", k.join(", "));
    const need = ["shot_url", "shot_ops", "mode", "created_at", "site"];
    for (const n of need) console.log(`    ${n}: ${k.includes(n) ? "✓" : "✗ 返していない"}`);
  }
  const withUrl = rows.filter((x) => x.shot_url);
  const withOps = rows.filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).length > 0);
  console.log(`  写真URLあり: ${withUrl.length}/${rows.length} ／ ops あり: ${withOps.length}/${rows.length}`);
  const byMode = new Map<string, number>();
  for (const r of rows) {
    const m = String(r.mode ?? "").trim() || "(空)";
    byMode.set(m, (byMode.get(m) ?? 0) + 1);
  }
  console.log("  mode:", JSON.stringify(Object.fromEntries(byMode)));

  console.log("\n=== ② 入る（DBの列）");
  const cols = ["shot_ops", "shot_learn", "shot_b64", "field_order", "fields", "point_fields", "gap_ms", "mode"];
  // 列の有無は /api/human-motion?summary=1 では分からないので、shots の返す列と profile の dropped_cols で見る
  const prof = await getJson("/api/human-learn-profile?touch=0&fresh=1");
  const pb = (prof.j.bundle ?? {}) as R;
  console.log("  /api/human-learn-profile →", prof.status, "／元にした記録:", prof.j.source_rows);
  console.log("  dropped_cols:", JSON.stringify(pb.dropped_cols ?? null), "（空なら全部読めた）");
  console.log("  列の点検は scripts/check-db-columns.ts で個別に確認できる");

  console.log("\n=== ③ 読む（学習の束）");
  const need2: Array<[string, unknown]> = [
    ["next（押す順番）", Object.keys((pb.next as object) ?? {}).length],
    ["points（押す場所）", Object.keys((pb.points as object) ?? {}).length],
    ["screen_flow（画面ごとの手順）", Object.keys((pb.screen_flow as object) ?? {}).length],
    ["sequence_flow（一連の動き）", ((pb.sequence_flow as R)?.sequence as unknown[] ?? []).length],
    ["by_mode（モード別）", Object.keys((pb.by_mode as object) ?? {}).length],
    ["mode_counts", JSON.stringify(pb.mode_counts ?? null)],
    ["learn_plan（統括）", pb.learn_plan ? "あり" : "なし"],
    ["weak（弱い所）", ((pb.weak as unknown[]) ?? []).length],
    ["shots", JSON.stringify(pb.shots ?? null)],
  ];
  for (const [k, v] of need2) console.log(`  ${k}: ${typeof v === "number" ? (v > 0 ? "✓ " : "⚠ ") : ""}${v}`);

  console.log("\n=== ④ 使う（拡張が読むキー）");
  const learn = await getJson("/api/human-learn-profile?touch=0");
  const lb = (learn.j.bundle ?? {}) as R;
  const keys: Array<[string, boolean]> = [
    ["axlx_learn_next ← next", Object.keys((lb.next as object) ?? {}).length > 0],
    ["axlx_learn_points ← points", Object.keys((lb.points as object) ?? {}).length > 0],
    ["axlx_learn_seq ← sequence_flow", !!lb.sequence_flow],
    ["axlx_learn_by_mode ← by_mode", !!lb.by_mode],
    ["axlx_learn_plan ← learn_plan", !!lb.learn_plan],
    ["axlx_learn_screen_flow ← screen_flow", !!lb.screen_flow],
  ];
  for (const [k, ok] of keys) console.log(`  ${ok ? "✓" : "⚠"} ${k}`);

  console.log("\n=== ⑤ 点検の記録（search_audits）");
  const au = await getJson("/api/search-audits?limit=5&days=3");
  console.log("  実行:", au.j.runs_window, "／原因の種類:", ((au.j.causes as unknown[]) ?? []).length);

  console.log("\n=== ⑥ まとめ（足りない所）");
  const issues: string[] = [];
  if (!withOps.length) issues.push("写真に ops（操作）が付いていない");
  const modeEmpty = rows.filter((r) => !String(r.mode ?? "").trim()).length;
  if (modeEmpty > 0) issues.push(`mode が空の記録が ${modeEmpty}件（旧版・新しい録画で埋まる）`);
  if (!Object.keys((lb.sequence_flow as object) ?? {}).length) issues.push("sequence_flow（一連の動き）が空");
  if (!lb.mode_counts) issues.push("mode_counts が無い");
  if (!Object.keys((lb.next as object) ?? {}).length) issues.push("next（押す順番）が空");
  if (!pb.learn_plan) issues.push("learn_plan（統括の判断）が無い");

  /**
   * 2026-11-14 竹内さん「ちゃんとデータベースとの連携ができているのか。この点も強化するのと補強する」:
   *   **静かに止まる**（記録が届かない・学習が更新されない）を機械で見張る。
   *   ・最新の記録が何日前か
   *   ・学習の束が何日前に作られたか
   */
  const newest = rows.reduce((m, r) => Math.max(m, Date.parse(String(r.created_at ?? 0)) || 0), 0);
  const ageDays = newest ? Math.round((Date.now() - newest) / 86400_000) : null;
  console.log(`\n=== ⑦ 新しさ`);
  console.log(`  最新の記録: ${newest ? new Date(newest).toISOString().slice(0, 19) + "（" + ageDays + "日前）" : "なし"}`);

  const fatal: string[] = [];
  if (shots.status !== 200) fatal.push("/api/human-motion が " + shots.status);
  if (prof.status !== 200) fatal.push("/api/human-learn-profile が " + prof.status);
  if (Array.isArray(pb.dropped_cols) && (pb.dropped_cols as unknown[]).length) {
    fatal.push("DBに無い列がある: " + (pb.dropped_cols as unknown[]).join(","));
  }
  if (!Object.keys((lb.next as object) ?? {}).length && Number(prof.j.source_rows) > 50) {
    fatal.push("記録はあるのに押す順番が0（学習が動いていない）");
  }
  /** 4日以上新しい記録が無い＝録画も検索もしていないか、送信が止まっている */
  if (ageDays != null && ageDays >= 4) {
    issues.push(`最新の記録が ${ageDays}日前（録画・送信が止まっている可能性）`);
  }

  for (const s of issues) console.log("  ⚠ " + s);
  if (fatal.length) {
    console.log("\n  🔴 致命的:");
    for (const s of fatal) console.log("    " + s);
    console.log("\n  結果: NG（終了コード 1）");
    process.exit(1);
  }
  console.log("\n  結果: OK（連携は通っています）");
  if (!issues.length) console.log("  足りない所はありません");
  else console.log("  ↑ は経過（新しい録画で埋まります）");
})();
