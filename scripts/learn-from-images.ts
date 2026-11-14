/**
 * いままでの写真から統括が学ぶ（2026-11-14 竹内さん「いままでの画像から統括がまなぶことできないのか」）
 *
 * なぜ要るか:
 *   操作の記録（`shot_ops`）が 12% しか無い。だが**写真は 4318枚ある**。
 *   → 写真だけで「画面が変わった瞬間」を学ぶ（操作の記録が無くても分かる）。
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/learn-from-images.ts
 *   npx tsx --env-file=.env.local scripts/learn-from-images.ts --limit=300
 *   npx tsx --env-file=.env.local scripts/learn-from-images.ts --days=3 --json
 *
 * ⚠ 写真の中身（文字・物件名）は読まない。見るのは画面全体の明るさの並びだけ（費用0）。
 */
import { hashImage, learnFromFrames, type FrameHash, type ShotFrame } from "../app/lib/learn-from-images";

const BASE = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
const args = process.argv.slice(2);
const limit = Number((args.find((a) => a.startsWith("--limit=")) || "").replace("--limit=", "")) || 200;
const days = Number((args.find((a) => a.startsWith("--days=")) || "").replace("--days=", "")) || 1;
const asJson = args.includes("--json");

void (async () => {
  const r = await fetch(`${BASE}/api/human-motion?shots=1&limit=${limit}&days=${days}`, { cache: "no-store" });
  if (!r.ok) { console.log("写真の一覧を取れません: http_" + r.status); process.exitCode = 1; return; }
  const j = (await r.json()) as Record<string, unknown>;
  const rows = ((j.rows ?? []) as Array<Record<string, unknown>>).filter((x) => typeof x.shot_url === "string" && String(x.shot_url).length > 10);
  console.log(`写真: ${rows.length}枚（${days}日）`);

  // 時刻順にする
  rows.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));

  /** 検索のまとまり（10分あいたら別の回）に分ける */
  const groups: Array<Array<Record<string, unknown>>> = [];
  let cur: Array<Record<string, unknown>> = [];
  let lastT = 0;
  for (const x of rows) {
    const t = Date.parse(String(x.created_at ?? ""));
    if (!Number.isFinite(t)) continue;
    if (lastT && t - lastT > 10 * 60_000) { if (cur.length) groups.push(cur); cur = []; }
    cur.push(x); lastT = t;
  }
  if (cur.length) groups.push(cur);
  console.log(`検索のまとまり: ${groups.length}回\n`);

  const results: Array<{ at: string | null; n: number; changes: number; step_ms: number | null; hold_ms: number | null; top_note: string | null }> = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (g.length < 2) continue;
    const frames: ShotFrame[] = [];
    /**
     * 2026-11-14: 1枚ずつ取ると遅い（60枚で17秒以上）。**6枚ずつ並行**にして速くする。
     *   ⚠ サイトではなく Storage から取るので、負荷は問題ない。
     */
    const PARALLEL = 6;
    const pending: Array<Promise<ShotFrame>> = [];
    const toFrame = async (x: Record<string, unknown>): Promise<ShotFrame> => {
      const url = String(x.shot_url);
      let hash: FrameHash | null = null;
      try {
        const ir = await fetch(url, { cache: "no-store" });
        if (ir.ok) {
          const buf = Buffer.from(await ir.arrayBuffer());
          hash = await hashImage(buf);
        }
      } catch { hash = null; }
      return { at: typeof x.created_at === "string" ? x.created_at : null, hash };
    };
    for (let i = 0; i < g.length; i += PARALLEL) {
      const chunk = g.slice(i, i + PARALLEL).map((x) => toFrame(x));
      for (const p of chunk) pending.push(p);
      frames.push(...(await Promise.all(chunk)));
    }
    void pending;
    const learned = learnFromFrames(frames.map((f) => ({ at: f.at, hash: f.hash ?? null })));
    const first = String(g[0].created_at ?? "").slice(0, 16).replace("T", " ");
    results.push({
      at: first,
      n: learned.n,
      changes: learned.changes,
      step_ms: learned.step_ms,
      hold_ms: learned.hold_ms,
      top_note: learned.top_note,
    });
    console.log(`【${gi + 1}/${groups.length}】${first}  ${learned.n}枚 → 変化 ${learned.changes}回`
      + (learned.step_ms ? `・1段 約${Math.round(learned.step_ms / 1000)}秒` : "")
      + (learned.top_note ? `\n     ${learned.top_note}` : ""));
  }

  const changes = results.map((x) => x.changes);
  const steps = results.map((x) => x.step_ms).filter((x): x is number => typeof x === "number" && x > 0);
  const med = (a: number[]) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
  };

  console.log("\n" + "─".repeat(60));
  console.log("■ 写真から学んだ事（統括に渡せる形）");
  console.log(`  調べた回: ${results.length}回 / 写真 合計 ${results.reduce((s, x) => s + x.n, 0)}枚`);
  console.log(`  画面が変わった回数の中央値: ${med(changes) ?? "-"}回／1検索`);
  console.log(`  1段にかかる時間の中央値: ${med(steps) ? Math.round((med(steps) as number) / 1000) + "秒" : "-"}`);
  const notes = results.map((x) => x.top_note).filter((x): x is string => !!x);
  if (notes.length) {
    console.log("  気づいた事:");
    for (const x of notes.slice(0, 5)) console.log("    ・" + x);
  }

  if (asJson) {
    console.log("\n" + JSON.stringify({ results, summary: { runs: results.length, changes_median: med(changes), step_ms_median: med(steps) } }, null, 1));
  }
})();
