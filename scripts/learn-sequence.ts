/**
 * 写真を「時間順」に並べて、画面が変わった瞬間だけ抜き出す（2026-11-14 竹内さん）
 *
 * 竹内さん「時間でみたらよい最大７分の録画なので順番に見れば理解できる」
 *   → URL や run_id ではなく**時刻**でまとめる（録画は最大7分）。
 *     7分以上あいたら別の回。その中で「画面が大きく変わった瞬間」だけ抜き出して
 *     1枚ずつ並べれば、**押した場所と押し方が順番に分かる**。
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/learn-sequence.ts                 # 直近1日
 *   npx tsx --env-file=.env.local scripts/learn-sequence.ts --days=2 --runs=2
 *   npx tsx --env-file=.env.local scripts/learn-sequence.ts --out=.tmp-seq   # 抜き出した絵を保存
 *
 * ⚠ 見るのは**画面の明るさの並び**だけ（文字・物件名は読まない・費用0）。Vision AI は使わない。
 * ⚠ 保存するのは点検用の一時ファイル（リポジトリには入れない）。
 */
import fs from "node:fs";
import path from "node:path";
import { hashImage, framesDiffer, type FrameHash } from "../app/lib/learn-from-images";

const BASE = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
const args = process.argv.slice(2);
const argOf = (k: string, d: number) => {
  const v = (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "");
  return v ? Number(v) : d;
};
const days = argOf("days", 1);
const maxRuns = argOf("runs", 3);
const maxFrames = argOf("frames", 14);
const outDir = (args.find((a) => a.startsWith("--out=")) || "").replace("--out=", "") || ".tmp-seq";

type Row = Record<string, unknown>;

/** 録画の切れ目（これを超えて空いたら別の回）。竹内さん「最大7分の録画」 */
const RUN_GAP_MS = 7 * 60_000;

void (async () => {
  const r = await fetch(`${BASE}/api/human-motion?shots=1&limit=1000&days=${days}`, { cache: "no-store" });
  if (!r.ok) { console.log("写真の一覧を取れません: http_" + r.status); process.exitCode = 1; return; }
  const j = (await r.json()) as { rows?: Row[] };
  const rows = (j.rows ?? []).filter((x) => typeof x.shot_url === "string" && String(x.shot_url).length > 10);
  rows.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  console.log(`写真: ${rows.length}枚（${days}日・時刻順）`);

  // ── 時刻でまとめる（7分あいたら別の回）──
  const runs: Row[][] = [];
  let cur: Row[] = [];
  let lastT = 0;
  for (const x of rows) {
    const t = Date.parse(String(x.created_at ?? ""));
    if (!Number.isFinite(t)) continue;
    if (lastT && t - lastT > RUN_GAP_MS) { if (cur.length) runs.push(cur); cur = []; }
    cur.push(x); lastT = t;
  }
  if (cur.length) runs.push(cur);

  const jst = (iso: unknown) => {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? new Date(t + 9 * 3600_000).toISOString().slice(11, 19) : "-";
  };
  const dur = (g: Row[]) => {
    const a = Date.parse(String(g[0]?.created_at ?? ""));
    const b = Date.parse(String(g[g.length - 1]?.created_at ?? ""));
    return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 1000) : 0;
  };
  console.log(`録画のまとまり: ${runs.length}回（7分あいたら別の回）`);
  for (const g of runs.slice(-maxRuns)) {
    console.log(`  ${jst(g[0].created_at)}〜${jst(g[g.length - 1].created_at)}  ${g.length}枚・${dur(g)}秒`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const targets = runs.slice(-maxRuns);

  for (let ri = 0; ri < targets.length; ri++) {
    const g = targets[ri];
    console.log(`\n${"=".repeat(64)}`);
    console.log(`■ 回 ${ri + 1}/${targets.length}  ${jst(g[0].created_at)}〜${jst(g[g.length - 1].created_at)}  ${g.length}枚・${dur(g)}秒`);

    // 全部の指紋を作る（6枚ずつ並行）
    type F = { row: Row; at: string; hash: FrameHash | null; buf: Buffer | null };
    const frames: F[] = [];
    const PARALLEL = 6;
    for (let i = 0; i < g.length; i += PARALLEL) {
      const chunk = g.slice(i, i + PARALLEL).map(async (x): Promise<F> => {
        try {
          const ir = await fetch(String(x.shot_url), { cache: "no-store" });
          if (!ir.ok) return { row: x, at: String(x.created_at ?? ""), hash: null, buf: null };
          const buf = Buffer.from(await ir.arrayBuffer());
          return { row: x, at: String(x.created_at ?? ""), hash: await hashImage(buf), buf };
        } catch { return { row: x, at: String(x.created_at ?? ""), hash: null, buf: null }; }
      });
      for (const p of await Promise.all(chunk)) frames.push(p);
    }
    frames.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    // 画面が変わった瞬間を拾う（1枚目は必ず入れる）
    const picks: Array<{ i: number; why: string }> = [];
    if (frames.length) picks.push({ i: 0, why: "最初" });
    for (let i = 1; i < frames.length; i++) {
      if (framesDiffer(frames[i - 1].hash, frames[i].hash)) picks.push({ i, why: "画面が変わった" });
    }
    // 変化が多すぎる時は等間隔に間引く（最大 maxFrames 枚）
    let chosen = picks;
    if (picks.length > maxFrames) {
      const step = (picks.length - 1) / (maxFrames - 1);
      chosen = Array.from({ length: maxFrames }, (_, k) => picks[Math.round(k * step)]);
      chosen = chosen.filter((v, i, a) => a.findIndex((z) => z.i === v.i) === i);
    }
    console.log(`  画面が変わった: ${picks.length - 1}回 ／ 抜き出す: ${chosen.length}枚`);

    for (let k = 0; k < chosen.length; k++) {
      const { i, why } = chosen[k];
      const f = frames[i];
      const name = `run${ri + 1}_${String(k + 1).padStart(2, "0")}_${jst(f.at).replace(/:/g, "")}.jpg`;
      const p = path.join(outDir, name);
      if (f.buf) fs.writeFileSync(p, f.buf);
      const ops = Array.isArray(f.row.shot_ops) ? (f.row.shot_ops as Array<Record<string, unknown>>) : [];
      const real = ops.filter((o) => o && o.k !== "diag");
      const label = real.length
        ? real.slice(-3).map((o) => `${String(o.k)})${String(o.f ?? "?")}`).join(" → ")
        : "(操作の記録なし)";
      console.log(`  ${String(k + 1).padStart(2, "0")} ${jst(f.at)}  ${why}  ${name}  ${label}`);
    }
    console.log(`  保存先: ${path.resolve(outDir)}`);
  }
})();
