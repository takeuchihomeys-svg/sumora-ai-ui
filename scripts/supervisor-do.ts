/**
 * 統括の「次にやる事」を実行する（2026-11-14 竹内さん「統括ちゃんと機能できるように」）
 *
 * なぜ要るか:
 *   統括は `actions`（次にやる事）を出しているが、**それを実行する手段が無かった**。
 *   判断だけして動かないなら統括は機能していない。
 *
 * 実行:
 *   npx tsx --env-file=.env.local scripts/supervisor-do.ts            … 何ができるか一覧
 *   npx tsx --env-file=.env.local scripts/supervisor-do.ts --list      … 同上
 *   npx tsx --env-file=.env.local scripts/supervisor-do.ts --run=1     … 1番を実行
 *   npx tsx --env-file=.env.local scripts/supervisor-do.ts --run=all   … 安全な物だけ全部
 *   --scope=realpro / --scope=itandi
 *
 * ⚠ 自動で**サイトを触らない**・**DBを消さない**。やるのは「点検・数え直し・記録の補完」だけ。
 * ⚠ 実行できない物（人が判断する物）は「**竹内さんに聞く**」として出し、勝手にやらない。
 */
import { supabase } from "../app/lib/supabase-server";

const BASE = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
const args = process.argv.slice(2);
const scope = (args.find((a) => a.startsWith("--scope=")) || "").replace("--scope=", "") || "all";
const runArg = (args.find((a) => a.startsWith("--run=")) || "").replace("--run=", "");

type Action = { priority: number; what: string; why?: string; how?: string; name?: string };
/** 2026-11-14: 統括が自分で決めた「次に学ぶ事」 */
type Task = { kind: string; what: string; why: string; cost: string; limit?: number };

