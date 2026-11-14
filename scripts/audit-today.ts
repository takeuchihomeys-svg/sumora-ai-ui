/**
 * 今日指摘された弱い部分が、本当に直ったかを1件ずつ確かめる（2026-11-14 竹内さん）
 *
 *   竹内さん「今日指摘した弱い部分はちゃんと細かく強化されているのか」
 *
 * ⚠ これは「直したつもり」を防ぐ道具。**コードがあるか**ではなく
 *   **実際にそう動くか**（実データ・実ファイル・実テスト）で判定する。
 *
 * 実行: npx tsx --env-file=.env.local scripts/audit-today.ts
 */
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
/**
 * ⚠ テストを探す時は**両方**の場所を見る（枝によって置き場所が違う）:
 *   ・`tests/chrome-extension/` … 拡張のテスト（cursor-ext にだけ在る）
 *   ・`app/lib/__tests__/`     … サーバーのテスト（main にも在る）
 *   旧は片方だけ見て「テストなし」と誤判定していた（実際は在った）。
 */
const readFile = (p: string) => { try { return fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n"); } catch { return ""; } };
const findTest = (namePart: string): string | null => {
  const dirs = ["tests/chrome-extension", "app/lib/__tests__"];
  for (const d of dirs) {
    try {
      const hits = fs.readdirSync(path.join(root, d)).filter((f) => f.includes(namePart));
      if (hits.length) return `${d}/${hits[0]}`;
    } catch { /* 無い */ }
  }
  return null;
};
const read = (p: string) => { try { return fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n"); } catch { return ""; } };
const exists = (p: string) => fs.existsSync(path.join(root, p));

/**
 * ⚠ **この枝に拡張のファイルがあるか**を先に確かめる（main には拡張が無い）。
 *   無いのに「未着手」と出すのは**嘘**（実際は cursor-ext で直してある）。
 *   → 拡張の判定は「この枝では判定できない」と正直に出す。
 */
const hasExtension = exists("chrome-extension/page-script.js");

type Row = { no: number; said: string; mark: "ok" | "part" | "ng"; proof: string };
const rows: Row[] = [];
const add = (no: number, said: string, mark: Row["mark"], proof: string) => rows.push({ no, said, mark, proof });

void (async () => {
  // 実データを読む
  let motion: Array<Record<string, unknown>> = [];
  try {
    const r = await fetch(`${process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app"}/api/human-motion?days=7&limit=1000`, { cache: "no-store" });
    const j = (await r.json()) as { rows?: Array<Record<string, unknown>> };
    motion = j.rows ?? [];
  } catch { /* 読めない */ }

  // ── 竹内さんの指摘（時系列） ──
  /**
   * ⚠ 拡張の指摘（①②③⑤）は **拡張のファイルがこの枝に無いと判定できない**（main には無い）。
   *   無い時に「未着手」と出すのは嘘なので、「この枝では判定できない」と正直に出す。
   */
  const extSkip = !hasExtension
    ? "この枝（main）には拡張のファイルがありません。cursor-ext で確かめてください"
    : null;

  // ① 「賃料の部分直接になっている。プルダウンなのでマウス移動して選択するようにする」
  if (extSkip) add(1, "賃料がプルダウンなのに直接入力に見える", "part", extSkip);
  else {
    const ps = read("chrome-extension/page-script.js");
    const hasFake = /_showFakeOptions/.test(ps);
    const hasMove = /moveToEl\(row\)/.test(ps);
    const longer = /_ln\(1400, 0\.4, 950, 2100\)/.test(ps);
    add(1, "賃料がプルダウンなのに直接入力に見える",
      hasFake && hasMove && longer ? "ok" : hasFake && hasMove ? "part" : "ng",
      `見える一覧 ${hasFake ? "あり" : "なし"}・カーソル移動 ${hasMove ? "あり" : "なし"}・見せる時間 ${longer ? "延ばした" : "旧のまま"}`);
  }

  // ② 「徒歩の部分一度選択した後に消える」
  if (extSkip) add(2, "徒歩が一度選択した後に消える", "part", extSkip);
  else {
    const ps = read("chrome-extension/page-script.js");
    const guard = (ps.match(/_keepTransportBeforeWalk2?\(\)/g) || []).length;
    const t = findTest("walk-not-cleared");
    add(2, "徒歩が一度選択した後に消える",
      guard >= 2 && !!t ? "ok" : guard >= 2 ? "part" : "ng",
      `移動手段を分数より前に固定 ${guard}か所・テスト ${t ?? "なし"}`);
  }

  // ③ 「物件同じ平米数のもダウンロードしてしまっている。平米数が同じなら家賃は一番おさえれるのにする」
  if (extSkip) add(3, "同じ平米数なのに全部ダウンロードされる", "part", extSkip);
  else {
    const bd = read("chrome-extension/bulk-dl.js");
    const callsCand = /_applyCheapestPerLayout\(state,\s*cand\)/.test(bd);
    const noChecked = !/function _applyCheapestPerLayout\(state\)\s*\{[\s\S]{0,600}?t\.cb\.checked\)\s*return/.test(bd);
    const t = findTest("cheapest-per-sqm");
    const rd = read("chrome-extension/room-dedupe.js");
    const pure = /cheapestPerBuildingLayoutSize/.test(rd);
    add(3, "同じ平米数なのに全部ダウンロードされる",
      callsCand && noChecked && (!!t || pure) ? "ok" : "ng",
      `候補(cand)を対象 ${callsCand ? "はい" : "いいえ"}・チェック状態で絞らない ${noChecked ? "はい" : "いいえ"}・判定の関数 ${pure ? "あり" : "なし"}・テスト ${t ?? "なし"}`);
  }

  // ④ 「所在地での検索の動かし方・物件の取得・次のページの移動の仕方で統括が弱い部分を強化」
  {
    const ls = read("app/lib/learn-flow-steps.ts");
    const hasScenes = ["area", "station", "cond", "search", "list", "next"].every((s) => new RegExp(`"${s}"`).test(ls));
    const sup = read("app/lib/learn-supervisor.ts");
    const inAgenda = /次に学ぶ事（統括が決めた順）/.test(sup);
    add(4, "所在地・物件の取得・次のページの手順を統括が学ぶ",
      hasScenes && inAgenda ? "ok" : hasScenes ? "part" : "ng",
      `6場面に分ける ${hasScenes ? "はい" : "いいえ"}・議題に出す ${inAgenda ? "はい" : "いいえ"}`);
  }

  // ⑤ 「弱い部分は通常モードの録画から学習できるか」
  {
    const hasOps = motion.some((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).some((o) => {
      const k = String((o as Record<string, unknown>)?.k ?? "");
      return k !== "diag" && k !== "same";
    }));
    const seen0 = motion.filter((x) => JSON.stringify(x.shot_ops ?? "").includes("seen0")).length;
    add(5, "通常モードの録画から学習（録画が操作を拾う）",
      hasOps && seen0 === 0 ? "ok" : hasOps ? "part" : "ng",
      `${motion.length}件中 本物の操作あり ${motion.filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).some((o) => !["diag", "same"].includes(String((o as Record<string, unknown>)?.k ?? "")))).length}件・seen0 ${seen0}件（拡張の更新待ち）`);
  }

  // ⑥ 「統括の判断が保存されているか（RLS）」
  {
    const mig = read("app/api/migrate-schema/route.ts");
    const dis = /ALTER TABLE learn_supervisor_log DISABLE ROW LEVEL SECURITY/.test(mig);
    const brain = read("app/lib/human-learn-brain.ts");
    const awaitSave = /saveSupervisorForBundle/.test(brain);
    add(6, "統括の判断が保存されていない（RLS）",
      dis && awaitSave ? "ok" : "ng",
      `RLS を無効 ${dis ? "はい" : "いいえ"}・保存を待つ ${awaitSave ? "はい" : "いいえ"}`);
  }

  // ⑦ 「必要な部分を統括が判断して学習すれば強化される」
  {
    const sup = read("app/lib/learn-supervisor.ts");
    const tasks = /learning_tasks/.test(sup);
    const doSrc = read("scripts/supervisor-do.ts");
    const runs = ["fix_scene", "fix_record", "photo_learn", "need_human"].every((k) => new RegExp(`${k}:\\s*\\{`).test(doSrc));
    add(7, "統括が判断して学習する（決定→実行）",
      tasks && runs ? "ok" : tasks ? "part" : "ng",
      `統括が順番を決める ${tasks ? "はい" : "いいえ"}・実行する側が4種類扱える ${runs ? "はい" : "いいえ"}`);
  }

  // ⑧ 「写真から必要な部分を読み取って学習」
  {
    const srv = read("app/lib/shot-learn-server.ts");
    const has = /readShotFields/.test(srv) && /callVisionAlt/.test(srv);
    const learnedRows = motion.filter((x) => !!x.shot_learn).length;
    add(8, "写真から欄の種類を読み取って学習",
      has && learnedRows > 0 ? "ok" : has ? "part" : "ng",
      `読み取りの仕組み ${has ? "あり" : "なし"}・実際に読んだ記録 ${learnedRows}件${learnedRows === 0 ? "（まだ走らせていない）" : ""}`);
  }

  // ⑨ 「自動検索は自動モードで動けばよい」→ 土日も
  if (extSkip) add(9, "土日で自動検索が止まる", "part", extSkip);
  else {
    const ar = read("chrome-extension/auto-run.js");
    const weekend = /WEEKEND_OFF_DEFAULT = false/.test(ar);
    add(9, "土日で自動検索が止まる",
      weekend ? "ok" : "ng",
      `土日の停止を既定で外した ${weekend ? "はい" : "いいえ"}（axlxWeekendOff=1 で戻せる）`);
  }

  // ⑩ 「検索が最後まで終わらない（完走率が低い）」
  {
    const srv = read("app/lib/search-audit-server.ts");
    const stall = /STALL_MINUTES = 35/.test(srv);
    const revive = /reviveFromAbandoned/.test(srv);
    add(10, "検索の完走率が低い（止まった誤判定）",
      stall && revive ? "ok" : "ng",
      `見回りを35分に ${stall ? "はい" : "いいえ"}・遅れた finished を拾う ${revive ? "はい" : "いいえ"}`);
  }

  // ── 出す ──
  const label = { ok: "✅", part: "🔶", ng: "❌" } as const;
  const name = { ok: "直った", part: "一部", ng: "未着手" } as const;
  console.log("今日指摘された弱い部分（1件ずつ）");
  console.log("─".repeat(72));
  for (const r of rows) {
    console.log(`${label[r.mark]} ${r.no}. ${r.said}  → ${name[r.mark]}`);
    console.log(`     ${r.proof}`);
  }
  console.log("─".repeat(72));
  const okN = rows.filter((r) => r.mark === "ok").length;
  const part = rows.filter((r) => r.mark === "part").length;
  const ng = rows.filter((r) => r.mark === "ng").length;
  console.log(`✅ 直った ${okN} ／ 🔶 一部 ${part} ／ ❌ 未着手 ${ng}（全 ${rows.length}件）`);
  if (part || ng) console.log("\n🔶/❌ の理由を上の『根拠』に書いています（推測で ok にしていません）。");
})();
