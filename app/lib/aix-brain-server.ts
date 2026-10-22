// app/lib/aix-brain-server.ts — AIX のブレイン（実行の指揮官＋実行役＋確かめ）を動かす（LLM の呼び出し・個人情報の線）。組み立てと確かめは aix-brain.ts（純関数）。
//
// 個人情報の線（2026-09-19 竹内「本名・電話番号は絶対に伏せる」／10/20「個人情報が絡む部分は必ずクロード」）:
//   ・審査について（aixRequestMustUseClaude）・申込以降・審査の事情・申込の時刻の線がある会話・読めない時 → Claude（x-sumora-llm-post-apply: 1）
//   ・それ以外で DeepSeek に回る設定の時 → 呼び名を札（〈名前〉）にしてから既知の名前・電話等を伏せ（maskPIIForAlt）、印 all を付けて flash に回す
//   出口（llm-alt-provider）の網（個人の値・審査の事情）も今まで通り効く。
// 呼ぶのは AIX_BRAIN=on の時だけ（既定 off）。失敗・時間切れは下書きのまま（止めない）。
import { supabase } from "@/app/lib/supabase-server";
import { LLM_POST_APPLY_HEADER, LLM_CUTOFF_HEADER, sumoraLlmMarks } from "@/app/lib/llm-usage-recorder";
import { loadPostApplyFacts, resolvePostApply, deepseekSafeCutoff, cutoffMs, NO_CUTOFF } from "@/app/lib/post-apply";
import { loadScreeningSensitive, screeningSensitiveInMessages, screeningPiiClaudeEnabled } from "@/app/lib/screening-sensitive";
import { maskPIIForAlt } from "@/app/lib/pii-mask";
import { loadAltNameMask } from "@/app/lib/pii-known-names";
import {
  AIX_BRAIN_ACTION, CONDUCTOR_SYSTEM, EXECUTOR_SYSTEM, buildConductorUser, buildExecutorUser, parseConductorPlan, parseExecutorParts, assembleText,
  mustItemsOf, checkAixText, chooseText, describeIssues, tokenizeName, restoreName, staffInputsBlock,
  type AixBrainInput, type ConductorPlan,
} from "@/app/lib/aix-brain";

const HAIKU = "claude-haiku-4-5-20251001";

export type AixBrainRoute = "alt" | "claude";

/** DeepSeek（flash）に回してよいか。分からない時は Claude（fail-closed） */
export async function aixBrainRouteFor(o: { conversationId: string | null; recent: ReadonlyArray<{ sender?: string | null; text?: string | null }>; mustClaude: boolean; postApply?: boolean }): Promise<AixBrainRoute> {
  if (o.mustClaude || o.postApply) return "claude";
  let goesAlt = false;
  try { goesAlt = (await import("@/app/lib/llm-alt-provider")).willRouteAlt(AIX_BRAIN_ACTION); } catch { goesAlt = false; }
  if (!goesAlt) return "claude";
  const cid = (o.conversationId ?? "").trim() || null;
  if (!cid) return "claude";
  try {
    const [facts, sens] = await Promise.all([
      loadPostApplyFacts(supabase, cid),
      screeningPiiClaudeEnabled()
        ? (screeningSensitiveInMessages(o.recent.map((m) => ({ sender: m.sender ?? null, text: m.text ?? null }))) ?? loadScreeningSensitive(supabase, cid))
        : Promise.resolve(null),
    ]);
    if (resolvePostApply(facts).postApply) return "claude";
    if (cutoffMs(deepseekSafeCutoff(facts)) !== NO_CUTOFF) return "claude";
    if (sens) return "claude";
    return "alt";
  } catch {
    return "claude";
  }
}

type LlmResult = { ok: true; text: string } | { ok: false; error: string };

