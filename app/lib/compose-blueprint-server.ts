// app/lib/compose-blueprint-server.ts — 文の指示役（構成のブレイン）を1回動かす（サーバー専用・LLM 1回＋場面の RAG）
//
// 2026-11-03 作業員6。流れ: 統括の決定（priorities・plan）→ ここで意図（趣旨・主語・メインの1文・添え・締め）を決める → 設計図 → 書き手への注記。
//   LLM は判断だけ（文は書かない・max 400 トークン）。名札 reply_compose_intent（試験では deepseek-all で DeepSeek に回る）。
//   失敗・時間切れは fallbackIntent（低い確かさ・ログに1行）＝返信は止めない。スイッチ BRAIN_COMPOSE_BLUEPRINT（既定 off）は呼ぶ側で見る。
import { sumoraLlmMarks } from "./llm-usage-recorder";
import { COMPOSE_INTENT_SYSTEM, composeIntentPrompt, parseComposeIntent, fallbackIntent, buildBlueprint, blueprintNote, composeRagHint, type ComposeIntent, type ComposeBlueprint, type ComposeRequirement } from "./compose-blueprint";
import { matchTakeuchiCompose, matchTakeuchiComposeForConductor } from "./takeuchi-compose-examples-server";

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
  /** 2026-11-04 統括から呼ぶ時（文の受け口）: 統括メタと状況のまとめ。ある時は竹内さんの文の手本を統括と連携した検索で引く（問い＝発言と状況だけ） */
  conductor?: { meta: import("./compose-port").ConductorComposeMeta; situationSummary?: string | null } | null;
}): Promise<ComposeRun> {
  const t0 = Date.now();
  // 場面の RAG（場面で絞る・趣旨はまだ決まっていないので絞らない・同じ会話は外す）。失敗は []
  const hits = await (o.conductor
    ? matchTakeuchiComposeForConductor({ customerText: o.customerText, situationSummary: o.conductor.situationSummary, meta: o.conductor.meta, conversationId: o.conversationId, k: 3 })
    : matchTakeuchiCompose({ scene: o.scene, purpose: null, customerGist: o.customerText.slice(0, 200), conversationId: o.conversationId, k: 3 })).catch(() => []);
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

/** 設計図の確かめの段の3つ（書いた後・記録だけ。書き直し1回と統括への差し戻しは呼ぶ側の次の段で）。どれも COMPOSE_CHECK_* の on の時だけ */
export async function runComposeChecks(o: {
  conversationId: string | null; customerUnits: string[]; draft: string; groundText: string; blueprint: ComposeBlueprint; timeoutMs?: number;
}): Promise<{ coverage: number | null; coverageMisses: string[]; ground: number | null; sendBack: import("./compose-checks").GroundSendBack | null; reader: import("./compose-checks").CustomerRead | null; digest: string }> {
  const c = await import("./compose-checks");
  let coverage: number | null = null, coverageMisses: string[] = [], ground: number | null = null;
  let sendBack: import("./compose-checks").GroundSendBack | null = null, reader: import("./compose-checks").CustomerRead | null = null;
  if (c.composeCheckOn("coverage")) {
    const miss = c.coverageMisses(o.draft, c.assignAsks(o.customerUnits, o.blueprint));
    coverage = miss.length; coverageMisses = miss.map((m) => m.quote.slice(0, 60));
  }
  if (c.composeCheckOn("ground")) {
    const g = c.groundCheck(o.draft, o.groundText);
    ground = g.misses.length; sendBack = g.sendBack;
  }
  if (c.composeCheckOn("reader")) {
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    if (key) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", signal: AbortSignal.timeout(o.timeoutMs ?? 8_000),
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks("reply_customer_read", o.conversationId) },
          body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 300, system: c.CUSTOMER_READ_SYSTEM, messages: [{ role: "user", content: c.customerReadPrompt({ customerText: o.customerUnits.join("\n"), draft: o.draft }) }] }),
        });
        if (r.ok) { const d = await r.json() as { content?: Array<{ type: string; text?: string }> }; reader = c.parseCustomerRead(d.content?.find((b) => b.type === "text")?.text ?? ""); }
      } catch (e) { console.warn(JSON.stringify({ tag: "compose:reader-failed", error: e instanceof Error ? e.message : String(e) })); }
    }
  }
  return { coverage, coverageMisses, ground, sendBack, reader, digest: c.composeChecksDigest({ coverage, ground, reader, sentBack: !!sendBack }) };
}

