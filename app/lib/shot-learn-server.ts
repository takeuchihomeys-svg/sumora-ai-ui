// app/lib/shot-learn-server.ts
//
// 2026-11-14 竹内さん「弱い部分は学習データから写真で必要な部分読み取ったら学習できるのでは」
//
// なぜ要るか（実測で分かった事）:
//   ✅ `SHOT_LEARN_PROMPT`（写真から欄の種類を読む指示文）と `parseShotLearn` は**作ってあった**。
//   ⚠ だが **呼ぶ所が1か所も無かった**（実測 0箇所）。
//     だから `human_motion_learn.shot_learn` は **全件 0**（＝写真は撮れているのに、写真から何も学べていない）。
//   → 写真（Storage の JPEG）を **Vision で読んで**、欄の種類（select / input / checkbox …）と
//     画面の種類（form / modal / result）を `shot_learn` に**書き戻す**。
//
// 何を読むか（個人情報を読まない）:
//   ・欄の**種類**（見た目で決まる: プルダウン／入力／チェック／ボタン／リンク）
//   ・欄の**名前**（見出しの短い文字。40字以内）
//   ・画面の**種類**（form / modal / result / other）
//   ・押せるか（グレーでないか）
//   ⚠ 入力された中身（数字・文字・お客様の名前・住所）は**絶対に読ませない**（プロンプトで禁止）。
//
// 費用:
//   ⚠ Vision は1枚ごとにお金がかかる。**弱い所がある記録だけ**・枚数は統括が課題に応じて決める。
//     ★ 2026-11-16: 上限20固定を廃止。課題が解けるまで読む（硬上限は shot-learn-limit.ts）。
//   実行は**明示的に呼ばれた時だけ**（cron の自動では走らせない）。
import { supabase } from "./supabase-server";
import { SHOT_LEARN_PROMPT, parseShotLearn, type ShotLearn } from "./shot-learn";
import {
  resolveShotLearnLimit,
  shotLearnMax as shotLearnMaxFromLimit,
  shotLearnModel,
} from "./shot-learn-limit";
import { DAY_MS, LEARN_PERIODS, materialsDays } from "./learn-periods";
import { sceneOfOp } from "./learn-flow-steps";

/** `shot_key` から連続録画の run id（`run_xxx/`）を取る */
function runOfShotKey(shotKey: string): string {
  return (String(shotKey || "").match(/run_([a-z0-9_]+)\//i) || [])[1] || "";
}

type ShotOpLite = { by?: unknown; f?: unknown; k?: unknown; was?: unknown; now?: unknown };

function lastShotOp(ops: ShotOpLite[] | null | undefined): ShotOpLite | null {
  if (!ops?.length) return null;
  const o = ops[ops.length - 1];
  return o && typeof o === "object" ? o : null;
}

/** 操作の短い署名（個人情報の was/now は context の詳細用・一覧は k:f） */
function opSigShort(op: ShotOpLite | null | undefined): string {
  if (!op) return "";
  const k = String(op.k ?? "").trim();
  const f = String(op.f ?? "").trim();
  if (k && f) return `${k}:${f}`;
  return f || k || "";
}

function isFlowMilestoneOp(op: ShotOpLite | null | undefined): boolean {
  const t = (String(op?.f ?? "") + String(op?.k ?? "")).toLowerCase();
  return /所在地|沿線|確定|間取り|検索|印刷|次ページ|次のページ|go_search|room_layout|print|リストへ|ページ/.test(t);
}

function sceneOfLastOp(op: ShotOpLite | null | undefined): string {
  if (!op) return "other";
  const k = String(op.k ?? "").trim() || "click";
  const f = String(op.f ?? "").trim();
  return sceneOfOp(f ? `${k}:${f}` : k);
}

function shotOpsTailText(ops: ShotOpLite[] | null | undefined, n = 3): string {
  const tail = (ops || []).slice(-n);
  if (!tail.length) return "（操作なし）";
  return tail
    .map((o) => {
      const was = o.was != null && String(o.was).trim() !== "" ? "***" : "-";
      const now = o.now != null && String(o.now).trim() !== "" ? "***" : "-";
      return `k=${o.k ?? "-"} f=${o.f ?? "-"} by=${o.by ?? "-"} was=${was} now=${now}`;
    })
    .join(" | ");
}

function buildShotContextNote(
  idx: number,
  total: number,
  row: { shot_ops: ShotOpLite[] | null },
  prev: { shot_ops: ShotOpLite[] | null } | null,
): string {
  const prevSig = prev ? opSigShort(lastShotOp(prev.shot_ops)) : "なし";
  const curSig = opSigShort(lastShotOp(row.shot_ops)) || "なし";
  const tail = shotOpsTailText(row.shot_ops, 3);
  return `流れ順(${idx + 1}/${total}): 直前操作=${prevSig} -> 現在操作=${curSig} / 末尾ops: ${tail}`;
}

/**
 * 連続録画（1 run）の中から場面変化・初出節目を優先しつつ、先頭→末尾まで均等に budget 枚を選ぶ。
 */
function selectIndicesForRun(
  runRows: Array<{ created_at: string; shot_ops: ShotOpLite[] | null }>,
  budget: number,
  strideMs: number,
): number[] {
  const n = runRows.length;
  if (!n || budget <= 0) return [];
  if (n <= budget) return Array.from({ length: n }, (_, i) => i);

  // 各コマに「流れの重要度」を付ける（先頭/末尾 > 場面切替 > 初出の操作/節目 > 操作変化）
  const score = new Array<number>(n).fill(10);
  const seenOp = new Set<string>();
  const times = runRows.map((r) => Date.parse(r.created_at) || 0);
  let lastStrideAt = times[0] || 0;

  for (let i = 0; i < n; i++) {
    const op = lastShotOp(runRows[i].shot_ops);
    const sig = opSigShort(op);
    const sc = sceneOfLastOp(op);
    if (i === 0 || i === n - 1) {
      score[i] = 100;
    } else {
      const pOp = lastShotOp(runRows[i - 1].shot_ops);
      const pSig = opSigShort(pOp);
      const pSc = sceneOfLastOp(pOp);
      if (pSc !== sc && sc !== "other") {
        score[i] = 85;
      } else if (sig && !seenOp.has(sig)) {
        score[i] = isFlowMilestoneOp(op) ? 75 : 65;
      } else if (pSig !== sig) {
        score[i] = isFlowMilestoneOp(op) ? 55 : 45;
      } else if (strideMs > 0 && times[i] - lastStrideAt >= strideMs) {
        score[i] = 25;
        lastStrideAt = times[i];
      }
    }
    if (sig) seenOp.add(sig);
  }

  // budget 個の時間・順番バケットに分け、各バケットから最も重要度の高い1枚を取る（必ず先頭→末尾を全域カバー）
  const picked = new Set<number>([0, n - 1]);
  if (budget === 1) return [0];
  if (budget === 2) return [0, n - 1];

  const innerBuckets = budget - 2;
  const span = n - 2;
  for (let b = 0; b < innerBuckets; b++) {
    const lo = 1 + Math.floor((b * span) / innerBuckets);
    const hi = Math.max(lo, 1 + Math.floor(((b + 1) * span) / innerBuckets) - 1);
    let bestI = -1;
    let bestScore = -1;
    const mid = (lo + hi) / 2;
    for (let i = lo; i <= hi && i < n - 1; i++) {
      if (picked.has(i)) continue;
      if (
        score[i] > bestScore ||
        (score[i] === bestScore && Math.abs(i - mid) < Math.abs(bestI - mid))
      ) {
        bestScore = score[i];
        bestI = i;
      }
    }
    if (bestI >= 0) picked.add(bestI);
  }

  // 取りこぼし枠があれば埋める
  for (let i = 1; i < n - 1 && picked.size < budget; i++) {
    if (!picked.has(i) && score[i] >= 45) picked.add(i);
  }
  for (let i = 1; i < n - 1 && picked.size < budget; i++) {
    if (!picked.has(i)) picked.add(i);
  }
  return [...picked].sort((a, b) => a - b).slice(0, budget);
}

function pickSequenceShots(
  rows: Array<{
    id: unknown; shot_key: string; site: string | null; mode: string | null;
    shot_w: number; created_at: string; shot_ops: ShotOpLite[] | null;
  }>,
  limit: number,
  strideMs: number,
  runIdPref?: string | null,
): Array<{
  id: unknown; shot_key: string; site: string | null; mode: string | null;
  shot_w: number; created_at?: string; run_id?: string | null; context_note?: string | null;
}> {
  const byRun = new Map<string, typeof rows>();
  for (const r of rows) {
    const run = runOfShotKey(r.shot_key);
    if (!run) continue;
    if (!byRun.has(run)) byRun.set(run, []);
    byRun.get(run)!.push(r);
  }
  if (!byRun.size) return [];
  const runStats = [...byRun.entries()].map(([run, rs]) => ({
    run,
    rs: rs.slice().sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)),
    newest: Math.max(...rs.map((r) => Date.parse(r.created_at) || 0)),
    n: rs.length,
  }));
  runStats.sort((a, b) => b.newest - a.newest);
  const orderRuns: typeof runStats = [];
  const pref = String(runIdPref || "").trim();
  if (pref) {
    const hit = runStats.find((x) => x.run === pref || x.run.includes(pref));
    if (hit) orderRuns.push(hit);
    for (const x of runStats) {
      if (x.run !== hit?.run) orderRuns.push(x);
    }
  } else {
    const big = runStats.filter((x) => x.n >= 5);
    if (big.length) {
      big.sort((a, b) => b.newest - a.newest);
      orderRuns.push(big[0]);
      for (const x of runStats) if (x.run !== big[0].run) orderRuns.push(x);
    } else {
      const freq = [...runStats].sort((a, b) => b.n - a.n || b.newest - a.newest);
      orderRuns.push(...freq);
    }
  }
  const cap = Math.max(1, limit);
  const out: Array<{
    id: unknown; shot_key: string; site: string | null; mode: string | null;
    shot_w: number; created_at?: string; run_id?: string | null; context_note?: string | null;
  }> = [];
  for (const block of orderRuns) {
    if (out.length >= cap) break;
    const budget = cap - out.length;
    const idxs = selectIndicesForRun(block.rs, budget, strideMs);
    for (const i of idxs) {
      const r = block.rs[i];
      const prev = i > 0 ? block.rs[i - 1] : null;
      out.push({
        id: r.id, shot_key: r.shot_key, site: r.site, mode: r.mode, shot_w: r.shot_w,
        created_at: r.created_at, run_id: block.run,
        context_note: buildShotContextNote(i, block.rs.length, r, prev),
      });
    }
  }
  return out;
}

