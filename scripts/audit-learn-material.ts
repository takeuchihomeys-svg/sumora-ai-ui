/** 学習の「材料」がどれだけ揃っているか（API 経由・RLS を避ける）
 *  実行: npx tsx scripts/audit-learn-material.ts
 *
 *  2026-11-14 竹内さん「材料が少ないからか」:
 *    ⚠ 旧は `?shots=1` の**最新200件だけ**を見ていた。写真のある行だけ・しかも直近の山だけなので、
 *      たまたま `points_n=0` の塊（06:45 の連写）を引くと **「押した欄 0件（100%）」** と出た（誤り）。
 *      実測（7日・8000行を頁で読む）: 押した欄あり 960件（12%）＝ `ops` と同じ割合で連動していた。
 *    → **頁で全部読む**（1回1000行・上限あり）・**写真の有無で分けて数える**（混ぜると原因を取り違える）。
 *  純関数ではなく点検の道具（DB は読むだけ・書き込まない）。 */
void (async () => {
  const url = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
  const days = Number(process.env.AUDIT_DAYS || 7);
  const MAX_PAGES = 12; // 1000行 × 12 = 12000行まで（PostgREST は1回1000行で切れる）

  type Row = Record<string, unknown>;
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetch(`${url}/api/human-motion?days=${days}&limit=1000&offset=${page * 1000}`);
    const j = (await r.json()) as { rows?: Row[] } | Row[];
    const got = (Array.isArray(j) ? j : (j.rows ?? [])) as Row[];
    rows.push(...got);
    if (got.length < 1000) break;
  }
  const N = rows.length;
  console.log(`API から読めた記録: ${N}行（直近 ${days}日・頁で全件）`);
  if (!N) { console.log("行が返りませんでした"); return; }

  const has = (v: unknown) => !!v && typeof v === "object" && Object.keys(v as object).length > 0;
  const hasOps = (x: Row) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).length > 0;
  const hasPf = (x: Row) => has(x.point_fields);
  const tookShot = (x: Row) => x.shot_taken === true;
  const cnt = (f: (r: Row) => boolean) => rows.filter(f).length;
  const pct = (n: number) => `${n}件（${Math.round((n / Math.max(1, N)) * 100)}%）`;

  console.log("\n=== ① 学習の材料が入っているか（全件） ===");
  console.log("  操作の並び（shot_ops）  :", pct(cnt(hasOps)));
  console.log("  押した欄（point_fields）:", pct(cnt(hasPf)));
  console.log("  写真から読んだ種類      :", pct(cnt((x) => !!x.shot_learn)));
  console.log("  押した数（points_n>0）  :", pct(cnt((x) => Number(x.points_n) > 0)));

  console.log("\n=== ② 写真の有無で分ける（混ぜると原因を取り違える） ===");
  const shot = rows.filter(tookShot);
  const noShot = rows.filter((x) => !tookShot(x));
  console.log(`  写真あり: ${shot.length}件 ／ 写真なし: ${noShot.length}件`);
  console.log(`    写真あり のうち操作あり: ${shot.filter(hasOps).length}件（${Math.round((shot.filter(hasOps).length / Math.max(1, shot.length)) * 100)}%）`);
  console.log(`    写真あり のうち押した欄あり: ${shot.filter(hasPf).length}件`);
  console.log(`    写真なし のうち操作あり: ${noShot.filter(hasOps).length}件`);
  console.log(`    写真なし のうち押した欄あり: ${noShot.filter(hasPf).length}件`);

  console.log("\n=== ③ モードの内訳 ===");
  const byMode: Record<string, number> = {};
  for (const x of rows) { const m = String(x.mode ?? "").trim() || "(空)"; byMode[m] = (byMode[m] ?? 0) + 1; }
  console.log("  " + JSON.stringify(byMode));

  console.log("\n=== ④ サイトの内訳 ===");
  const bySite: Record<string, number> = {};
  for (const x of rows) { const s = String(x.site ?? "").trim() || "(空)"; bySite[s] = (bySite[s] ?? 0) + 1; }
  console.log("  " + JSON.stringify(bySite));

  console.log("\n=== ⑤ 版の内訳 ===");
  const byVer: Record<string, number> = {};
  for (const x of rows) { const v = String(x.ext_version ?? "").trim() || "(空)"; byVer[v] = (byVer[v] ?? 0) + 1; }
  for (const [v, n] of Object.entries(byVer).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${v}: ${n}件`);

  console.log("\n=== ⑥ 学べない記録（原因を1つに絞る） ===");
  const opsMissing = cnt((x) => !hasOps(x));
  const pfMissing = cnt((x) => !hasPf(x));
  console.log(`  操作の並びが無い: ${opsMissing}件 → 「押す順番」を学べない`);
  console.log(`  押した欄が無い  : ${pfMissing}件 → 「押す位置」を学べない`);
  if (opsMissing > 0 && pfMissing > 0) {
    const both = cnt((x) => !hasOps(x) && !hasPf(x));
    console.log(`  　⚠ 両方無い: ${both}件（同じ記録なら原因は1つ＝記録の経路。別々に直さなくてよい）`);
  }
})();
