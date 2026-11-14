/**
 * 連続した録画画像から「押した所」と「動き」を学ぶ（2026-11-14 竹内さん）
 *
 *   竹内さん「一番直近で録画したのから動き方学ぶ
 *     連続して画像をみたらアニメーションのように動き理解できるので
 *     それで押したところ学ぶ」
 *
 * なぜ要るか（実測で分かった事）:
 *   ⚠ 学習の経路（`human-learn.js` の `guarded`）は **`isTrusted` だけ**を通す。
 *     つまり**拡張が押した操作は学習に一切入らない**（`field_order` が 0件の本当の理由）。
 *   ⚠ だが**写真は撮れている**（1時間で数百枚・`run_<run_id>` でまとまっている）。
 *   → **写真の並び（＝アニメーション）から「画面が変わった瞬間」と「変わった所」を学ぶ**。
 *     押した操作の記録が無くても、**絵の変化**で「ここを押した」が分かる。
 *
 * 何をするか:
 *   ① 直近の録画を `run_<run_id>` ごとに集める（時系列）
 *   ② それぞれの絵を 16x9 の明るさに縮めて指紋を作る
 *   ③ 前の絵と**大きく変わった所**を「押した瞬間」として拾う
 *   ④ **どこが変わったか**（画面を 4x4 に分けて一番変わった区画）を出す
 *      → 「右上（検索ボタンの辺り）が変わった」のように言える
 *   ⑤ 変化の前後を1枚ずつ保存して、私が目で確かめられるようにする
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/learn-from-latest-run.ts
 *   npx tsx --env-file=.env.local scripts/learn-from-latest-run.ts --runs=2 --frames=10
 *
 * ⚠ 見るのは**明るさの並び**だけ（文字・物件名は読まない・費用0）。
 * ⚠ Vision は使わない（必要な時だけ、別のスクリプトで）。
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { hashImage, framesDiffer, type FrameHash } from "../app/lib/learn-from-images";

const BUCKET = "human-motion-shots";
const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const wantRuns = Number(argOf("runs", "1"));
const maxFrames = Number(argOf("frames", "12"));
const outDir = argOf("out", ".tmp-runs");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

type Row = { created_at: string; shot_key: string; shot_w?: number | null; shot_h?: number | null; mode?: string | null };

/** Storage の1枚を取る */
async function getShot(key: string): Promise<Buffer | null> {
  try {
    const sg = await sb.storage.from(BUCKET).createSignedUrl(key, 600);
    if (sg.error || !sg.data?.signedUrl) return null;
    const r = await fetch(sg.data.signedUrl);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

/** 画面を 4x4 に分けて「どこが一番変わったか」を出す（純関数に近い） */
function changedRegion(a: FrameHash | null, b: FrameHash | null): string | null {
  if (!a || !b || !Array.isArray(a.sig) || !Array.isArray(b.sig)) return null;
  // 16x9 の指紋 → 4x4 の区画にまとめる（横4×縦2.25 → 縦は3で割る）
  const W = 16, H = 9;
  const cellW = 4, cellH = 3;   // 4列 × 3行 に分ける
  let best = { name: "", diff: -1 };
  const names = ["左上", "上", "右上", "右上2",
    "左", "中央", "右", "右2",
    "左下", "下", "右下", "右下2"];
  let idx = 0;
  for (let gy = 0; gy < H; gy += cellH) {
    for (let gx = 0; gx < W; gx += cellW) {
      let sum = 0, n = 0;
      for (let y = gy; y < Math.min(H, gy + cellH); y++) {
        for (let x = gx; x < Math.min(W, gx + cellW); x++) {
          const i = y * W + x;
          sum += Math.abs((a.sig[i] ?? 0) - (b.sig[i] ?? 0));
          n++;
        }
      }
      const d = n ? sum / n : 0;
      // 4x3 の位置を日本語に（列: 左/中/右/右端・行: 上/中/下）
      const cols = ["左", "中", "右", "右端"];
      const rows = ["上", "中", "下"];
      const nm = `${cols[gx / cellW]}${rows[gy / cellH]}`;
      if (d > best.diff) best = { name: nm, diff: Math.round(d) };
      idx++;
    }
  }
  void names; void idx;
  return best.name;
}

void (async () => {
  console.log("直近の録画から、連続画像で「押した所」を学ぶ");
  console.log("─".repeat(66));

  // ① 直近の写真を集める（新しい順）
  const { data, error } = await sb
    .from("human_motion_learn")
    .select("created_at, shot_key, shot_w, shot_h, mode")
    .eq("shot_taken", true)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) { console.log("読めません:", error.message); process.exitCode = 1; return; }
  const rows = (data ?? []) as Row[];

  // `run_xxx` ごとに分ける（新しい物から）
  const runsMap = new Map<string, Row[]>();
  for (const r of rows) {
    const m = String(r.shot_key).match(/run_([a-z0-9_]+)\//i);
    const key = m ? m[1] : "(まとまりなし)";
    if (!runsMap.has(key)) runsMap.set(key, []);
    runsMap.get(key)!.push(r);
  }
  const runKeys = [...runsMap.keys()].filter((k) => k !== "(まとまりなし)").slice(0, wantRuns);
  console.log(`録画のまとまり: ${runsMap.size}個（見るのは新しい ${runKeys.length}個）`);

  if (!runKeys.length) {
    console.log("\n⚠ `run_xxx` のフォルダがありません（2.7.48 以降の写真が必要）");
    console.log("  いまの保管: " + String(rows[0]?.shot_key ?? "(写真なし)").slice(0, 70));
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const summary: Array<{ run: string; n: number; changes: number; picks: string[] }> = [];

  for (const rk of runKeys) {
    const list = runsMap.get(rk)!.slice().reverse();   // 古い順に
    console.log(`\n=== 録画 ${rk}（${list.length}枚・${String(list[0].created_at).slice(11, 19)}〜${String(list[list.length - 1].created_at).slice(11, 19)}）`);
    if (list.length < 2) { console.log("  1枚だけなので動きを学べません"); continue; }

    // ② 全部の指紋を作る（4枚ずつ並行）
    type F = { row: Row; at: string; hash: FrameHash | null; buf: Buffer | null };
    const frames: F[] = [];
    const PAR = 4;
    for (let i = 0; i < list.length; i += PAR) {
      const chunk = list.slice(i, i + PAR).map(async (r): Promise<F> => {
        const buf = await getShot(r.shot_key);
        return { row: r, at: r.created_at, hash: buf ? await hashImage(buf) : null, buf };
      });
      for (const f of await Promise.all(chunk)) frames.push(f);
    }
    const okHash = frames.filter((f) => f.hash).length;
    console.log(`  指紋を作れた: ${okHash}/${frames.length}枚`);

    // ③ 変わった瞬間を拾う
    const changes: Array<{ i: number; region: string | null; diffAt: string }> = [];
    for (let i = 1; i < frames.length; i++) {
      if (framesDiffer(frames[i - 1].hash, frames[i].hash)) {
        changes.push({ i, region: changedRegion(frames[i - 1].hash, frames[i].hash), diffAt: frames[i].at });
      }
    }
    console.log(`  画面が変わった: ${changes.length}回`);

    // ④ 変化の前後を抜き出して保存（私が目で見る）
    const picks: string[] = [];
    const step = Math.max(1, Math.ceil(changes.length / maxFrames));
    for (let k = 0; k < changes.length && picks.length < maxFrames; k += step) {
      const c = changes[k];
      const before = frames[c.i - 1], after = frames[c.i];
      const tag = `${rk}_${String(k + 1).padStart(2, "0")}`;
      if (before.buf) { const p = path.join(outDir, `${tag}_a.jpg`); fs.writeFileSync(p, before.buf); }
      if (after.buf) { const p = path.join(outDir, `${tag}_b.jpg`); fs.writeFileSync(p, after.buf); }
      const hhmmss = String(c.diffAt).slice(11, 19);
      console.log(`    ${String(k + 1).padStart(2)} ${hhmmss}  変わった所: ${c.region ?? "?"}  → ${tag}_a.jpg / ${tag}_b.jpg`);
      picks.push(`${hhmmss} ${c.region ?? "?"}`);
    }
    summary.push({ run: rk, n: frames.length, changes: changes.length, picks });
  }

  console.log("\n" + "─".repeat(66));
  console.log(`保存先: ${path.resolve(outDir)}`);
  console.log("⚠ 変化の前後（_a / _b）を並べると、どこを押したかが分かります。");
  const totalChanges = summary.reduce((a, s) => a + s.changes, 0);
  console.log(`学んだ変化: 合計 ${totalChanges}回（${summary.length}録画）`);
})();
