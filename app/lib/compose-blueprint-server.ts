// app/lib/compose-blueprint-server.ts — 文の指示役（構成のブレイン）を1回動かす（サーバー専用・LLM 1回＋場面の RAG）
//
// 2026-11-03 作業員6。流れ: 統括の決定（priorities・plan）→ ここで意図（趣旨・主語・メインの1文・添え・締め）を決める → 設計図 → 書き手への注記。
//   LLM は判断だけ（文は書かない・max 400 トークン）。名札 reply_compose_intent（試験では deepseek-all で DeepSeek に回る）。
//   失敗・時間切れは fallbackIntent（低い確かさ・ログに1行）＝返信は止めない。スイッチ BRAIN_COMPOSE_BLUEPRINT（既定 off）は呼ぶ側で見る。
import { sumoraLlmMarks } from "./llm-usage-recorder";
import { COMPOSE_INTENT_SYSTEM, composeIntentPrompt, parseComposeIntent, fallbackIntent, buildBlueprint, blueprintNote, composeRagHint, type ComposeIntent, type ComposeBlueprint, type ComposeRequirement } from "./compose-blueprint";
import { matchTakeuchiCompose } from "./takeuchi-compose-examples-server";

export type ComposeRun = { intent: ComposeIntent; blueprint: ComposeBlueprint; note: string; ragIds: string[]; ms: number };

/** 統括の決定（priorities と plan）から構成のブレインの要件を作る（plan があれば who・include・msg を写す） */
export function requirementsFromContract(o: {
  priorities?: ReadonlyArray<{ rank: number; item: string; handling: string }> | null;
  plan?: { parts: ReadonlyArray<{ rank: number; who: string; include: string; msg: number }> } | null;
}): ComposeRequirement[] {
  const parts = new Map((o.plan?.parts ?? []).map((p) => [p.rank, p]));
  return (o.priorities ?? []).map((p) => {
    const q = parts.get(p.rank);
    return { rank: p.rank, item: p.item, handling: p.handling, who: q?.who ?? null, include: q?.include ?? null, msg: q?.msg ?? null };
  });
}

export async function runComposeBlueprint(o: {
  conversationId: string | null; customerText: string; scene: string; requirements: ComposeRequirement[]; planMessages?: number;
  situation?: string | null; emotion?: string | null; appeal?: string | null; timeoutMs?: number;
}): Promise<ComposeRun> {
  const t0 = Date.now();
  // 場面の RAG（場面で絞る・趣旨はまだ決まっていないので絞らない・同じ会話は外す）。失敗は []
  const hits = await matchTakeuchiCompose({ scene: o.scene, purpose: null, customerGist: o.customerText.slice(0, 200), conversationId: o.conversationId, k: 3 }).catch(() => []);
  const ragHints = hits.map((h) => composeRagHint(h));
  let intent: ComposeIntent | null = null;
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (key) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: AbortSignal.timeout(o.timeoutMs ?? 12_000),
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks("reply_compose_intent", o.conversationId) },
        body: JSON.stringify({
          model: "claude-sonnet-5", max_tokens: 400, thinking: { type: "disabled" }, system: COMPOSE_INTENT_SYSTEM,
          messages: [{ role: "user", content: composeIntentPrompt({ customerText: o.customerText, scene: o.scene, requirements: o.requirements, situation: o.situation, emotion: o.emotion, appeal: o.appeal, ragHints }) }],
        }),
      });
      if (r.ok) {
        const d = await r.json() as { content?: Array<{ type: string; text?: string }> };
        intent = parseComposeIntent(d.content?.find((b) => b.type === "text")?.text ?? "");
      } else console.warn(JSON.stringify({ tag: "compose:intent-http", status: r.status }));
    } catch (e) { console.warn(JSON.stringify({ tag: "compose:intent-failed", error: e instanceof Error ? e.message : String(e) })); }
  }
  if (!intent) intent = fallbackIntent(o.requirements);
  const blueprint = buildBlueprint({ intent, requirements: o.requirements, planMessages: o.planMessages, evidence: hits.map((h) => h.message_id) });
  return { intent, blueprint, note: blueprintNote(blueprint), ragIds: hits.map((h) => h.message_id), ms: Date.now() - t0 };
}