export { shotLearnModel } from "./shot-learn-limit";

const BUCKET = "human-motion-shots";

/** 1回に読む枚数の既定／環境変数（費用の硬上限は shot-learn-limit） */
export function shotLearnMax(env: Record<string, string | undefined> = process.env): number {
  return shotLearnMaxFromLimit(env);
}
export { photoLearnLimitFor, shotLearnHardCap, resolveShotLearnLimit } from "./shot-learn-limit";

/** `shot_learn` がまだ無い記録から、写真の置き場所（shot_key）を集める */
/**
 * ★ 2026-11-16 仕組み㉑「1つずつリアプロのボタンを理解してそれぞれ強化」:
 *   shot_ops の欄名が、今理解したいボタン／欄に当たるか。
 *   （「所在地絞り込み＋」↔「左の所在地絞り込み＋｜span」など）
 */
export function shotOpsMatchFocus(
  ops: Array<{ f?: unknown; k?: unknown }> | null | undefined,
  focusFields: readonly string[] | null | undefined,
): boolean {
  if (!focusFields || !focusFields.length) return true;
  const needles = focusFields
    .map((s) => String(s || "").trim().toLowerCase())
    .filter(Boolean);
  if (!needles.length) return true;
  const hay = (ops || [])
    .map((o) => String(o?.f ?? "").toLowerCase())
    .filter(Boolean);
  if (!hay.length) return false;
  return needles.some((n) => hay.some((h) => h === n || h.includes(n) || n.includes(h)));
}

export async function findShotsToLearn(opt: {
  site?: string | null;
  mode?: string | null;
  days?: number;
  limit?: number;
  /** 時刻の下限（ISO）。指定時は days より優先（例: まりあさんの通常録画の窓） */
  from?: string | null;
  /** 時刻の上限（ISO・含まない） */
  to?: string | null;
  /** 同じ操作並びの写真を何枚まで読むか（既定1・位置の票を増やす時は2〜3） */
  perSig?: number;
  /**
   * ★ 2026-11-19 竹内さん「今回は全部読み取っても大丈夫」「徹底的に学習」:
   *   true = 同じ操作並びの上限（perSig）も、連続の間引き（strideMs）もしない。
   *   窓の中の読める写真（800px以上・未学習）を**全部**候補にする（件数は limit と硬上限で止まる）。
   */
  all?: boolean;
  /**
   * ★ 2026-11-15 竹内さん「画像も順番で時間で学習すればより強化される」「細かく強化」「連続録画で」:
   *   `size` = 大きい順（既定・窓が開いた瞬間を優先）
   *   `time` = **連続録画の時間順**（created_at 古い→新しい）。流れに沿って位置を固める。
   *   `sequence` = **1つの連続録画 run を先頭→末尾**（節目優先・時系列）。
   */
  order?: "size" | "time" | "newest" | "sequence";
  /**
   * 時間順のとき、同じ画面の写真を何ms以上空けて取るか（細かく=小さい値）。
   *   既定: size=無視 / time=1500 / fine時は800。
   */
  strideMs?: number;
  /** `order=sequence` のとき優先する連続録画 run（`run_...` の中身） */
  runId?: string | null;
  /**
   * ★ 2026-11-16 仕組み㉑: このボタン／欄の操作が写っている写真を**先に**取る。
   *   当たる物が足りなければ、当たる物だけで止める（他ボタンの写真で薄めない）。
   */
  focusFields?: string[] | null;
  /**
   * ★ 2026-11-18 竹内さん「場面ごとの強化を画像学習にも紐づける」:
   *   既に読んだ写真のうち **場面（scene）の印が無い物だけ** 読み直す（757/1200 が未設定の実測）。
   *   印を付けて場面別の位置（learned_scene）に入れるため。
   */
  onlyNoScene?: boolean;
} = {}): Promise<
  Array<{
    id: unknown; shot_key: string; site: string | null; mode: string | null;
    shot_w: number; created_at?: string; run_id?: string | null; context_note?: string | null;
  }>
