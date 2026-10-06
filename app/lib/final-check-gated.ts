// app/lib/final-check-gated.ts
// 最終チェックの入口を1つにする（要否の判定 → 今までどおりの検査 or 決定論だけ）。
//
// 2026-10-02 竹内「ファイナルチェックが必要かどうかの監査をつけたらAPIも節約できるし、無駄がなくなる」
//   判定は app/lib/final-check-gate.ts の needsFinalCheck（純関数）。ここは呼び分けと記録だけ。
//   ・既定（FINAL_CHECK_GATE 未設定）＝影の運用: 判定を記録するだけで、今までどおり全部チェックする
//   ・FINAL_CHECK_GATE=on: skip の時だけ LLM の3パスと書き直しを省き、決定論の検査だけにする
//   ・センシティブ案件は今までどおり runFinalCheck（書き直しなし）
//   記録: CheckResult.gate（ai_draft_check・トレーラー）＋ログ tag "final-check:gate"。
//   generate-reply は tpo_debug.finalCheckGate にも同じ物を積む（作り直しで finalCheck が置き換わっても残る・送った例の記録に残る）。
//   監査: scripts/audit-final-check-gate.ts の ⑦（影の運用の skip 率と、skip で LLM が指摘した回）
import { runFinalCheck, runFinalCheckWithRevision, runDeterministicChecks, sha1, type CheckResult, type FinalCheckContext, type RevisionLoopResult } from "./final-check";
import { needsFinalCheck, finalCheckGateEnforced, type FinalCheckGateRun } from "./final-check-gate";

/** 記録の形（JSONB にそのまま入る小さな形） */
export type FinalCheckGateLog = {
  run: FinalCheckGateRun;
  reasons: string[];
  /** 実際に省いたか（on かつ skip の時だけ true） */
  applied: boolean;
  mode: "on" | "shadow";
  version: string;
  /** 決まり文句に当たらなかった文（先頭3つ・40字） */
  unsafe: string[];
  /** 2026-10-02 竹内「最終チェックがボトルネックになってる部分…生成のところとくらべて邪魔になっている部分も調査」:
   *  最終チェック（書き直し・再検査込み）にかかった時間 ms */
  ms?: number;
  /** 書き直しで本文が変わった時だけ、チェック前の本文（600字）。生成→書き直し後→スタッフの実送信を比べる材料（scripts/audit-final-check-gate.ts ⑪） */
  draftIn?: string;
  /** 書き直しを省いた理由（"style_only"） */
  revisionSkipped?: string;
  /** 2026-10-06 点検: 直す指摘があったのに書き直しを採らなかった理由（CheckResult.revision_dropped と同じ値・scripts/audit-final-check-coverage.ts ②） */
  revisionDropped?: string;
};

export type GatedOptions = {
  /** センシティブ案件（route の sensitiveGateNote が空でない） */
  sensitive: boolean;
  /** conversations.auto_send_enabled */
  autoSendConversation: boolean;
  postApply?: boolean;
  stateUnknown?: boolean;
  budgetMs?: number;
  conversationId?: string | null;
  env?: Record<string, string | undefined>;
};

export async function runFinalCheckGated(draft: string, ctx: FinalCheckContext, o: GatedOptions): Promise<RevisionLoopResult & { gate: FinalCheckGateLog }> {
  const started = Date.now();
  // 決定論の検査（約0ms）を先に1回。block があれば修正ループが要る＝全部チェック
  let det: ReturnType<typeof runDeterministicChecks> = [];
  let detFailed = false;
  try { det = runDeterministicChecks(draft, ctx); } catch { detFailed = true; }
  const decision = needsFinalCheck({
    draft,
    customerText: ctx.lastCustomerMessage ?? "",
    customerName: ctx.customerName ?? null,
    isSensitive: o.sensitive,
    isAutoSendConversation: o.autoSendConversation,
    enforcementRequired: ctx.brainMeta?.enforcement_level === "required",
    isFirstContact: !!ctx.isEarlyConversation,
    detBlock: detFailed || det.some((i) => i.severity === "block"),
    postApply: o.postApply,
    stateUnknown: o.stateUnknown,
  });
  const enforced = finalCheckGateEnforced(o.env ?? process.env);
  const applied = enforced && decision.run === "skip";
  const gate: FinalCheckGateLog = {
    run: decision.run, reasons: decision.reasons, applied, mode: enforced ? "on" : "shadow", version: decision.version,
    unsafe: decision.unsafeSentences.slice(0, 3).map((s) => s.slice(0, 40)),
  };
  console.log(JSON.stringify({ tag: "final-check:gate", conversationId: o.conversationId ?? null, run: gate.run, applied, mode: gate.mode, reasons: gate.reasons }));

  let loop: RevisionLoopResult;
  if (o.sensitive) {
    // センシティブ案件は今までどおり（チェックのみ・書き直しなし）
    loop = { finalDraft: draft, finalCheck: await runFinalCheck(draft, ctx) };
  } else if (applied) {
    // 省く: 決定論の検査だけ（block は無い＝判定の条件）。passes_completed は空＝「3重チェック済み」とは表示しない
    const result: CheckResult = {
      ok: !det.some((i) => i.severity === "block"),
      issues: det,
      passes_completed: [],
      elapsed_ms: Date.now() - started,
      checked_text_hash: await sha1(draft.trim()),
      revision_count: 0,
      pre_revision_issues: det.map((i) => `${i.code}:${i.severity}`),
    };
    loop = { finalDraft: draft, finalCheck: result };
  } else {
    loop = await runFinalCheckWithRevision(draft, ctx, o.budgetMs ?? 90000);
  }
  gate.ms = Date.now() - started;
  if (loop.finalDraft !== draft) gate.draftIn = draft.slice(0, 600);
  if (loop.finalCheck.revision_skipped) gate.revisionSkipped = loop.finalCheck.revision_skipped;
  if (loop.finalCheck.revision_dropped) gate.revisionDropped = loop.finalCheck.revision_dropped;
  (loop.finalCheck as CheckResult & { gate?: FinalCheckGateLog }).gate = gate;
  return { ...loop, gate };
}
