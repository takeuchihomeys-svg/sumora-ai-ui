/**
 * 保管されている写真を「録画ごと × モード」で見る（2026-11-14 竹内さん）
 *
 *   竹内さん「録画ごとというのと通常モードか自動モードどちらでの保存かの保管もわかるようにする」
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/shots-by-run.ts                 # 今日・一覧
 *   npx tsx --env-file=.env.local scripts/shots-by-run.ts --days=3
 *   npx tsx --env-file=.env.local scripts/shots-by-run.ts --mode=normal
 *   npx tsx --env-file=.env.local scripts/shots-by-run.ts --json
 *
 * ⚠ 読むだけ（消さない・動かさない）。
 * ⚠ 保管の形: `日付/モード/run_<run_id>/端末-時刻.jpg`（古い写真は `日付/端末-時刻.jpg` のまま）
 */
import { supabase } from "../app/lib/supabase-server";

const BUCKET = "human-motion-shots";
const args = process.argv.slice(2);
const argOf = (k: string, d: string) => (args.find((a) => a.startsWith(`--${k}=`)) || "").replace(`--${k}=`, "") || d;
const days = Number(argOf("days", "1"));
const wantMode = argOf("mode", "");
const asJson = args.includes("--json");

type Group = { day: string; mode: string; run: string; n: number; bytes: number; first: string; last: string };

