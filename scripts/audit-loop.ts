/**
 * 「強化されていく仕組み」が閉じているかを1回で見る（2026-11-14 竹内さん）
 *
 *   竹内さん「ちゃんと強化されていく仕組みとなっているか」
 *     「これで弱い部分みつけたら統括の部分が録画したところから学習して最善の改善できるようになっているか」
 *     「ちゃんとここの連携細かくできるようにする」
 *
 * 見る所（6つの輪が繋がっているか）:
 *   ① 記録   録画が操作を拾っているか（seen0 が消えたか）
 *   ② 材料   押した欄・順番がDBに入っているか
 *   ③ 判断   統括が場面ごとの手順を作れているか
 *   ④ 決定   統括が「次に学ぶ事」を決めているか
 *   ⑤ 実行   決定を実行できる形になっているか（コード側）
 *   ⑥ 確認   実行した結果を数字で確かめられるか
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/audit-loop.ts
 *   npx tsx --env-file=.env.local scripts/audit-loop.ts --days=7
 *
 * ⚠ 読むだけ（DBに書かない・サイトを触らない）。
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
const args = process.argv.slice(2);
const days = Number((args.find((a) => a.startsWith("--days=")) || "").replace("--days=", "")) || 7;

type Mark = "ok" | "warn" | "ng";
const rows: Array<{ no: number; name: string; mark: Mark; detail: string; next?: string }> = [];
const add = (no: number, name: string, mark: Mark, detail: string, next?: string) => rows.push({ no, name, mark, detail, next });

const root = path.join(__dirname, "..");
const read = (p: string) => { try { return fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n"); } catch { return ""; } };

void (async () => {
  // ── ① 記録（録画が操作を拾っているか） ──
  let motion: Array<Record<string, unknown>> = [];
  try {
    const r = await fetch(`${BASE}/api/human-motion?days=${days}&limit=1000`, { cache: "no-store" });
    const j = (await r.json()) as { rows?: Array<Record<string, unknown>> };
    motion = j.rows ?? [];
  } catch { /* 読めない */ }
  const withRealOps = motion.filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).some((o) => {
    const k = String((o as Record<string, unknown>)?.k ?? "");
    return k !== "diag" && k !== "same";
  }));
  const diagSeen0 = motion.filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).some((o) => {
    const w = String((o as Record<string, unknown>)?.why ?? "");
    return /seen0/.test(w);
  })).length;
  if (!motion.length) add(1, "記録（録画）", "ng", "記録が読めません");
  else if (withRealOps.length === 0) add(1, "記録（録画）", "ng", `${motion.length}件で本物の操作が0件（seen0 が ${diagSeen0}件）`, "拡張を更新して1回検索（2.7.49 で待つ形に直した）");
  else if (diagSeen0 > 0) add(1, "記録（録画）", "warn", `本物の操作 ${withRealOps.length}件・まだ seen0 が ${diagSeen0}件`, "拡張の版を確かめる（2.7.49 か）");
  else add(1, "記録（録画）", "ok", `本物の操作 ${withRealOps.length}件／${motion.length}件・seen0 なし`);

  // ── ② 材料（押した欄・順番） ──
  const withOrder = motion.filter((x) => Array.isArray(x.field_order) && (x.field_order as unknown[]).length > 0).length;
  const withPf = motion.filter((x) => x.point_fields && typeof x.point_fields === "object" && Object.keys(x.point_fields as object).length > 0).length;
  const junk = (() => {
    const names: Record<string, number> = {};
    for (const x of motion) {
      const list = Array.isArray(x.field_order) && (x.field_order as unknown[]).length
        ? (x.field_order as unknown[]).map(String)
        : Object.keys((x.point_fields as Record<string, unknown> | null) ?? {});
      for (const n of list) names[n] = (names[n] ?? 0) + 1;
    }
    return { img: names.img ?? 0, body: names.body ?? 0, total: Object.values(names).reduce((a, b) => a + b, 0) };
  })();
  if (withOrder + withPf === 0) add(2, "材料（欄・順番）", "ng", "順番も押した欄も0件", "①が直ってから増える（拡張の更新待ち）");
  else {
    const junkPct = junk.total ? Math.round(((junk.img + junk.body) / junk.total) * 100) : 0;
    const mark: Mark = junkPct >= 50 ? "warn" : "ok";
    add(2, "材料（欄・順番）", mark, `順番 ${withOrder}件・押した欄 ${withPf}件／${motion.length}件（img/body が ${junkPct}%）`,
      junkPct >= 50 ? "欄の名前がまだ img/body（2.7.49 で直した・拡張の更新待ち）" : undefined);
  }

  // ── ③ 判断（統括が場面ごとの手順を作れているか） ──
  let bundle: Record<string, unknown> = {};
  try {
    const r = await fetch(`${BASE}/api/human-learn-profile?fresh=1&scope=all&t=${Date.now()}`, { cache: "no-store" });
    const j = (await r.json()) as Record<string, unknown>;
    bundle = (j.bundle ?? j) as Record<string, unknown>;
  } catch { /* 読めない */ }
  const flows = Array.isArray(bundle.scene_flows) ? (bundle.scene_flows as Array<Record<string, unknown>>) : [];
  if (!flows.length) add(3, "判断（場面の手順）", "ng", "場面ごとの手順がありません", "search_audits.filled.ops に人の順番が入るか確かめる");
  else {
    const total = flows.reduce((a, f) => a + (Number(f.runs) || 0), 0);
    add(3, "判断（場面の手順）", "ok", `${flows.length}場面・合計 ${total}回の実測（止まる場面: ${String(bundle.stopped_scene || "－")}）`);
  }

  // ── ④ 決定（統括が次に学ぶ事を決めているか） ──
  const sup = (bundle.supervisor ?? {}) as Record<string, unknown>;
  const meeting = (sup.meeting ?? {}) as Record<string, unknown>;
  const tasks = Array.isArray(meeting.learning_tasks) ? (meeting.learning_tasks as Array<Record<string, unknown>>) : [];
  if (!tasks.length) add(4, "決定（次に学ぶ事）", "warn", "課題が出ていません（材料が足りている可能性）", "材料が少なければ出ます");
  else add(4, "決定（次に学ぶ事）", "ok", `${tasks.length}件: ${tasks.map((t) => String(t.kind)).join(" → ")}`);

  // ── ⑤ 実行（決定を実行できる形か・コード側） ──
  const doSrc = read("scripts/supervisor-do.ts");
  const handles = ["fix_scene", "fix_record", "photo_learn", "need_human"].filter((k) => new RegExp(`${k}:\\s*\\{`).test(doSrc));
  if (handles.length < 4) add(5, "実行（決定→実行）", "ng", `実行できる種類が ${handles.length}/4（${handles.join("・")}）`, "supervisor-do.ts に種類を足す");
  else add(5, "実行（決定→実行）", "ok", `4種類すべて実行できる（無料は自動・有料は --yes-cost・人は竹内さん）`);

  // ── ⑥ 確認（実行した結果を数字で見られるか） ──
  const hasImprove = !!read("app/lib/learn-improvements.ts");
  const hasTalk = !!read("scripts/supervisor-talk.ts");
  const saved = bundle.supervisor_saved as Record<string, unknown> | undefined;
  const savedOk = !!(saved && (saved.all as Record<string, unknown> | undefined)?.ok);
  if (!hasImprove || !hasTalk) add(6, "確認（数字で見る）", "ng", "確かめる道具が足りません");
  else if (!savedOk) add(6, "確認（数字で見る）", "warn", "統括の判断が保存されていません（RLS・投げっぱなし）", "scripts/check-supervisor-table.ts");
  else add(6, "確認（数字で見る）", "ok", "判断は保存済み・supervisor-talk / save-improvements で推移を見られる");

  // ── 出す ──
  const label: Record<Mark, string> = { ok: "✅", warn: "⚠️", ng: "❌" };
  console.log(`強化の輪（直近 ${days}日）`);
  console.log("─".repeat(70));
  for (const r of rows) {
    console.log(`${label[r.mark]} ${r.no}. ${r.name}`);
    console.log(`     ${r.detail}`);
    if (r.next && r.mark !== "ok") console.log(`     → ${r.next}`);
  }
  console.log("─".repeat(70));
  const ng = rows.filter((r) => r.mark === "ng").length;
  const warn = rows.filter((r) => r.mark === "warn").length;
  const okN = rows.filter((r) => r.mark === "ok").length;
  console.log(`✅ ${okN} ／ ⚠️ ${warn} ／ ❌ ${ng}`);
  if (ng) console.log("\n❌ が輪を止めています。上から直してください。");
  else if (warn) console.log("\n輪は繋がっています。⚠️ は「拡張の更新待ち」など時間が要る物です。");
  else console.log("\n輪は全部繋がっています。");
})();
