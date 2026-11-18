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
    const r = await fetch(`${BASE}/api/human-learn-profile?touch=0&scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
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
      const r = await fetch(`${BASE}/api/human-learn-profile?touch=0&scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
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
  /**
   * ★ 2026-11-18「統括も作業員増やすの判断できるように」:
   *   推奨人数だけ返す。Cursor 作業員は勝手に起動しない。
   */
  scale_workers: {
    label: "作業員の推奨人数を確認する（起動はしない）",
    cost: false,
    run: async () => {
      const t = (globalThis as unknown as { __task?: Task }).__task;
      const limit = typeof t?.limit === "number" && t.limit > 0 ? t.limit : null;
      const adv = await fetchAdv();
      const hit = adv.tasks.find((x) => x.kind === "scale_workers");
      const n = limit ?? hit?.limit ?? 1;
      const why = hit?.why || "統括の meeting に scale_workers がありません";
      return `推奨作業員: ${n}人（実行は竹内さん判断・自動起動しない）／${why}`;
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
  /**
   * ★ 2026-11-16「統括は土台構築も含めて／循環すれば質が上がる」:
   *   再現％・土台の抜け・場面連動を数え直し、次手を名指しする（無料）。
   */
  build_foundation: {
    label: "再現に足りない土台を点検し、揃える次手を出す",
    cost: false,
    run: async () => {
      const r = await fetch(`${BASE}/api/human-learn-profile?touch=0&scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
      if (!r.ok) return "http_" + r.status;
      const j = (await r.json()) as Record<string, unknown>;
      const b = (j.bundle ?? {}) as Record<string, unknown>;
      const sup = (scope === "all"
        ? b.supervisor
        : ((b.supervisor_by_site ?? {}) as Record<string, unknown>)[scope]) as Record<string, unknown> | undefined;
      const meeting = (sup?.meeting ?? null) as Record<string, unknown> | null;
      const today = Array.isArray(meeting?.today) ? (meeting!.today as string[]).join("／") : "";
      const ev = Array.isArray(meeting?.evidence) ? (meeting!.evidence as Array<{ label?: string; value?: string }>) : [];
      const cycle = ev.find((e) => String(e.label || "").includes("質を上げる循環"));
      const foundation = ev.find((e) => String(e.label || "").includes("通常録画→完全再現の土台"));
      const scenes = ev.find((e) => String(e.label || "").includes("学習場面の連動"));
      const sub = ev.find((e) => String(e.label || "").includes("土台の細分化"));
      const link = ev.find((e) => String(e.label || "").includes("弱所発見→学習→土台→細部"));
      const parts = [
        today ? `結論: ${today}` : null,
        cycle ? `循環: ${cycle.value}` : null,
        sub ? `細分化: ${sub.value}` : null,
        link ? `連動: ${link.value}` : null,
        foundation ? `土台: ${foundation.value}` : null,
        scenes ? `場面: ${scenes.value}` : null,
        "次: 自動で弱所→通常で学ぶ→土台を細分化→細部再現→自動1回で確かめる",
      ].filter(Boolean);
      return parts.join("／") || "土台の材料が束にまだありません（fresh で取り直す）";
    },
  },
  photo_learn: {
    label: "弱い所の写真から欄の種類を読む（**1枚ごとに費用**・時間順・細かく）",
    cost: true,
    run: async () => {
      /**
       * ⚠ Vision はお金がかかる。枚数は**統括が課題に応じて決めた limit**を使う。
       *   ★ 2026-11-16 竹内さん「上限20ではなく課題が解けるまで／統括が判断」:
       *     旧 Math.min(60, …||20) は統括の判断を潰していた → 硬上限まで尊重。
       */
      const t = (globalThis as unknown as { __task?: Task & { order?: string; runId?: string; fields?: string[] } }).__task;
      const { resolveShotLearnLimit } = await import("../app/lib/shot-learn-limit");
      const limit = resolveShotLearnLimit(t?.limit);
      /**
       * ★ 2026-11-15「画像は最新で録画」「自動の最新課題→通常から改善」:
       *   統括が order=newest / sequence を付けたらその順で通常画像を読む。
       */
      const order = (t?.order === "newest" || t?.order === "time" || t?.order === "size" || t?.order === "sequence")
        ? t.order
        : (Array.isArray(t?.fields) && t!.fields!.length ? "newest" : "time");
      const { learnFromWeakShots } = await import("../app/lib/shot-learn-server");
      const r = await learnFromWeakShots({
        site: scope === "all" ? null : scope,
        mode: "normal",
        days: 7,
        limit,
        order: order as "newest" | "time" | "size" | "sequence",
        runId: t?.runId ?? null,
        perSig: 12,
        strideMs: 800,
        dryRun: false,
      });
      /**
       * ★ 2026-11-16「学んだら強化」: 読んだら必ず反映を回し、強化記録を残し、次手を名指しする。
       */
      const reflect = await TASK_RUN.reflect_auto.run();
      try {
        const { saveImprovement } = await import("../app/lib/learn-improvements");
        await saveImprovement({
          area: "学習",
          title: `通常画像から読んだ ${r.learned}枚（欄 ${r.fields}・学んだら強化へ）`,
          why: `試した${r.tried}・保存${r.saved}・束${r.refreshed ? "更新" : "未"}`,
          how: "photo_learn → reflect_auto。次は拡張再読込→自動1回→verify_improve",
          effect: "read_count>0 かつ最新自動の課題欄が減る",
          verify: "npx tsx --env-file=.env.local scripts/improve-loop.ts",
        });
      } catch (_) { /* 記録失敗で学習を止めない */ }
      return `試した ${r.tried}枚・読めた ${r.learned}枚（欄 ${r.fields}個）・保存 ${r.saved}枚・束 ${r.refreshed ? "作り直し済" : "未"}／反映: ${reflect}${r.errors.length ? "・エラー " + r.errors.length : ""} ／ ▶学んだら強化: 拡張2.8.26再読込 → 自動1回 → verify_improve`;
    },
  },
  /**
   * ★ 2026-11-15 竹内さん「ちゃんと反映までやるようにする統括」:
   *   束を作り直し、拡張が読んだか・自動が新束のあと走ったかを**数字で返す**（無料）。
   */
  reflect_auto: {
    label: "学んだ位置を束に載せ、拡張・自動への反映状態を確かめる（無料）",
    cost: false,
    run: async () => {
      const r = await fetch(`${BASE}/api/human-learn-profile?touch=0`, { cache: "no-store" });
      if (!r.ok) return "束の作り直し失敗 http_" + r.status;
      const { fetchBundleReflectHint, reflectLine } = await import("../app/lib/bundle-reflect");
      const hint = await fetchBundleReflectHint(supabase, { scope: scope === "all" ? "all" : scope });
      const j = (await r.json()) as { bundle?: { shots?: { learned?: Record<string, Array<{ x?: number; y?: number; n?: number }>> } } };
      let screen_all = 0, screen_solid = 0;
      const learned = j?.bundle?.shots?.learned;
      if (learned && typeof learned === "object") {
        for (const list of Object.values(learned)) {
          for (const f of Array.isArray(list) ? list : []) {
            if (typeof f?.x !== "number" || typeof f?.y !== "number") continue;
            screen_all++;
            if ((Number(f.n) || 0) >= 3) screen_solid++;
          }
        }
      }
      const line = reflectLine(hint, screen_solid, screen_all);
      if (screen_solid >= 3 && hint.read_count <= 0) {
        return `${line} → 次: 拡張で束を取り直す（ポップアップを開く／学習の再取得）`;
      }
      if (screen_solid >= 3 && !hint.auto_after) {
        return `${line} → 次: 自動モードで1回検索して数字で確かめる`;
      }
      return line;
    },
  },
  need_human: {
    label: "人が1回やる必要があります（私からは押せません）",
    cost: false,
    run: async () => "人が1回検索してください（この場面は手本が無いので自動にできません）",
  },
  /**
   * ★ 2026-11-15「改善につながるまで一連」:
   *   段階4 = 拡張再読み込み（人）。段階5 = 自動1回（人）。段階6 = 数字で効果確認（無料）。
   */
  need_ext_reload: {
    label: "拡張を再読み込みして最新の束を取り直す（人・無料）",
    cost: false,
    run: async () => {
      return "🙋 学んだら強化・段階4: 拡張 2.8.25 を chrome://extensions で再読み込み → ポップアップを開く（自動で束取得）→ コンソールに「連携完了」→ そのあと reflect_auto / 自動1回";
    },
  },
  need_auto_run: {
    label: "自動モードで1回検索する（人・無料）",
    cost: false,
    run: async () => {
      return "🙋 学んだら強化・段階5: 拡張が束を読んだあと、自動/AIXモードで1回検索。終わったら verify_improve で課題欄が減ったか数字で見る";
    },
  },
  verify_improve: {
    label: "最新自動の課題が減ったか数字で確かめる（無料）",
    cost: false,
    run: async () => {
      const { fetchBundleReflectHint, reflectLine } = await import("../app/lib/bundle-reflect");
      const { summarizeLatestAutoChallenges, summarizeRecordingFreshness } = await import("../app/lib/latest-learn-loop");
      const { buildImproveLoop } = await import("../app/lib/improve-loop");
      const hint = await fetchBundleReflectHint(supabase, { scope: scope === "all" ? "all" : scope });
      const since = new Date(Date.now() - 2 * 86400_000).toISOString();
      const rows: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 3000; i += 1000) {
        const { data } = await supabase.from("human_motion_learn")
          .select("created_at,mode,shot_key,shot_w,shot_learn,ext_version,shot_ops")
          .gte("created_at", since).not("shot_key", "is", null)
          .order("created_at", { ascending: false }).range(i, i + 999);
        rows.push(...((data || []) as Array<Record<string, unknown>>));
        if ((data || []).length < 1000) break;
      }
      const ch = summarizeLatestAutoChallenges(rows as never, { hours: 48 });
      const fresh = summarizeRecordingFreshness(rows as never);
      const loop = buildImproveLoop({
        photoInStorage: rows.length,
        withOps: rows.length,
        screenSolid: 10,
        screenAll: 10,
        hint,
        challengeFields: ch.fields,
        canMeasure: hint.read_count > 0 && hint.auto_after,
      });
      return `${loop.improve_line} ／ 鮮度: ${fresh.line.slice(0, 80)} ／ 課題: ${ch.fields.slice(0, 5).join("・") || "なし"} ／ 反映: ${reflectLine(hint, 10, 10)}`;
    },
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
      const r = await fetch(`${BASE}/api/human-learn-profile?touch=0`, { cache: "no-store" });
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
      /**
       * ★ 2026-11-15「改善につながるまで一連」:
       *   need_ext_reload / need_auto_run は人がやる（拡張再読込・自動1回）。
       *   旧: cost=false だけで「✅ 私がやる」と誤表示 → 一連が切れて見えた。
       */
      const humanKinds = new Set(["need_human", "need_ext_reload", "need_auto_run"]);
      const mark = !r ? "❓ 分からない" : humanKinds.has(t.kind) ? "🙋 竹内さん" : r.cost ? "💰 費用" : "✅ 私がやる";
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
      if (t.kind === "need_human" || t.kind === "need_ext_reload" || t.kind === "need_auto_run") {
        const r0 = TASK_RUN[t.kind];
        console.log(`▶ ${no}. ${t.what}`);
        if (r0) {
          try {
            (globalThis as unknown as { __task?: Task }).__task = t;
            console.log(`   ${await r0.run()}`);
          } catch (e) {
            console.log(`   🙋 竹内さんにしかできません: ${String((e as Error).message || e)}`);
          }
        } else {
          console.log("   🙋 竹内さんにしかできません（人が1回検索してください）");
        }
        continue;
      }
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
    console.log("\n実行するには: --run=<番号>（1つ）／--run=all（私ができる物だけ全部）／--run=task:all（学習課題の無料分）");
    return;
  }

  /**
   * ★ 2026-11-16: `--run=all` が actions 側だけ見ていた。
   *   実測: 次にやる事が全部「🙋」だと targets=0 で落ち、無料の learning_tasks が回らない。
   *   → all の時は actions の実行可能分＋学習課題の無料分（task:all 相当）を回す。
   */
  if (runArg === "all") {
    const yesCost = args.includes("--yes-cost");
    const humanKinds = new Set(["need_human", "need_ext_reload", "need_auto_run"]);
    console.log("");
    let ran = 0;
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const r = TASK_RUN[t.kind];
      const no = i + 1;
      if (!r) continue;
      if (humanKinds.has(t.kind)) {
        console.log(`▶ task:${no}. ${t.what}\n   🙋 竹内さん（スキップ）`);
        continue;
      }
      if (r.cost && !yesCost) {
        console.log(`▶ task:${no}. ${t.what}\n   💰 費用（スキップ・付ける時は --yes-cost）`);
        continue;
      }
      console.log(`▶ task:${no}. ${r.label}`);
      try {
        (globalThis as unknown as { __task?: Task }).__task = t;
        console.log(`  完了: ${await r.run()}`);
        ran++;
      } catch (e) {
        console.log(`  失敗: ${String((e as Error).message || e)}`);
      }
    }
    const actionTargets = plan.filter((p) => p.runner);
    for (const t of actionTargets) {
      console.log(`▶ ${t.no}. ${t.runner!.label}`);
      try {
        console.log(`  完了: ${await t.runner!.run()}`);
        ran++;
      } catch (e) {
        console.log(`  失敗: ${String((e as Error).message || e)}`);
      }
    }
    if (!ran) {
      console.log("⚠ 今すぐ自動で回せる無料タスクがありません（人が必要な物／費用物のみ）。");
      console.log("   学習課題だけ回す: --run=task:all ／ 費用も: --run=task:all --yes-cost");
      process.exitCode = 1;
      return;
    }
    console.log(`\n※ ${ran}件実行。判断の取り直し: npx tsx --env-file=.env.local scripts/supervisor-talk.ts`);
    return;
  }

  const targets = plan.filter((p) => String(p.no) === String(runArg) && p.runner);

  if (!targets.length) {
    const p = plan.find((x) => String(x.no) === String(runArg));
    if (p) console.log(`\n⚠ ${p.no} は私ではできません: ${whyCannotRun(p.a)}`);
    else console.log("\n⚠ その番号には私ができる事がありません（学習課題は --run=task:all）。");
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