> {
  /** 既定は材料窓（materialsDays）。明示 days / from で上書き可 */
  const days = Math.max(1, Math.min(30, opt.days ?? materialsDays()));
  /**
   * ⚠ 時刻に時差が無いと `new Date(...)` が**ローカル**になり、DB（+00:00）と窓がズレる
   *   （実測: まりあ 09:32 UTC が JST 解釈で 00:32 になり「0件」）。
   *   → 時差無しは UTC（末尾 Z）として扱う。
   */
  const asUtc = (s: string) => {
    const t = String(s).trim();
    if (!t) return null;
    const withTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(t) ? t : t + "Z";
    const ms = Date.parse(withTz);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const since = (opt.from && asUtc(opt.from)) || new Date(Date.now() - days * DAY_MS).toISOString();
  const until = opt.to ? asUtc(opt.to) : null;
  /**
   * ★ 2026-11-15「画像は最新で録画したらそのことも把握」「通常から改善」:
   *   `newest` = 新しい順（最新録画を先に読む）。`time` = 古い→新しい（連続の流れ）。
   */
  const order =
    opt.order === "time" ? "time"
      : opt.order === "newest" ? "newest"
        : opt.order === "sequence" ? "sequence"
          : "size";
  /**
   * ⚠ 2026-11-14 竹内さん「1から順に進めていく」→ **実測で判明（2回目の罠）**:
   *   直近の写真を `limit` 件だけ取ってから並べ替えていたので、
   *   **大きい写真（1280px）が取った中に入っていない**と、小さい写真ばかり読んで
   *   「読めた0枚」になっていた（実測: 480x244 を3枚連続で読んで全滅）。
   *   → **DBの側で大きい順に並べて取る**（`order("shot_w")`）。
   *     ⚠ limit より前に並べる（取ってから並べ替えると窓の外が漏れる）。
   *
   * ★ 2026-11-15「順番で時間で」「連続録画で」:
   *   `order=time` のときは **created_at 昇順**（録画の流れどおり）。
   */
  const focusEarly = (opt.focusFields || []).map((s) => String(s || "").trim()).filter(Boolean);
  let q = supabase
    .from("human_motion_learn")
    .select("id, shot_key, site, mode, shot_w, shot_taken, shot_learn, shot_ops, created_at")
    .gte("created_at", since)
    .eq("shot_taken", true);
  /**
   * ★ 2026-11-15 竹内さん「通常モードの録画でもちゃんと学習できるように」→ **実測で判明（3回目の罠）**:
   *
   *   ⚠ 大きい順に `limit` 件取ると、**学習済みの大きい写真が枠を埋めて**
   *     **未学習が1件も入らない**（実測: 20件全部が学習済みで「読む物がありません」になった）。
   *     未学習は742枚もあるのに0件と表示された。
   *
   *   → **未学習だけをDBで絞る**（`shot_learn IS NULL`）。
   *     取ってから絞ると、枠が学習済みで埋まって同じ事になる。
   *
   * ★ 2026-11-16 仕組み㉑（1つずつ）: focus がある時は**そのボタンの操作写真**を取る。
   *   未学習が尽きていても、学習済みを再読してそのボタンだけ強化する（まとめての枠埋め罠とは別）。
   */
  if (opt.onlyNoScene) {
    // 読んだ写真のうち場面の印が無い物（shot_learn はあるが scene が無い）
    q = q.not("shot_learn", "is", null).is("shot_learn->>scene", null);
  } else if (!focusEarly.length) {
    q = q.is("shot_learn", null);
  }
  /**
   * ★ 2026-11-15 竹内さん「進めてよい」→ **実測で判明（4回目の罠）**:
   *   統括は通常モードの読める未学習 **528枚** と言ったのに、`findShotsToLearn` は **0件**。
   *   なぜ: `order=time` で古い順に1600件取ると、枠が **480px（読めない）** で埋まり、
   *   取った後の `shot_w >= 800` で全滅する（実測: nullLearn 先頭5000件は small 4964 / big 36）。
   *   → **読める大きさ（800px以上）をDBで先に絞る**。統括の「まだ読める」と実行が一致する。
   */
  q = q.gte("shot_w", 800);
  if (order === "time") {
    q = q.order("created_at", { ascending: true }).order("shot_w", { ascending: false, nullsFirst: false });
  } else if (order === "newest" || order === "sequence") {
    q = q.order("created_at", { ascending: false }).order("shot_w", { ascending: false, nullsFirst: false });
  } else {
    q = q.order("shot_w", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
  }
  /**
   * ⚠ 同じ画面を1枚に絞るので、**多めに取る**（`limit` の4倍・最大2000）。
   *   時間順・細かく取る時は枠を広げて連続録画を落とさない。
   * ★ 仕組み㉑ focus 時: メモリでボタン照合するので枠を最大まで広げる
   *   （実測: 200件だと「所在地絞り込み＋」が0枚・沿線は4枚、とムラが出る）。
   */
  const fetchWide = order === "time" || order === "newest" || order === "sequence";
  const fetchCap = focusEarly.length || order === "sequence"
    ? 2000
    : Math.max(200, Math.min(2000, (opt.limit ?? 200) * 4 * (fetchWide ? 2 : 1)));
  q = q.limit(fetchCap);
  if (until) q = q.lt("created_at", until);
  if (opt.site && opt.site !== "all") q = q.eq("site", opt.site);
  if (opt.runId && String(opt.runId).trim()) {
    const cleanRun = String(opt.runId).trim().replace(/^run_/, "").replace(/[^a-z0-9_]/gi, "");
    if (cleanRun) q = q.ilike("shot_key", `%run_${cleanRun}/%`);
  }
  /**
   * ★ 2026-11-15 竹内さん「通常モードの写真から学習する」:
   *   **モードで絞る**（`normal` = 人の手本 / `aix` = 自動モード）。
   *   ⚠ 通常モードは人の手本として一番大事。分けて学ぶ。
   */
  if (opt.mode && opt.mode !== "all") q = q.eq("mode", opt.mode);
  const { data, error } = await q;
  if (error) return [];
  /**
   * ★ 2026-11-15 竹内さん「通常モードの録画でもちゃんと学習できるように」
   *
   *   ⚠ **実測で判明**: この関数が `shot_w` を**返していなかった**ので、
   *     呼ぶ側（`scripts/shot-learn.ts`）が大きさを出せず **`0px×186`** になっていた。
   *     「読める大きさだけ読む」判定もできず、**480px（読めない）を読んでいた**。
   *   → **`shot_w` を返す**。さらに:
   *     ・**480px 未満は読まない**（実測: 欄が1つも読めない＝お金の無駄）
   *     ・**同じ画面（操作の並びが同じ）は1枚だけ**（実測: 475枚のうち画面は82通りだけ）
   *     ・**大きい順**に読む（小窓が開いた瞬間の写真が一番読める）
   *     ・**時間順**（`order=time`）なら連続録画の流れどおり・同じ画面も stride 空けて細かく取る
   */
  type Row = {
    id: unknown; shot_key: string; site: string | null; mode: string | null;
    shot_w: number; created_at: string; shot_ops: Array<{ f?: unknown; k?: unknown }> | null;
  };
  type RowX = Row & { learned: boolean };
  const rows: RowX[] = ((data ?? []) as Array<{
    id: unknown; shot_key?: string | null; site?: string | null; mode?: string | null;
    shot_w?: number | null; shot_learn?: unknown; shot_ops?: unknown; created_at?: string;
  }>)
    .filter((r) => !!r.shot_key && ((focusEarly.length || opt.onlyNoScene) ? true : !r.shot_learn))
    .map((r) => ({
      id: r.id, shot_key: String(r.shot_key), site: r.site ?? null, mode: r.mode ?? null,
      shot_w: Number(r.shot_w) || 0,
      created_at: String(r.created_at ?? ""),
      shot_ops: Array.isArray(r.shot_ops) ? (r.shot_ops as Array<{ f?: unknown; k?: unknown }>) : null,
      learned: !!r.shot_learn,
    }))
    .filter((r) => r.shot_w >= 800);   // ⚠ 480px は読まない
  if (order === "time") {
    rows.sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || b.shot_w - a.shot_w);
  } else if (order === "newest") {
    rows.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || b.shot_w - a.shot_w);
  } else {
    rows.sort((a, b) => b.shot_w - a.shot_w);
  }
  /**
   * ★ 仕組み㉑: focus がある時は、そのボタン操作がある行だけを候補にする。
   *   未学習を先に・足りなければ学習済みを再読（そのボタンだけ強化）。
   */
  const focus = focusEarly;
  let focusedRows = focus.length
    ? rows.filter((r) => shotOpsMatchFocus(r.shot_ops, focus))
    : rows;
  if (focus.length) {
    focusedRows = [
      ...focusedRows.filter((r) => !r.learned),
      ...focusedRows.filter((r) => r.learned),
    ];
  }
  /**
   * ★ 連続録画を先頭→末尾の流れで読む（節目優先・中間は間引き）。
   *   `order=sequence` のときだけ。他の order の分岐はこの下で従来どおり。
   */
  if (order === "sequence") {
    const strideSeq = Math.max(0, Math.round(opt.strideMs ?? 1500) || 0);
    return pickSequenceShots(focusedRows, Math.max(1, opt.limit ?? 200), strideSeq, opt.runId);
  }
  // 同じ画面: 既定1枚。時間順・細かくは perSig と stride で票を増やす（位置の中央値が固まる）
  // ★ 2026-11-19 all: 同じ操作並びの上限も間引きも外す（全部読む）
  const perSig = opt.all
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, Math.min(20, Math.round(opt.perSig ?? (order === "time" || order === "newest" ? 8 : 1)) || 1));
  const strideMs = opt.all
    ? 0
    : Math.max(0, Math.round(opt.strideMs ?? (order === "time" || order === "newest" ? 1500 : 0)) || 0);
  const seen = new Map<string, number>();
  const lastAt = new Map<string, number>();
  const out: Array<{ id: unknown; shot_key: string; site: string | null; mode: string | null; shot_w: number; created_at?: string }> = [];
  for (const r of focusedRows) {
    const sig = (r.shot_ops ?? []).map((o) => String(o?.f ?? "") + ":" + String(o?.k ?? "")).join("|");
    const key = sig && sig !== ":diag" && sig !== ":" ? sig : "(操作なし)";
    const n = seen.get(key) ?? 0;
    if (n >= perSig) continue;
    const t = Date.parse(r.created_at) || 0;
    const prev = lastAt.get(key);
    if ((order === "time" || order === "newest") && strideMs > 0 && prev != null && Math.abs(t - prev) < strideMs) continue;
    seen.set(key, n + 1);
    if (t) lastAt.set(key, t);
    out.push({ id: r.id, shot_key: r.shot_key, site: r.site, mode: r.mode, shot_w: r.shot_w, created_at: r.created_at });
    if (out.length >= Math.max(1, opt.limit ?? 200)) break;
  }
  return out;
}