/** 外れたら1回だけ書き直す道のきっかけ（COMPOSE_REWRITE=on・既定 off・BRAIN_COMPOSE_BLUEPRINT の下）。
 *  2026-11-03 作業員6（統括「文の統括を本物にする」2）。きっかけ: 設計図から外れた（blueprintDeviations）・答え漏れ・読んだ気持ち（要点）・お客様の読み直し（それぞれのスイッチが on の時だけ）。
 *  根拠の無い文は書き直さない（統括に返す＝compose_sendback）。2回目は無し。 */
export function composeRewriteOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BRAIN_COMPOSE_BLUEPRINT ?? "").trim().toLowerCase() === "on" && (env.COMPOSE_REWRITE ?? "").trim().toLowerCase() === "on";
}
export async function composeRewriteNeed(o: { draft: string; blueprint: ComposeBlueprint; customerUnits: string[]; mainPoint?: string | null; conversationId: string | null }): Promise<{ reasons: string[]; score: number; note: string }> {
  const { blueprintDeviations, blueprintNote: bpNote } = await import("./compose-blueprint");
  const c = await import("./compose-checks");
  const reasons: string[] = [];
  const notes: string[] = [];
  const dev = blueprintDeviations(o.draft, o.blueprint);
  if (dev.length) { reasons.push(...dev.map((d) => `外れ:${d}`)); notes.push(`・設計図から外れた所: ${dev.join("／")}（設計図の部品の順と役割に戻す）`); }
  if (c.composeCheckOn("coverage")) {
    const miss = c.coverageMisses(o.draft, c.assignAsks(o.customerUnits, o.blueprint));
    if (miss.length) { reasons.push(`漏れ:${miss.length}`); notes.push(c.coverageRewriteNote(miss).trim()); }
  }
  if (c.composeCheckWorryOn()) {
    const w = c.worryCheck(o.draft, { mainPoint: o.mainPoint ?? null, worries: [] });
    if (w.mainMissed) { reasons.push("要点"); notes.push(w.note.trim()); }
  }
  if (c.composeCheckOn("reader")) {
    const r = await runComposeChecks({ conversationId: o.conversationId, customerUnits: o.customerUnits, draft: o.draft, groundText: "", blueprint: o.blueprint });
    const rd = r.reader;
    if (rd && (rd.unclear.length || rd.unanswered.length)) { reasons.push(`読み直し:${rd.unclear.length + rd.unanswered.length}`); notes.push(c.customerReadRewriteNote(rd).trim()); }
  }
  const note = reasons.length ? ["【書き直し（1回だけ）】下の文の設計図に沿って、指摘の所だけ直した返信本文を1つ出す（説明は書かない）。", ...notes, bpNote(o.blueprint).trim()].join("\n") : "";
  return { reasons, score: reasons.length, note };
}

/** 2026-11-04 文の受け口（統括 → 文）: Handoff（handoffNote）と統括メタを受けて設計図と書き手への注記を作る。
 *  統括の決定は決め直さない（handoffNote を「状況のまとめ・統括の決定」の口にそのまま入れる）。writer の決まりの本は書き手への注記の後ろに足す。
 *  返す側（設計図・下書き・外れ・no_ground）は compose-port.ts の composeReturnOf で作る */
export async function composeFromConductor(o: {
  conversationId: string | null; customerText: string; scene: string; requirements: ComposeRequirement[]; planMessages?: number;
  handoffNote: string; meta: import("./compose-port").ConductorComposeMeta; situationSummary?: string | null; writerRuleBookNote?: string | null;
}): Promise<ComposeRun> {
  const run = await runComposeBlueprint({
    conversationId: o.conversationId, customerText: o.customerText, scene: o.scene, requirements: o.requirements, planMessages: o.planMessages,
    situation: [o.handoffNote, o.situationSummary ?? ""].filter(Boolean).join("\n\n"),
    conductor: { meta: o.meta, situationSummary: o.situationSummary ?? null },
  });
  return o.writerRuleBookNote ? { ...run, note: `${run.note}\n\n${o.writerRuleBookNote}` } : run;
}