async function callBrainLlm(system: string, user: string, o: { conversationId: string | null; route: AixBrainRoute; maxTokens: number; part: "conductor" | "executor" }): Promise<LlmResult> {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        ...sumoraLlmMarks(AIX_BRAIN_ACTION, o.conversationId),
        ...(o.route === "alt" ? { [LLM_CUTOFF_HEADER]: "all" } : { [LLM_POST_APPLY_HEADER]: "1" }),
      },
      body: JSON.stringify({
        model: HAIKU,
        max_tokens: o.maxTokens,
        temperature: 0,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) return { ok: false, error: `${o.part} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}` };
    const d = await r.json() as { content?: Array<{ type: string; text?: string }> };
    return { ok: true, text: d.content?.find((b) => b.type === "text")?.text?.trim() ?? "" };
  } catch (e) {
    return { ok: false, error: `${o.part}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type AixBrainRun = {
  text: string;
  used: "draft" | "brain";
  plan: ConductorPlan | null;
  reason: string;
  route: AixBrainRoute;
  calls: number;
};

/**
 * 指揮官 → （keep でなければ）実行役 → 確かめ。戻りの text は呼ぶ側の出口（finalize 等）をそのまま通す。
 * 失敗・時間切れ・確かめで悪くなった時は下書き（draft）のまま。
 */
export async function runAixBrain(input: AixBrainInput, o: { conversationId: string | null; mustClaude: boolean; postApply?: boolean; names?: ReadonlyArray<string | null | undefined>; tag: string; /** 呼ぶ側の出口の網（例: 2通目の AI くさい言い回し）。下書きに無い外れが出たら下書き */ extraCheck?: (t: string) => string[] }): Promise<AixBrainRun> {
  const draft = String(input.draft ?? "");
  const out = (text: string, used: "draft" | "brain", plan: ConductorPlan | null, reason: string, route: AixBrainRoute, calls: number): AixBrainRun => {
    console.log(JSON.stringify({ tag: "aix-brain", where: o.tag, aixType: input.aixType, picker: input.picker, kind: input.kind, used, route, calls, keep: plan?.keep ?? null, reason: reason.slice(0, 200), add: plan?.add.map((a) => a.part) ?? [], drop: plan?.drop.length ?? 0 }));
    return { text, used, plan, reason, route, calls };
  };
  if (!draft.trim()) return out(draft, "draft", null, "下書きなし", "claude", 0);
  const route = await aixBrainRouteFor({ conversationId: o.conversationId, recent: input.recent, mustClaude: o.mustClaude, postApply: o.postApply });
  // 伏せ: 呼び名は札に（戻す）・それ以外の名前・電話等は DeepSeek の時だけ伏せる（戻さない＝本文に出たら確かめで落とす）
  let mask: ((t: string) => string) = (t) => tokenizeName(t, input.callName);
  if (route === "alt") {
    try {
      const m = await loadAltNameMask(o.conversationId, [input.callName, ...(o.names ?? [])].filter(Boolean) as string[]);
      mask = (t) => maskPIIForAlt(tokenizeName(t, input.callName), m);
    } catch {
      return out(draft, "draft", null, "名前の伏せが読めない（回さない）", route, 0);
    }
  }
  const mi: AixBrainInput = {
    ...input,
    draft: mask(draft),
    material: mask(input.material),
    recent: input.recent.map((m) => ({ sender: m.sender, text: mask(String(m.text ?? "")) })),
    bundleNote: input.bundleNote ? mask(input.bundleNote) : input.bundleNote,
    decided: input.decided?.map(mask),
    staffInputs: input.staffInputs.map(([k, v]) => [k, mask(String(v ?? ""))] as [string, string]),
  };
  const must = mustItemsOf(input);
  // 確かめの根拠（伏せる前の字）: 数字は材料・スタッフの入力・会話・下書き／スタッフだけが知る事はスタッフの入力・材料・呼ぶ側が決めた事
  const staffBasis = [staffInputsBlock(input.staffInputs), input.material, ...(input.decided ?? [])].join("\n");
  const basis = [staffBasis, input.recent.map((m) => String(m.text ?? "")).join("\n"), draft].join("\n");
  const check = (t: string) => checkAixText(t, { must, basis, staffBasis, callName: input.callName, draft, closeKind: input.closeKind ?? null });
  // 確かめを先に（節約・質）: 下書きに外れが無ければ指揮官も呼ばない（試験 aixbrain2: 外れの無い下書きに flash が書き足すと悪くなった）
  const di0 = check(draft);
  const extra0 = o.extraCheck ? o.extraCheck(draft) : [];
  const found = [...describeIssues(di0), ...extra0];
  if (!found.length) return out(draft, "draft", null, "確かめで外れなし（指揮官を呼ばない）", route, 0);

  const cond = await callBrainLlm(CONDUCTOR_SYSTEM, buildConductorUser(mi, must, found), { conversationId: o.conversationId, route, maxTokens: 700, part: "conductor" });
  if (!cond.ok) return out(draft, "draft", null, `指揮官の失敗 ${cond.error}`, route, 1);
  const plan = parseConductorPlan(cond.text);
  if (!plan) return out(draft, "draft", null, "設計図が読めない", route, 1);
  const di = di0;
  const extra = (t: string) => (o.extraCheck ? o.extraCheck(t) : []);
  const checkAll = (t: string) => { const c = check(t); const x = extra(t); return x.length ? { ...c, staffNoBasis: [...c.staffNoBasis, ...x] } : c; };
  // keep: 下書きのまま。ただし確かめで送れない所（埋め字・必ず入れる字の抜け）がある時は keep にしない
  const mustFix = di.placeholder || di.missingMust.length > 0 || di.maskLeak;
  if ((plan.keep || (!plan.add.length && !plan.drop.length)) && !mustFix) return out(draft, "draft", plan, `指揮官が下書きのままと判断（${plan.why}）`, route, 1);
  let parts: string[] = [];
  let calls = 1;
  if (plan.add.length) {
    const exe = await callBrainLlm(EXECUTOR_SYSTEM, buildExecutorUser(mi, plan), { conversationId: o.conversationId, route, maxTokens: 700, part: "executor" });
    calls = 2;
    if (!exe.ok) return out(draft, "draft", plan, `実行役の失敗 ${exe.error}`, route, calls);
    const ps = parseExecutorParts(exe.text, plan.add.length);
    if (!ps) return out(draft, "draft", plan, "実行役の部品が読めない", route, calls);
    parts = ps;
  }
  const built = restoreName(assembleText(mi.draft, plan, parts), input.callName);
  const ch = chooseText(draft, built, checkAll);
  return out(ch.text, ch.used, plan, `${ch.reason}${ch.brainIssues ? `／組み立ての確かめ: ${describeIssues(ch.brainIssues).join("・") || "外れなし"}` : ""}`, route, calls);
}