/** 統括の判断を取る */
async function fetchAdv(): Promise<{ actions: Action[]; tasks: Task[]; verdict: string; headline: string; err: string | null }> {
  try {
    const r = await fetch(`${BASE}/api/human-learn-profile?fresh=1&scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
    if (!r.ok) return { actions: [], tasks: [], verdict: "", headline: "", err: "http_" + r.status };
    const j = (await r.json()) as Record<string, unknown>;
    const b = (j.bundle ?? null) as Record<string, unknown> | null;
    if (!b) return { actions: [], tasks: [], verdict: "", headline: "", err: "束がありません" };
    const sup = (scope === "all"
      ? b.supervisor
      : ((b.supervisor_by_site ?? {}) as Record<string, unknown>)[scope]) as Record<string, unknown> | undefined;
    if (!sup) return { actions: [], tasks: [], verdict: "", headline: "", err: "統括の判断がありません" };
    /**
     * 2026-11-14 竹内さん「ちゃんとここの連携細かくできるようにする」:
     *   ⚠ 旧は `actions` しか読んでいなかったので、統括が決めた**順番（learning_tasks）**を
     *     実行する側が知らなかった（＝判断と実行が繋がっていなかった）。
     *   → `meeting.learning_tasks` も読む（統括が決めた順・費用つき）。
     */
    const meeting = (sup.meeting ?? null) as Record<string, unknown> | null;
    const rawTasks = meeting && Array.isArray(meeting.learning_tasks) ? (meeting.learning_tasks as Task[]) : [];
    return {
      actions: Array.isArray(sup.actions) ? (sup.actions as Action[]) : [],
      tasks: rawTasks.filter((t) => t && typeof t.kind === "string"),
      verdict: String(sup.verdict || ""),
      headline: String(sup.headline || ""),
      err: null,
    };
  } catch (e) {
    return { actions: [], tasks: [], verdict: "", headline: "", err: String((e as Error).message || e) };
  }
}

/**
 * 統括が決めた「次に学ぶ事」を実行できる形にする（2026-11-14 竹内さん「連携細かく」）。
 *
 *   ⚠ **無料で効く物だけ自動でやる**。お金がかかる `photo_learn` は**勝手に走らせない**
 *     （`--yes-cost` を付けた時だけ・枚数の上限つき）。
 *   ⚠ 人が必要な物（`need_human`）は「竹内さんにしかできない」として出す。
 */
const TASK_RUN: Record<string, { label: string; cost: boolean; run: () => Promise<string> }> = {
  fix_scene: {
    label: "止まる場面を、人の手本と比べて探す（点検を数え直す）",
    cost: false,
    run: async () => {
      const r = await fetch(`${BASE}/api/human-learn-profile?fresh=1&scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
      if (!r.ok) return "http_" + r.status;
      const j = (await r.json()) as Record<string, unknown>;
      const b = (j.bundle ?? {}) as Record<string, unknown>;
      const stop = String(b.stopped_scene || "");
      const flows = Array.isArray(b.scene_flows) ? (b.scene_flows as Array<Record<string, unknown>>) : [];
      const f = flows.find((x) => String(x.scene || "") && stop.indexOf(String(x.scene)) >= 0);
      return stop
        ? `止まる場面: ${stop}／手本: ${f ? `${f.runs}回・${f.ops}手・順番${f.variants}通り` : "（その場面の手本なし）"}`
        : "止まる場面は分かりませんでした";
    },
  },
  fix_record: {
    label: "録画の記録（操作の並び）の状態を数え直す",
    cost: false,
    run: async () => {
      const r = await fetch(`${BASE}/api/human-motion?days=3&limit=1000`, { cache: "no-store" });
      if (!r.ok) return "http_" + r.status;
      const j = (await r.json()) as { rows?: Array<Record<string, unknown>> };
      const rows = j.rows ?? [];
      const withOps = rows.filter((x) => Array.isArray(x.shot_ops) && (x.shot_ops as unknown[]).some((o) => {
        const k = String((o as Record<string, unknown>)?.k ?? "");
        return k !== "diag" && k !== "same";
      })).length;
      const withOrder = rows.filter((x) => Array.isArray(x.field_order) && (x.field_order as unknown[]).length > 0).length;
      return `${rows.length}件のうち 操作の並び ${withOps}件・押した欄の順 ${withOrder}件`;
    },
  },
  photo_learn: {
    label: "弱い所の写真から欄の種類を読む（**1枚ごとに費用**）",
    cost: true,
    run: async () => {
      /**
       * ⚠ Vision はお金がかかる。**枚数の上限**を必ず付ける（統括が決めた limit・既定20）。
       *   ここでは API を叩かず、**手元のスクリプトを案内する**（このスクリプトはサイトもDBも触らない方針）。
       *   → `--yes-cost` の時だけ `scripts/shot-learn.ts` と同じ処理を呼ぶ。
       */
      const t = (globalThis as unknown as { __task?: Task }).__task;
      const limit = Math.max(1, Math.min(60, Number(t?.limit) || 20));
      const { learnFromWeakShots } = await import("../app/lib/shot-learn-server");
      const r = await learnFromWeakShots({ site: scope === "all" ? null : scope, days: 7, limit, dryRun: false });
      return `試した ${r.tried}枚・読めた ${r.learned}枚（欄 ${r.fields}個）・保存 ${r.saved}枚${r.errors.length ? "・エラー " + r.errors.length : ""}`;
    },
  },
  need_human: {
    label: "人が1回やる必要があります（私からは押せません）",
    cost: false,
    run: async () => "人が1回検索してください（この場面は手本が無いので自動にできません）",
  },
};

/**
 * 実行できる物（安全な物だけ）。
 *   ⚠ サイトを触らない・DBを消さない。数え直しと記録の補完だけ。
 *   ⚠ 2026-11-14: 「操作が付く記録が少なすぎる」は **`shot_learn` では直らない**（`shot_ops` と別物）。
 *     できもしないのに「私がやります」と言わないため、ここには入れない（`whyCannotRun` で説明する）。
 */