/** 写真1枚を Vision で読む（読めなければ null・投げない） */
export async function readShotFields(shotKey: string): Promise<ShotLearn | null> {
  const r = await readShotFieldsWithWhy(shotKey);
  return r.sl;
}

/**
 * ★ 2026-11-15 竹内さん「読み取り方なども学んだらその部分強化するように」:
 *   **読めなかった理由と時間**も返す。
 *   ⚠ 旧の `readShotFields` は `null` だけ返していたので、
 *     「何枚読めなかった」の**理由がどこにも残らなかった**（＝改善できない）。
 */
export async function readShotFieldsWithWhy(
  shotKey: string,
  opt?: { contextNote?: string; runId?: string | null },
): Promise<{ sl: ShotLearn | null; why: string | null; ms: number }> {
  const t0 = Date.now();
  const r = await readShotFieldsCore(shotKey, opt);
  return { sl: r.sl, why: r.why, ms: Date.now() - t0 };
}

/** 中身（理由付き）。`readShotFields` と `readShotFieldsWithWhy` の共通の実体 */
async function readShotFieldsCore(
  shotKey: string,
  opt?: { contextNote?: string; runId?: string | null },
): Promise<{ sl: ShotLearn | null; why: string | null }> {
  try {
    /**
     * Storage の**署名付き URL** を作る（非公開でも読める・公開設定に依存しない）。
     *   ⚠ 写真そのものをDBから読み直さない（重い）。Storage から直接読む。
     */
    const signed = await supabase.storage.from(BUCKET).createSignedUrl(shotKey, 60 * 10);
    const url = signed?.data?.signedUrl ?? null;
    if (!url) return { sl: null, why: "signed_url_failed:" + String(signed?.error?.message ?? "no_url").slice(0, 80) };
    /**
     * 2026-11-14 竹内さん「1から順に進めていく」→ **実測で判明（DeepSeek では読めない）**:
     *
     *   DeepSeek-V4.1-Flash に画像つきで投げると、**推論にトークンを全部使って `content` が空**になる。
     *     max_tokens 700  → content 0字（推論 550）
     *     max_tokens 2500 → content 0字（推論 2500・finish=length・推論 7,827字）
     *   ⚠ HTTP は 200 で返るので**成功に見える**（これが「読めた0枚」の正体）。
     *   ⚠ 小さい写真（480x244）では 2500 で `{"screen":"modal","fields":[]}` が返ったが、
     *     これは**欄が1つも読めていない**（＝写真が小さすぎる）。
     *
     *   Claude（claude-haiku-4-5）は同じ写真で **欄5個を正しく読めた**（実測・1枚 約6秒）:
     *     ピンポイント radio / 近い駅で検索 radio / リアプロで賃貸検索 button / 全条件キープ button
     *   → **Claude で読む**。DeepSeek が使えるのは「文を作る」ような推論が短くて済む仕事。
     */
    const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
    /**
     * ⚠ 2026-11-15: DeepSeek を主に使うので、**Claude のキーが無くても止めない**。
     *   どちらのキーも無い時だけ止める。
     */
    if (!apiKey && !(process.env.DEEPSEEK_API_KEY ?? "").trim()) {
      return { sl: null, why: "no_api_key:DEEPSEEK_API_KEY も ANTHROPIC_API_KEY も無い" };
    }
    /**
     * ★ 2026-11-15 竹内さん「画面全体見て把握できるようにする」:
     *
     *   ⚠ 旧は**左34%だけ**を切り出して読んでいた（中央の小窓を避けるため）。
     *     そのため**物件の一覧・ページ送り・小窓・右上の絞り込み**が1つも読めていなかった。
     *     実測: 写真から読めた名前は全部「左の条件」の物だけだった。
     *
     *   → **画面全体を読む**。ただし次の2つで小窓の誤読を防ぐ:
     *     ① 撮る時に**拡張の小窓を隠している**（v2.7.62〜 `_hideForShot`）
     *     ② 隠せていない時のために、**左34%を切り出した物も一緒に渡す**（全体で読めない時の保険）
     *
     *   ⚠ 切り出しは**等倍のまま**（縮めない）。縮めてから切ると欄が潰れる（実測 163px）。
     *   ⚠ 領域（left/top/center/bottom/modal）は `zone` として残す（どこに何があるか）。
     */
    const LEFT_CROP_RATIO = 0.34;

    /**
     * 画像を**縮めずに**読み込む（必要なら左だけ切り出す）。
     *   ⚠ 旧は 1200px に拡大していたが、元が小さいと**嘘の解像度**になるだけなので拡大しない。
     *     大きすぎる時（2000px超）だけ縮める（費用と転送のため）。
     */
    const loadImage = async (mode: "whole" | "left"): Promise<Buffer | null> => {
      try {
        const sharpMod = (await import("sharp")).default;
        const r = await fetch(url);
        if (!r.ok) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        const meta = await sharpMod(buf).metadata();
        const W = Number(meta.width) || 0;
        const H = Number(meta.height) || 0;
        if (!W || !H) return null;
        const MAX_SIDE = 2000;   // これを超える時だけ縮める（読める大きさは保つ）
        if (mode === "left") {
          const w = Math.max(80, Math.round(W * LEFT_CROP_RATIO));
          return await sharpMod(buf).extract({ left: 0, top: 0, width: w, height: H }).jpeg({ quality: 90 }).toBuffer();
        }
        const long = Math.max(W, H);
        if (long > MAX_SIDE) return await sharpMod(buf).resize({ width: MAX_SIDE, kernel: "lanczos3" }).jpeg({ quality: 90 }).toBuffer();
        return await sharpMod(buf).jpeg({ quality: 90 }).toBuffer();
      } catch { return null; }
    };

    /**
     * ★ 2026-11-15 竹内さん「DeepSeek 対応を入れて画像学習する」:
     *   max_tokens 12000 が必要（短いと推論で打ち切られ 0字）。
     * ★ 2026-11-16「画像よむのはflashでまとめるのは統括（Pro）」:
     *   Vision は **deepseek-flash のみ**。Pro は learn-supervisor-pro（まとめ層）。混ぜない。
     *   ⚠ Claude は DeepSeek キー無し時だけ。thinking disabled は使わない。
     */
    /** 1回読む（base64 を渡す）。⚠ 読めなかった**理由**も返す */
    const ctxNote = opt?.contextNote
      ? `\n参考文脈（このコマの直前操作と連続流れ。画面から見える事実を優先）: ${String(opt.contextNote).slice(0, 400)}`
      : "";
    const ask = async (b64: string, note: string): Promise<{ sl: ShotLearn | null; why: string | null }> => {
      const dsKey = (process.env.DEEPSEEK_API_KEY ?? "").trim();
      const model = shotLearnModel(process.env);
      if (dsKey) {
        const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${dsKey}` },
          body: JSON.stringify({
            model,
            max_tokens: Math.max(12000, Number(process.env.SHOT_LEARN_MAX_TOKENS) || 12000),
            reasoning_effort: (process.env.SHOT_LEARN_EFFORT ?? "low").trim(),
            messages: [
              { role: "system", content: SHOT_LEARN_PROMPT },
              {
                role: "user",
                content: [
                  { type: "text", text: note },
                  { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          return { sl: null, why: `deepseek_http_${res.status}:` + String(t).slice(0, 100) };
        }
        const j = await res.json() as {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
        };
        const text = String(j.choices?.[0]?.message?.content ?? "").trim();
        const finish = String(j.choices?.[0]?.finish_reason ?? "");
        if (!text) {
          const rn = String(j.choices?.[0]?.message?.reasoning_content ?? "").length;
          return { sl: null, why: `deepseek_empty(finish=${finish}・推論${rn}字)` + (finish === "length" ? ":max_tokens不足" : "") };
        }
        const parsed = parseShotLearn(text);
        if (!parsed.fields.length && parsed.screen === "other") return { sl: null, why: "no_fields:" + text.slice(0, 80) };
        return { sl: parsed, why: null };
      }
      /** 予備: DeepSeek のキーが無い時だけ Claude */
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: process.env.SHOT_LEARN_CLAUDE_MODEL || "claude-haiku-4-5",
          max_tokens: 4000,
          system: SHOT_LEARN_PROMPT,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: note },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { sl: null, why: `claude_http_${res.status}:` + String(t).slice(0, 100) };
      }
      const j = await res.json() as { content?: Array<{ text?: string }>; stop_reason?: string };
      const text = String(j.content?.[0]?.text ?? "").trim();
      if (!text) return { sl: null, why: "claude_empty(stop=" + String(j.stop_reason ?? "?") + ")" };
      const parsed = parseShotLearn(text);
      if (!parsed.fields.length && parsed.screen === "other") return { sl: null, why: "no_fields:" + text.slice(0, 80) };
      return { sl: parsed, why: null };
    };

    /**
     * ① **画面全体**を読む（本命）。左の条件・中央の一覧・下のページ送りまで見る。
     *   ⚠ 撮る時に拡張の小窓は隠している（v2.7.62〜）ので、全体でも誤読しにくい。
     */
    const whole = await loadImage("whole");
    if (whole) {
      const r1 = await ask(
        whole.toString("base64"),
        "この画面写真の**全体**から、フォームの作りを読み取って JSON で返してください。"
        + "左の条件だけでなく、上の見出し・中央の一覧・下のページ送り・小窓も見てください。"
        + "欄の名前は画像の文字をそのまま書き、読めない時は name を null にしてください。"
        + "x と y は**この画像全体**の中の割合（左上0・右下1）で返してください。"
        + "それぞれの欄が画面のどの領域か（left/top/center/right/bottom/modal）も zone に入れてください。"
        + "連続録画の流れとして scene・flow_step・transition・stuck も読めれば JSON に入れてください。"
        + ctxNote,
      );
      if (r1.sl && r1.sl.fields.length) return { sl: r1.sl, why: null };
      /**
       * ② 全体で読めなかった（小窓が覆っている等）時だけ、**左を切り出して**読む（保険）。
       *   ⚠ この時は座標を元の写真の割合に戻す（切り出した幅の分だけ x を縮める）。
       */
      const left = await loadImage("left");
      if (left) {
        const r2 = await ask(
          left.toString("base64"),
          "この画像は**画面の左側（検索条件の欄）だけ**を切り出した物です。"
          + "ここに見えているフォームの欄だけを JSON で返してください。"
          + "欄の名前は画像の文字をそのまま書き、読めない時は name を null にしてください。"
          + "x と y は**この画像の中**の割合（左端0・右端1）で返してください。"
          + "連続録画の流れとして scene・flow_step・transition・stuck も読めれば JSON に入れてください。"
          + ctxNote,
        );
        if (r2.sl && r2.sl.fields.length) {
          return {
            sl: {
              ...r2.sl,
              fields: r2.sl.fields.map((f) => ({
                ...f,
                x: typeof f.x === "number" ? Math.round(f.x * LEFT_CROP_RATIO * 100) / 100 : null,
                zone: f.zone || "left",
              })),
            },
            why: null,
          };
        }
        return { sl: null, why: r1.why || r2.why || "no_fields(全体も左も読めず)" };
      }
      return { sl: null, why: r1.why || "no_fields(全体で読めず・左の切り出しも作れず)" };
    }
    return { sl: null, why: "image_load_failed:写真を取れない" };
  } catch (e) {
    return { sl: null, why: "exception:" + String((e && (e as Error).message) || e).slice(0, 100) };
  }
}

/**
 * 弱い所がある写真だけ読んで `shot_learn` に書き戻す。
 *   ⚠ `dry_run` の時は**読むだけで書かない**（費用を確かめる時）。
 */
export async function learnFromWeakShots(
  opt: {
    site?: string | null; mode?: string | null; days?: number; limit?: number;
    from?: string | null; to?: string | null; perSig?: number;
    order?: "size" | "time" | "newest" | "sequence"; strideMs?: number;
    dryRun?: boolean; noRefresh?: boolean; concurrency?: number;
    /** 仕組み㉑: このボタン／欄の操作が写っている写真だけ読む */
    focusFields?: string[] | null;
    /** `order=sequence` のとき優先 run */
    runId?: string | null;
    /** 場面の印が無い写真だけ読み直す（2026-11-18） */
    onlyNoScene?: boolean;
    /** ★ 2026-11-19: 窓の中の読める未学習を全部読む（同じ画面の上限・間引きなし） */
    all?: boolean;
    onProgress?: (done: number, total: number, last: string) => void;
  } = {},
): Promise<{ tried: number; learned: number; saved: number; skipped: number; fields: number; errors: string[]; recipe?: string; refreshed?: boolean }> {
  // ★ 2026-11-16: 統括が付けた limit を尊重（硬上限まで）。旧は shotLearnMax()=60 で潰していた。
  const max = resolveShotLearnLimit(opt.limit);
  const out: { tried: number; learned: number; saved: number; skipped: number; fields: number; errors: string[]; recipe?: string; refreshed?: boolean } = { tried: 0, learned: 0, saved: 0, skipped: 0, fields: 0, errors: [] };
  const targets = (await findShotsToLearn({
    site: opt.site, mode: opt.mode, days: opt.days, limit: max,
    from: opt.from, to: opt.to, perSig: opt.perSig,
    order: opt.order, strideMs: opt.strideMs,
    focusFields: opt.focusFields,
    runId: opt.runId,
    onlyNoScene: opt.onlyNoScene,
    all: opt.all,
  })).slice(0, max);
  /**
   * ★ 2026-11-15 竹内さん「読み取り方なども学んだらその部分強化するように」「２でやる」:
   *   **どの読み方で何枚読めたか**を残す（成功も失敗も）。
   *   ⚠ これが無いと「max_tokens 8000 で0枚・12000 で58個」のような発見が
   *     その場の会話にしか残らず、次に同じ失敗をする。
   */
  const outcomes: Array<{ ok: boolean; fields: number; ms: number; why?: string | null }> = [];
  /**
   * ⚠ 2026-11-15 **実測で見つけた無駄**: `concurrency`（`--conc`）を受け取っていたのに
   *   **どこでも使っていなかった**（1枚ずつ順番に読んでいた）。
   *   実測: 55枚が 200秒たっても1枚も返らない（1枚 30〜60秒 × 55枚＝**約27〜55分**）。
   *   → **同時に読む**（既定4）。1枚あたりの待ちはそのままだが、全体の時間が 1/4 になる。
   *   ⚠ API の制限に当たるので**最大6**まで（それ以上は 429 で逆に遅くなる）。
   *   ⚠ 書く順番は問わない（写真ごとに別の行を更新するので衝突しない）。
   */
  const conc = Math.max(1, Math.min(6, Math.round(opt.concurrency ?? 4) || 4));
  /** 同じ run の直前コマ（並列でもレース安全: 時刻が新しい方だけ残す） */
  const lastRunContext = new Map<string, { screen?: string; scene?: string; flow_step?: string; at: number }>();
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const t = targets[i];
      out.tried++;
      const runId = (t as { run_id?: string | null }).run_id ?? (runOfShotKey(t.shot_key) || null);
      let contextNote = (t as { context_note?: string | null }).context_note ?? undefined;
      if (runId) {
        const prev = lastRunContext.get(runId);
        if (prev?.screen || prev?.scene || prev?.flow_step) {
          const add = `前コマ screen=${prev.screen ?? "-"} scene=${prev.scene ?? "-"} flow=${prev.flow_step ?? "-"}`;
          contextNote = contextNote ? `${contextNote} / ${add}` : add;
        }
      }
      const got = await readShotFieldsWithWhy(t.shot_key, { contextNote, runId });
      const sl = got.sl;
      if (!sl) {
        out.skipped++;
        outcomes.push({ ok: false, fields: 0, ms: got.ms, why: got.why });
      } else {
        out.learned++;
        out.fields += sl.fields.length;
        outcomes.push({ ok: true, fields: sl.fields.length, ms: got.ms });
        if (runId) {
          const at = Date.parse(String(t.created_at ?? "")) || 0;
          const cur = lastRunContext.get(runId);
          if (!cur || at >= cur.at) {
            lastRunContext.set(runId, {
              screen: sl.screen,
              scene: sl.scene,
              flow_step: sl.flow_step,
              at,
            });
          }
        }
        if (!opt.dryRun) {
          const rid = runId || runOfShotKey(t.shot_key);
          const payload = { ...sl, ...(rid ? { run_id: rid } : {}) };
          /**
           * ★ 2026-11-17: update がエラー無しでも 0 行のことがある（RLS・IDずれ）。
           *   select で返った行を見てから saved にする（空振りを「保存40」と誤報しない）。
           */
          const { data: wrote, error } = await supabase
            .from("human_motion_learn")
            .update({ shot_learn: payload })
            .eq("id", t.id)
            .select("id");
          if (error) out.errors.push(String(error.message).slice(0, 120));
          else if (!wrote || !wrote.length) out.errors.push(`shot_learn書き込み0行 id=${String(t.id).slice(0, 8)}`);
          else out.saved++;
        }
      }
      done++;
      const tag = got.why ?? `${sl?.fields.length ?? 0}個(${sl?.screen ?? "?"}/${sl?.scene ?? "-"}${sl?.flow_step ? ":" + sl.flow_step : ""}${sl?.stuck ? " 詰:" + sl.stuck : ""})`;
      try { opt.onProgress?.(done, targets.length, tag); } catch (_) { /* 表示の失敗で学習を止めない */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, targets.length) }, () => worker()));
  /**
   * 読み方の成績を残す（⚠ dry-run では書かない・失敗しても学習は止めない）。
   */
  if (!opt.dryRun && outcomes.length) {
    try {
      const { saveReadRecipeScore } = await import("./read-recipe");
      const recipe = {
        model: shotLearnModel(process.env),
        maxTokens: Number(process.env.SHOT_LEARN_MAX_TOKENS) || 12000,
        effort: process.env.SHOT_LEARN_EFFORT || "low",
        area: "whole" as const,
      };
      const r = await saveReadRecipeScore(recipe, outcomes);
      out.recipe = r.summary
        ? `${r.summary.ok}/${r.summary.tried}枚・欄${r.summary.fields}個・1枚${r.summary.fieldsPerOk}個${r.summary.topWhy ? `（読めない理由 ${r.summary.topWhy}）` : ""}`
        : undefined;
    } catch (_) { /* 記録できなくても学習は終わっている */ }
  }
  /**
   * ★ 2026-11-15 竹内さん「反映させる」→ **実測で見つけた問題**:
   *
   *   ⚠ 学習したのに**束を作り直さないと統括・拡張に届かない**。
   *     実測: 写真から4,836個の欄を学んだのに、古い束（11:03:07）には入っていなかった。
   *     手で `--apply` を実行して初めて届いた。
   *
   *   → **学習の後に自動で束を作り直す**（`--no-refresh` で止められる）。
   *     ⚠ 失敗しても学習は終わっている（束は次のcronでも作られる）。
   */
  if (!opt.dryRun && out.saved > 0 && !opt.noRefresh) {
    try {
      const { buildHumanLearnBundle, compactBundle } = await import("./human-learn-brain");
      const since2 = new Date(Date.now() - LEARN_PERIODS.historyMs).toISOString();
      const all: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 10_000; i += 1000) {
        const r = await supabase.from("human_motion_learn").select("*")
          .gte("created_at", since2).order("created_at", { ascending: false }).range(i, i + 999);
        if (r.error) throw new Error(String(r.error.message).slice(0, 120));
        all.push(...((r.data ?? []) as Array<Record<string, unknown>>));
        if ((r.data ?? []).length < 1000) break;
      }
      const nowMs = Date.now();
      const { fetchLearnBundleSceneMeta } = await import("./learn-bundle-scene-meta");
      const sceneMetaAll = await fetchLearnBundleSceneMeta(supabase, "all");
      const bundle = compactBundle(buildHumanLearnBundle(all as never, nowMs, null, null, sceneMetaAll));
      /**
       * ⚠ 2026-11-15 実測: `generated_at` 列は**存在しない**（実際の列は id・created_at・scope・source_rows・
       *   source_from・source_to・ext_version・bundle・lines・read_at・read_count）。
       *   入れると `Could not find the 'generated_at' column` で**束が作れない**。
       *   → `created_at` は自動で入るので、**送らない**（bundle の中に生成時刻を持たせる）。
       *
       * ★ 2026-11-15「改善したら更新されていく」「ボトルネック」:
       *   ⚠ 実測: `all` だけ更新して `realpro` が古いまま → 拡張が古い realpro（x/y=0）を優先して
       *     新しい学びが自動に届かなかった。→ **サイト別も同じタイミングで書く**。
       */
      const { inheritLinkFoundations } = await import("./learn-bundle-preserve");
      const candidates: Array<{ scope: string; source_rows: number; bundle: Record<string, unknown> }> = [
        { scope: "all", source_rows: all.length, bundle: bundle as unknown as Record<string, unknown> },
      ];
      for (const site of ["realpro", "itandi"] as const) {
        const sub = all.filter((r) => {
          const s = String((r as { site?: unknown }).site ?? "").toLowerCase();
          return site === "realpro" ? (s === "realpro" || s.includes("realnet")) : (s === "itandi" || s.includes("itandi"));
        });
        if (sub.length < 3) continue;
        const sceneMetaSite = await fetchLearnBundleSceneMeta(supabase, site);
        candidates.push({
          scope: site,
          source_rows: sub.length,
          bundle: compactBundle(buildHumanLearnBundle(sub as never, nowMs, null, null, sceneMetaSite)) as unknown as Record<string, unknown>,
        });
      }
      const rows: Array<{ scope: string; source_rows: number; bundle: Record<string, unknown> }> = [];
      for (const c of candidates) {
        const { INHERIT_LOOKBACK_DEFAULT } = await import("./learn-bundle-preserve");
        const pr = await inheritLinkFoundations(supabase, c.bundle, c.scope, { lookback: INHERIT_LOOKBACK_DEFAULT, minSolid: 30 });
        if (!pr.safe_to_write) {
          out.errors.push(`束の作り直し拒否(${c.scope}): ${pr.why}`);
          continue;
        }
        rows.push(c);
      }
      if (!rows.length) {
        out.refreshed = false;
        out.errors.push("束の作り直し: 全scopeで消す書き込みを拒否");
      } else {
        const ins = await supabase.from("human_learn_profile").insert(rows);
        out.refreshed = !ins.error;
        if (ins.error) out.errors.push("束の作り直し: " + String(ins.error.message).slice(0, 100));
      }
    } catch (e) {
      out.errors.push("束の作り直し: " + String((e as Error)?.message ?? e).slice(0, 100));
    }
  }
  return out;
}

/**
 * ★ 2026-11-14 竹内さん「直近画像から 画像を連続でみて左側の押したところのこと…データベースの入っている直近の録画から連続して統括が学習する」
 *
 *   **1枚だけ読むと誤読する**（実測: 「磁性会社こらみ」「所在物件つじ込み」「駅徒歩駅中」）。
 *   同じ欄は**複数の写真に写っている**ので、**位置ごとに多数決**すれば確かな物だけ残せる。
 *
 *   実測（録画 mwgf1gx3_n1k5 の 1280px 15枚 → 多数決）:
 *     32個の欄が2枚以上に出た（select 2・checkbox 4・text 8・button 18）
 *       0.15,0.10 マップ検索（14回とも同じ名前）
 *       0.15,0.20 閲覧履歴 / 0.15,0.30 リセット / 0.15,0.70 検索
 *       0.15,0.40 駅からの移動手段 / 0.10,0.80 select 賃料 / 0.10,0.25 select 下限なし
 *
 *   ⚠ 位置は **0.05 刻み**に丸めて同じ欄とみなす（撮影ごとに数pxずれる）。
 *   ⚠ **2枚以上**出た位置だけ採用（1枚だけは偶然・誤読の可能性）。
 *   ⚠ 名前は「同じ名前が一番多く出た物」。1回しか出ていない名前は**空にする**（嘘を残さない）。
 */
export function voteFieldsFromRuns(
  perShot: ReadonlyArray<ReadonlyArray<{ name?: string | null; kind?: string; x?: number | null; y?: number | null }>>,
  opt: { minVotes?: number; minNameVotes?: number } = {},
): Array<{ name: string | null; kind: string; x: number; y: number; votes: number; nameVotes: number }> {
  const minVotes = opt.minVotes ?? 2;
  const minNameVotes = opt.minNameVotes ?? 2;
  /**
   * ⚠ 2026-11-14 **実測で分かった誤り**: 最初は**位置（0.05刻み）で束ねて**多数決しようとしたが、
   *   同じ欄でも写真ごとに **y が 0.47〜0.50 もずれた**（実測）:
   *     リセット   y=0.49/0.68/0.22/0.28/0.72/0.67  ← ばらつき 0.50
   *     検索       y=0.56/0.78/0.31/0.36            ← ばらつき 0.47
   *     フリーワード y=0.63/0.40/0.44/0.88           ← ばらつき 0.48
   *   ⚠ 理由: **写真ごとに画面のスクロール位置・小窓の高さが違う**（同じ欄が別の高さに写る）。
   *     だから位置で束ねると**同じ欄がバラバラに数えられ**、名前が `null` ばかりになった。
   *
   *   → **名前で束ねる**（位置は平均を取る）。
   *     ⚠ 名前が読めなかった物（null）は束ねられないので**捨てる**（学習に使えない）。
   *     ⚠ 名前が**2枚以上で同じ**なら確か（1枚だけの名前は誤読の可能性＝捨てる）。
   */
  const acc = new Map<string, { kinds: Map<string, number>; xs: number[]; ys: number[]; n: number }>();
  for (const fields of perShot) {
    const seen = new Set<string>();   // 1枚の中で同じ名前を2回数えない
    for (const f of Array.isArray(fields) ? fields : []) {
      const nm = typeof f?.name === "string" ? f.name.trim() : "";
      if (!nm) continue;              // 名前が無い物は学習に使えない（捨てる）
      if (seen.has(nm)) continue;
      seen.add(nm);
      if (!acc.has(nm)) acc.set(nm, { kinds: new Map(), xs: [], ys: [], n: 0 });
      const v = acc.get(nm)!;
      v.n++;
      const kd = String(f.kind || "other");
      v.kinds.set(kd, (v.kinds.get(kd) || 0) + 1);
      if (typeof f.x === "number") v.xs.push(f.x);
      if (typeof f.y === "number") v.ys.push(f.y);
    }
  }
  const med = (a: number[]) => {
    if (!a.length) return 0;
    const s = a.slice().sort((p, q) => p - q);
    return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
  };
  const out: Array<{ name: string | null; kind: string; x: number; y: number; votes: number; nameVotes: number }> = [];
  for (const [nm, v] of acc) {
    if (v.n < Math.max(minVotes, minNameVotes)) continue;
    const kind = [...v.kinds.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // ⚠ 位置は**中央値**（ばらつきが大きいので平均より外れに強い）
    out.push({ name: nm, kind, x: med(v.xs), y: med(v.ys), votes: v.n, nameVotes: v.n });
  }
  return out.sort((a, b) => b.votes - a.votes);
}

/**
 * 直近の録画（1つの `run_id`）を**連続で読んで多数決**し、確かな欄を返す。
 *   ⚠ 費用がかかる（1枚ごと）。`maxShots` で上限を決める（既定5枚）。
 *   ⚠ `dryRun` の時は**書かない**（読むだけ）。
 */
export async function learnFromLatestRun(
  opt: { maxShots?: number; dryRun?: boolean; runId?: string } = {},
): Promise<{
  run: string | null; shots: number; read: number; fields: number;
  byKind: Record<string, number>; saved: number; sample: Array<{ name: string | null; kind: string; votes: number }>;
}> {
  const maxShots = Math.max(1, Math.min(12, opt.maxShots ?? 5));
  const empty = { run: null, shots: 0, read: 0, fields: 0, byKind: {}, saved: 0, sample: [] };
  try {
    // ① 直近の写真から run_id を決める（指定が無ければ一番新しい物）
    const { data: recent } = await supabase
      .from("human_motion_learn")
      .select("id, created_at, shot_key, shot_w, shot_taken, shot_learn")
      .eq("shot_taken", true).not("shot_key", "is", null)
      .order("created_at", { ascending: false }).limit(200);
    const rows = (recent ?? []) as Array<{ id: unknown; created_at: string; shot_key: string; shot_w?: number | null; shot_learn?: unknown }>;
    if (!rows.length) return empty;
    const runOf = (k: string) => (k.match(/run_([a-z0-9_]+)\//i) || [])[1] || "";
    const run = opt.runId || runOf(rows[0].shot_key);
    if (!run) return empty;

    /**
     * ② その録画の写真を**時間順**に取る（連続録画の流れどおり・細かく位置を固める）。
     *   ★ 2026-11-15「順番で時間で学習すればより強化」「連続録画で」
     *   ⚠ まだ読んでいない物を優先（既に `shot_learn` がある物は飛ばす）。
     *   ⚠ 同じ時刻帯では大きい写真を先に（窓が開いた瞬間が読める）。
     */
    const inRun = rows.filter((r) => runOf(r.shot_key) === run);
    const unlearned = inRun.filter((r) => !r.shot_learn);
    const pick = (unlearned.length ? unlearned : inRun)
      .slice()
      .filter((r) => (Number(r.shot_w) || 0) >= 800)
      .sort((a, b) =>
        (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)
        || (Number(b.shot_w) || 0) - (Number(a.shot_w) || 0))
      .slice(0, maxShots);
    if (!pick.length) return { ...empty, run };

    // ③ 1枚ずつ読む
    const perShot: Array<Array<{ name: string | null; kind: string; x?: number | null; y?: number | null }>> = [];
    let read = 0;
    for (const p of pick) {
      const sl = await readShotFields(p.shot_key);
      if (!sl) continue;
      read++;
      perShot.push(sl.fields);
    }
    if (!read) return { ...empty, run, shots: pick.length };

    // ④ 多数決
    const voted = voteFieldsFromRuns(perShot);
    const byKind: Record<string, number> = {};
    for (const v of voted) byKind[v.kind] = (byKind[v.kind] || 0) + 1;

    // ⑤ 代表の1行（一番大きい写真）に書き戻す
    /**
     * ⚠ 2026-11-14 竹内さん「これで画像の部分から学習できるようにする」:
     *   旧は**代表の1行にしか書いていなかった**ので、同じ録画の他の写真は
     *   `shot_learn` が空のままだった（＝その写真は「まだ読んでいない」と数えられ、
     *   次の実行でまた読んで**同じ費用を何度も払う**）。
     *   → 同じ録画（run）の写真は**同じ画面**なので、多数決の結果を**全枚に配る**。
     *     ⚠ 配るのは `run` を付けた結果だけ（別の録画には配らない＝画面が違う）。
     *     ⚠ 写真ごとに読んだ結果ではないので `by` は `llm_run`（区別できるように）。
     */
    let saved = 0;
    const payload = {
      screen: "form" as const,
      by: "llm_run" as const,
      confidence: Math.min(0.95, Math.round((voted.filter((v) => v.votes >= 3).length / Math.max(1, voted.length)) * 100) / 100),
      fields: voted.map((v) => ({ name: v.name ?? "", kind: v.kind, x: v.x, y: v.y })),
      run_id: run,
      votes: voted.map((v) => ({ x: v.x, y: v.y, n: v.votes, name_n: v.nameVotes })),
      learned_shots: read,
      applied_to: "run",
    };
    if (!opt.dryRun && voted.length) {
      // ① 代表の1行（読んだ写真の中で一番大きい物）
      const target = pick[0];
      const one = await supabase.from("human_motion_learn").update({ shot_learn: payload }).eq("id", target.id);
      if (!one.error) saved = 1;
      // ② 同じ録画の残り（まだ shot_learn が空の物だけ）
      try {
        const ids = inRun.filter((r) => !r.shot_learn && String(r.id) !== String(target.id)).map((r) => r.id);
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          if (!chunk.length) continue;
          const up = await supabase.from("human_motion_learn").update({ shot_learn: payload }).in("id", chunk);
          if (!up.error) saved += chunk.length;
        }
      } catch { /* 配れなくても代表の1行は入っている */ }
    }

    return {
      run, shots: pick.length, read, fields: voted.length, byKind, saved,
      sample: voted.slice(0, 10).map((v) => ({ name: v.name, kind: v.kind, votes: v.votes })),
    };
  } catch {
    return empty;
  }
}
