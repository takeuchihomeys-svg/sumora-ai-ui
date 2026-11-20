// app/lib/playbook-reflect-server.ts — 手順書が DB・拡張・自動の動きまで反映されているかを読む（読むだけ・2026-11-20）
//
// 竹内さん「手順書の重要度と優先度あげる」「改善したら手順書が改善されるように仕組みをちゃんとつくって強化する」。
//   読む物（どれも軽い・索引の範囲）:
//     ① human_learn_profile の scope ごとの最新1行の bundle->playbook だけ（束の全体は読まない）
//     ② search_audits の直近の自動（リアプロ）N回の steps（created_at の索引・N は既定 8）
//   判定は auto-procedure-rules.ts の純関数（judgePlaybookReflect／judgeRulesOnAudit）。統括Pro と点検スクリプトが同じ物を使う。

import {
  AUTO_RULES, checkRulesInCode, judgePlaybookReflect, judgeRulesOnAudit, parsePlaybookSeen,
  type AuditStep, type PlaybookSeen,
} from "./auto-procedure-rules";
import { PLAYBOOK_BUILD_V } from "./action-playbook";

type Env = Record<string, string | undefined>;

export type PlaybookReflectReport = {
  scope: string;
  bundle_id: number | null;
  bundle_at: string | null;
  reflect: ReturnType<typeof judgePlaybookReflect>;
  /** 直近の自動の回ごとの印と、決まりを守れたか */
  runs: Array<{
    run_id: string; at: string; ext_version: string | null;
    seen: PlaybookSeen | "none" | null;
    ng: Array<{ id: string; why: string }>;
    ok: number; no_data: number;
  }>;
  /** 決まりごとの合計（ok/ng/no_data の回数） */
  per_rule: Array<{ id: string; ok: number; ng: number; no_data: number; last_ng: string | null }>;
};

async function rest<T>(env: Env, q: string): Promise<T> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) throw new Error("環境変数が足りません（NEXT_PUBLIC_SUPABASE_URL と鍵）");
  const r = await fetch(`${url}/rest/v1/${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`読めません ${q.split("?")[0]} (${r.status})`);
  return (await r.json()) as T;
}

export async function fetchPlaybookReflect(env: Env, opts: { scope?: string; runs?: number } = {}): Promise<PlaybookReflectReport> {
  const scope = opts.scope ?? "realpro";
  const n = Math.max(1, Math.min(20, opts.runs ?? 8));
  const [row] = await rest<Array<{ id: number; created_at: string; playbook: unknown }>>(
    env, `human_learn_profile?select=id,created_at,playbook:bundle->playbook&scope=eq.${encodeURIComponent(scope)}&order=created_at.desc&limit=1`,
  );
  const site = scope === "all" ? "realpro" : scope;
  const audits = await rest<Array<{ run_id: string; created_at: string; ext_version: string | null; steps: AuditStep[] | null }>>(
    env, `search_audits?select=run_id,created_at,ext_version,steps&site=eq.${encodeURIComponent(site)}&order=created_at.desc&limit=${n}`,
  );

  const runs: PlaybookReflectReport["runs"] = [];
  const seenList: Array<PlaybookSeen | "none"> = [];
  const per = new Map(AUTO_RULES.map((r) => [r.id, { id: r.id, ok: 0, ng: 0, no_data: 0, last_ng: null as string | null }]));
  for (const a of audits) {
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const seenStep = steps.find((s) => s?.k === "page:playbook_seen");
    const noneStep = steps.find((s) => s?.k === "page:playbook_none");
    const seen: PlaybookSeen | "none" | null = seenStep ? parsePlaybookSeen(seenStep.d) : noneStep ? "none" : null;
    if (seen) seenList.push(seen);
    const judged = judgeRulesOnAudit(steps, AUTO_RULES, a.ext_version ?? null);
    for (const j of judged) {
      const p = per.get(j.id)!;
      p[j.result]++;
      if (j.result === "ng" && !p.last_ng) p.last_ng = `${a.run_id.slice(0, 16)}: ${j.why}`;
    }
    runs.push({
      run_id: a.run_id, at: a.created_at, ext_version: a.ext_version ?? null, seen,
      ng: judged.filter((j) => j.result === "ng").map((j) => ({ id: j.id, why: j.why })),
      ok: judged.filter((j) => j.result === "ok").length,
      no_data: judged.filter((j) => j.result === "no_data").length,
    });
  }

  const pb = row?.playbook && typeof row.playbook === "object" ? (row.playbook as Parameters<typeof judgePlaybookReflect>[0]["playbook"]) : null;
  const reflect = judgePlaybookReflect({ playbook: pb, buildV: PLAYBOOK_BUILD_V, seen: seenList });
  // コード側の食い違い（テストを回し忘れても統括Pro に出す）。拡張のファイルが無い所（本番の関数の箱）では見ない
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "chrome-extension");
    if (existsSync(join(dir, "page-script.js"))) {
      const code = checkRulesInCode({
        pageScript: readFileSync(join(dir, "page-script.js"), "utf8"),
        searchAudit: readFileSync(join(dir, "search-audit.js"), "utf8"),
        manifestJson: readFileSync(join(dir, "manifest.json"), "utf8"),
      });
      if (code.length) { reflect.ok = false; reflect.why.unshift(...code.map((c) => `コード: ${c}`)); }
      else reflect.facts.push("コード: 決まりの目印・拡張の一覧・見直した版は揃っている");
    }
  } catch { /* 読めなくても DB 側の判定は返す */ }
  return {
    scope,
    bundle_id: row?.id ?? null,
    bundle_at: row?.created_at ?? null,
    reflect,
    runs,
    per_rule: [...per.values()],
  };
}

/**
 * 統括Pro に渡す1行（最優先の材料・先頭に置く）。数と事実だけ（判断は Pro がする）。
 *   2026-11-20 竹内さん「手順書の重要度と優先度あげる」→ 手順書の反映は Pro の材料の先頭に置く。
 */
export function playbookReflectNote(rep: PlaybookReflectReport): string {
  const ng = rep.per_rule.filter((p) => p.ng > 0).map((p) => `${p.id} ${p.ng}回`);
  return [
    `【最優先・手順書】手順書の反映（${rep.scope}・束 ${rep.bundle_id ?? "無"}）: ${rep.reflect.ok ? "揃っている" : "揃っていない"}`,
    ...rep.reflect.facts,
    ...(rep.reflect.why.length ? [`揃っていない理由: ${rep.reflect.why.join("／")}`] : []),
    `直近の自動 ${rep.runs.length}回の決まり: 守れていない ${ng.length ? ng.join("・") : "無し"}（確かめられない決まりは数えない）`,
  ].join("／");
}