const RUNNABLE: Array<{
  match: RegExp;
  label: string;
  run: () => Promise<string>;
}> = [
  {
    match: /記録と写真で欄の種類が違う|写真の中で種類が割れている|種類が分からない/,
    label: "`shot_learn` を埋め直す（種類の食い違いを解消）",
    run: async () => {
      const r = await fetch(`${BASE}/api/learn-fill-shot`, { cache: "no-store" });
      const j = (await r.json()) as Record<string, unknown>;
      return String(j.message || JSON.stringify(j).slice(0, 160));
    },
  },
  {
    match: /^記録と写真で欄の種類が違う|^写真の中で種類が割れている|^種類が分からない/,
    label: "`shot_learn` を埋め直す（種類の食い違いを解消）",
    run: async () => {
      const r = await fetch(`${BASE}/api/learn-fill-shot`, { cache: "no-store" });
      const j = (await r.json()) as Record<string, unknown>;
      return String(j.message || JSON.stringify(j).slice(0, 160));
    },
  },
  {
    match: /学習の束を作り直/,
    label: "学習の束を作り直す",
    run: async () => {
      const r = await fetch(`${BASE}/api/human-learn-profile?fresh=1`, { cache: "no-store" });
      return r.ok ? "作り直しました" : "http_" + r.status;
    },
  },
];

/** 実行できない物（人が決める・現場で操作する） */
function whyCannotRun(a: Action): string {
  const s = `${a.what} ${a.how || ""}`;
  /**
   * ⚠ 2026-11-14: `shot_ops`（録画の時の操作の並び）は **`shot_learn` を埋めても増えない**（別物）。
   *   ここを混同して「やってみたが直らなかった」ので、はっきり「私では直せない」と言う。
   */
  if (/操作が付く記録が少なすぎる|写真に操作が付いていない/.test(s)) {
    return "`shot_ops`（録画の操作の並び）が届いていない。これは**拡張の記録の経路**の問題で、私からは直せない（`axlx_rec_ops` の why を見て、拡張側を直す必要がある）";
  }
  if (/AIX（自動）の記録が無い|自動モードで1回検索/.test(s)) return "自動モードで実際に検索する必要があります（私からは押せません）";
  if (/もう片方のサイト/.test(s)) return "もう片方のサイトで実際に検索する必要があります";
  if (/実際の検索が途中で止まっている|終わりの合図/.test(s)) return "検索の実行と拡張の再読み込みが必要です（現場の操作）";
  if (/一連の動き/.test(s)) return "録画を続ける必要があります（時間がかかります）";
  if (/押せない/.test(s)) return "画面を見て「押せるか」を直す必要があります（コードの修正）";
  return "人が判断・操作する必要があります";
}

