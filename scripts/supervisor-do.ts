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

/** 統括の判断を取る */
async function fetchAdv(): Promise<{ actions: Action[]; verdict: string; headline: string; err: string | null }> {
  try {
    const r = await fetch(`${BASE}/api/human-learn-profile?fresh=1&scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
    if (!r.ok) return { actions: [], verdict: "", headline: "", err: "http_" + r.status };
    const j = (await r.json()) as Record<string, unknown>;
    const b = (j.bundle ?? null) as Record<string, unknown> | null;
    if (!b) return { actions: [], verdict: "", headline: "", err: "束がありません" };
    const sup = (scope === "all"
      ? b.supervisor
      : ((b.supervisor_by_site ?? {}) as Record<string, unknown>)[scope]) as Record<string, unknown> | undefined;
    if (!sup) return { actions: [], verdict: "", headline: "", err: "統括の判断がありません" };
    return {
      actions: Array.isArray(sup.actions) ? (sup.actions as Action[]) : [],
      verdict: String(sup.verdict || ""),
      headline: String(sup.headline || ""),
      err: null,
    };
  } catch (e) {
    return { actions: [], verdict: "", headline: "", err: String((e as Error).message || e) };
  }
}

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
  const { actions, verdict, headline, err } = await fetchAdv();
  if (err) {
    console.log("統括の判断を取れませんでした:", err);
    process.exitCode = 1;
    return;
  }
  console.log("─".repeat(66));
  console.log(`【統括】${scope === "all" ? "全体" : scope}: ${headline || verdict}`);
  console.log("─".repeat(66));
  if (!actions.length) {
    console.log("  次にやる事はありません。");
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