void (async () => {
  const today = Date.now();
  const dayList: string[] = [];
  for (let d = 0; d < Math.max(1, Math.min(31, days)); d++) {
    dayList.push(new Date(today - d * 86400_000).toISOString().slice(0, 10));
  }

  const groups: Group[] = [];
  for (const day of dayList) {
    /**
     * ⚠ 2026-11-14 竹内さん「最新の録画できているのかな／直近の撮影できているのか」:
     *   新しい録画（`日付/normal/run_xxx/`）が**一覧に出てこなかった**。
     *   原因は**1回の list が 1000件まで**で、`日付/` の直下に旧形式の写真が1000枚以上あると
     *   **フォルダ（normal など）が窓の外に押し出される**事。
     *   → ① 旧形式の写真は「名前が `.jpg` で終わる物だけ」数える（フォルダは名前で判定）
     *     ② 1000件で切れたら**続きを頁で読む**（PostgREST と同じ1000件の壁）
     */
    const entries: Array<{ name?: string | null; metadata?: { size?: number } | null }> = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      const page = await supabase.storage.from(BUCKET).list(day, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
      if (page.error) break;
      const got = page.data ?? [];
      entries.push(...got);
      if (got.length < 1000) break;
    }
    if (!entries.length) continue;
    for (const e of entries) {
      const name = String(e.name || "");
      /**
       * フォルダかどうかの判定（2026-11-14 修正）:
       *   ⚠ 旧は `!e.metadata` で判定していたが、**フォルダも metadata を持って返る**事があり、
       *     `normal` を「ファイル」と誤判定して**中を読まなかった**（＝新しい録画が見えない）。
       *   → **名前で判定する**（`.jpg` 等で終わらなければフォルダ）。
       */
      const isFolder = !/\.(jpg|jpeg|png)$/i.test(name);
      if (isFolder) {
        /**
         * `日付/mode/` の形（新しい保管）。
         *   さらにその下に `run_xxx/` があれば録画ごとに数える。
         */
        const mode = name;
        if (wantMode && mode !== wantMode) continue;
        const sub = await supabase.storage.from(BUCKET).list(`${day}/${mode}`, { limit: 1000 });
        if (sub.error) continue;
        for (const s of sub.data ?? []) {
          const sname = String(s.name || "");
          const isRunFolder = !/\.(jpg|jpeg|png)$/i.test(sname);
          if (isRunFolder) {
            // 録画ごと（run_xxx）の中の写真
            const files = await supabase.storage.from(BUCKET).list(`${day}/${mode}/${sname}`, { limit: 1000 });
            const list = (files.data ?? []).filter((f) => /\.(jpg|jpeg|png)$/i.test(String(f.name || "")));
            if (!list.length) continue;
            const times = list.map((f) => Number(String(f.name).replace(/^.*-(\d+)\.jpg$/i, "$1"))).filter((x) => x > 0);
            groups.push({
              day, mode, run: sname, n: list.length,
              bytes: list.reduce((a, f) => a + (Number(f.metadata?.size) || 0), 0),
              first: times.length ? new Date(Math.min(...times)).toISOString().slice(11, 19) : "-",
              last: times.length ? new Date(Math.max(...times)).toISOString().slice(11, 19) : "-",
            });
          } else if (/\.(jpg|jpeg|png)$/i.test(sname)) {
            // 録画のフォルダが無い（モードの直下）→ run を "（まとまりなし）" として数える
            const g = groups.find((x) => x.day === day && x.mode === mode && x.run === "(まとまりなし)");
            const t = Number(sname.replace(/^.*-(\d+)\.jpg$/i, "$1")) || 0;
            const hhmmss = t ? new Date(t).toISOString().slice(11, 19) : "-";
            if (g) {
              g.n++; g.bytes += Number(s.metadata?.size) || 0;
              if (hhmmss !== "-") { if (g.first === "-" || hhmmss < g.first) g.first = hhmmss; if (g.last === "-" || hhmmss > g.last) g.last = hhmmss; }
            } else {
              groups.push({ day, mode, run: "(まとまりなし)", n: 1, bytes: Number(s.metadata?.size) || 0, first: hhmmss, last: hhmmss });
            }
          }
        }
      } else if (/\.(jpg|jpeg|png)$/i.test(name)) {
        /**
         * 古い保管（`日付/端末-時刻.jpg`）＝モードも録画も分からない。
         *   ⚠ 「分からない」と正直に出す（推測でモードを決めない）。
         */
        if (wantMode && wantMode !== "(旧・不明)") continue;
        const t = Number(name.replace(/^.*-(\d+)\.jpg$/i, "$1")) || 0;
        const hhmmss = t ? new Date(t).toISOString().slice(11, 19) : "-";
        const g = groups.find((x) => x.day === day && x.mode === "(旧・不明)" && x.run === "(録画不明)");
        if (g) {
          g.n++; g.bytes += Number(e.metadata?.size) || 0;
          if (hhmmss !== "-") { if (g.first === "-" || hhmmss < g.first) g.first = hhmmss; if (g.last === "-" || hhmmss > g.last) g.last = hhmmss; }
        } else {
          groups.push({ day, mode: "(旧・不明)", run: "(録画不明)", n: 1, bytes: Number(e.metadata?.size) || 0, first: hhmmss, last: hhmmss });
        }
      }
    }
  }

  if (asJson) { console.log(JSON.stringify({ groups }, null, 1)); return; }

  if (!groups.length) {
    console.log("写真がありません（この期間・このモード）");
    return;
  }
  groups.sort((a, b) => (a.day === b.day ? (a.mode === b.mode ? a.first.localeCompare(b.first) : a.mode.localeCompare(b.mode)) : b.day.localeCompare(a.day)));

  const modeLabel: Record<string, string> = {
    normal: "通常", staff: "スタッフ", aix: "自動（AIX）", ai: "AIX（選んだ顧客）",
    brain_normal: "自動（AIX）×ブレイン", brain_staff: "スタッフ×ブレイン", brain_aix: "自動×ブレイン",
    unknown: "（モード不明）", "(旧・不明)": "（旧・不明）",
  };
  console.log(`保管されている写真（${days}日・録画ごと × モード）`);
  console.log("─".repeat(74));
  let cur = "";
  for (const g of groups) {
    if (g.day !== cur) { cur = g.day; console.log(`\n【${g.day}】`); }
    const mb = (g.bytes / 1048576).toFixed(1);
    console.log(`  ${modeLabel[g.mode] || g.mode}${"".padEnd(Math.max(0, 14 - (modeLabel[g.mode] || g.mode).length))} ${g.run}`);
    console.log(`      ${g.n}枚・${mb}MB・${g.first}〜${g.last}`);
  }
  console.log("─".repeat(74));
  const totalN = groups.reduce((a, g) => a + g.n, 0);
  const totalMB = (groups.reduce((a, g) => a + g.bytes, 0) / 1048576).toFixed(1);
  console.log(`録画のまとまり ${groups.length}件・写真 ${totalN}枚・合計 ${totalMB}MB`);
  console.log("⚠ 「（旧・不明）」は 2026-11-14 より前の保管（モードも録画も分からない・消していません）");
})();