void (async () => {
  const { actions, tasks, verdict, headline, err } = await fetchAdv();
  if (err) {
    console.log("統括の判断を取れませんでした:", err);
    process.exitCode = 1;
    return;
  }
  console.log("─".repeat(66));
  console.log(`【統括】${scope === "all" ? "全体" : scope}: ${headline || verdict}`);
  console.log("─".repeat(66));
  /**
   * 2026-11-14 竹内さん「これで弱い部分みつけたら統括の部分が録画したところから学習して
   *   最善の改善できるようになっているか」→ **つながっていなかった**（actions しか実行していなかった）。
   *   → 統括が決めた**順番（learning_tasks）**を先に出す。
   *     ⚠ 無料で効く物（fix_scene / fix_record）は自動でやってよい。
   *     ⚠ お金がかかる物（photo_learn）は `--yes-cost` を付けた時だけ。
   *     ⚠ 人が必要な物（need_human）は「竹内さんにしかできない」として出す。
   */
  if (tasks.length) {
    console.log("\n■ 統括が決めた「次に学ぶ事」（この順で進める）");
    tasks.forEach((t, i) => {
      const r = TASK_RUN[t.kind];
      const mark = !r ? "❓ 分からない" : t.kind === "need_human" ? "🙋 竹内さん" : r.cost ? "💰 費用" : "✅ 私がやる";
      console.log(`  ${i + 1}. [${mark}] ${t.what}`);
      console.log(`       なぜ: ${t.why}`);
      console.log(`       費用: ${t.cost}${t.limit ? `（上限 ${t.limit}枚）` : ""}`);
    });
  }
  if (!actions.length && !tasks.length) {
    console.log("  次にやる事はありません。");
    return;
  }

  // ── 統括が決めた順番を実行する（--run=task:N / --run=task:all） ──
  if (runArg && runArg.startsWith("task:")) {
    const sel = runArg.slice(5);
    const yesCost = args.includes("--yes-cost");
    const pick = sel === "all"
      ? tasks.map((t, i) => ({ no: i + 1, t }))
      : tasks.map((t, i) => ({ no: i + 1, t })).filter((x) => String(x.no) === String(sel));
    if (!pick.length) { console.log("\n⚠ その番号の課題がありません。"); process.exitCode = 1; return; }
    console.log("");
    for (const { no, t } of pick) {
      const r = TASK_RUN[t.kind];
      if (!r) { console.log(`▶ ${no}. ${t.what}\n   （実行の仕方が分かりません）`); continue; }
      if (t.kind === "need_human") { console.log(`▶ ${no}. ${t.what}\n   🙋 竹内さんにしかできません（人が1回検索してください）`); continue; }
      if (r.cost && !yesCost) {
        console.log(`▶ ${no}. ${t.what}\n   💰 費用がかかるので止めました（付ける時は --yes-cost・上限 ${t.limit ?? 20}枚）`);
        continue;
      }
      console.log(`▶ ${no}. ${r.label}`);
      try {
        (globalThis as unknown as { __task?: Task }).__task = t;
        const out = await r.run();
        console.log(`  完了: ${out}`);
      } catch (e) {
        console.log(`  失敗: ${String((e as Error).message || e)}`);
      }
    }
    console.log("\n※ 実行した結果は「判断」を取り直して確かめます:");
    console.log("   npx tsx --env-file=.env.local scripts/supervisor-talk.ts");
    return;
  }

  // 実行できる物に印を付ける
  const plan = actions.slice(0, 8).map((a, i) => {
    const r = RUNNABLE.find((x) => x.match.test(`${a.what} ${a.how || ""}`));
    return { no: i + 1, a, runner: r || null };
  });

  console.log("\n■ 次にやる事（私ができる／竹内さんにしかできない）");
  for (const p of plan) {
    const mark = p.runner ? "✅ 私がやる" : "🙋 竹内さん";
    console.log(`  ${p.no}. [${mark}] ${p.a.what}${p.a.name ? `（${p.a.name}）` : ""}`);
    if (p.a.why) console.log(`       なぜ: ${p.a.why}`);
    if (p.runner) console.log(`       → ${p.runner.label}`);
    else console.log(`       → ${whyCannotRun(p.a)}`);
  }

  if (!runArg || runArg === "list") {
    console.log("\n実行するには: --run=<番号>（1つ）／--run=all（私ができる物だけ全部）");
    return;
  }

  const targets = runArg === "all"
    ? plan.filter((p) => p.runner)
    : plan.filter((p) => String(p.no) === String(runArg) && p.runner);

  if (!targets.length) {
    const p = plan.find((x) => String(x.no) === String(runArg));
    if (p) console.log(`\n⚠ ${p.no} は私ではできません: ${whyCannotRun(p.a)}`);
    else console.log("\n⚠ その番号には私ができる事がありません。");
    process.exitCode = 1;
    return;
  }

  console.log("");
  for (const t of targets) {
    console.log(`▶ ${t.no}. ${t.runner!.label}`);
    try {
      const out = await t.runner!.run();
      console.log(`  完了: ${out}`);
    } catch (e) {
      console.log(`  失敗: ${String((e as Error).message || e)}`);
    }
  }

  // 実行した後にもう一度判断を取り直す（良くなったか）
  console.log("\n■ 実行後の統括の判断");
  const after = await fetchAdv();
  console.log(`  ${after.headline || after.verdict}`);
  if (after.actions.length) {
    console.log(`  残っている次にやる事: ${after.actions.length}件`);
    for (const a of after.actions.slice(0, 3)) console.log(`    ・${a.what}${a.name ? `（${a.name}）` : ""}`);
  } else {
    console.log("  次にやる事はありません。");
  }
  void supabase;
})();
