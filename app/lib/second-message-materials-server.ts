// app/lib/second-message-materials-server.ts
// AIX の2通目の材料を読む（DB）。判定・組み立ては second-message-materials.ts（純関数）。SECOND_MSG_MATERIALS=on の時だけ呼ぶ。
import { supabase } from "@/app/lib/supabase";
import { LLM_POST_APPLY_HEADER, LLM_CUTOFF_HEADER, sumoraLlmMarks } from "@/app/lib/llm-usage-recorder";
import { loadPostApplyFacts, resolvePostApply, deepseekSafeCutoff, cutoffMs, NO_CUTOFF } from "@/app/lib/post-apply";
import { loadScreeningSensitive, screeningSensitiveInMessages, screeningPiiClaudeEnabled } from "@/app/lib/screening-sensitive";
import { buildCompanyFactsNote } from "@/app/lib/company-facts";
import { resolveReplyScene } from "@/app/lib/reply-scene";
import { maskPIIForAlt } from "@/app/lib/pii-mask";
import { loadAltNameMask } from "@/app/lib/pii-known-names";
import {
  splitTurn, sentThisTurn, outstandingAsks, openPromises, confirmAnswersOf, askedCostKind, lastCustomerBundle,
  buildSecondMaterialsNote, secondMaterialsRoute, type SmMsg, type SentThisTurn,
} from "@/app/lib/second-message-materials";
import type { LedgerItem } from "@/app/lib/request-ledger";

export type SecondMaterials = {
  note: string;
  sent: SentThisTurn;
  asks: LedgerItem[];
  costKind: "initial" | "monthly" | null;
  /** callClaude に足すヘッダ（pin＝Claude に固定／alt＝印 all） */
  headers: Record<string, string>;
  route: "pin" | "alt" | "claude";
};

const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> => Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

export async function loadSecondMaterials(o: {
  conversationId: string | null | undefined;
  actionType: string | null | undefined;
  recent: ReadonlyArray<SmMsg>;
  sentMessage: string | null | undefined;
  brainRequestStatus?: unknown;
  ngPointsFromBrain?: string | null;
  names: ReadonlyArray<string | null | undefined>;
}): Promise<SecondMaterials> {
  const nowMs = Date.now();
  const cid = (o.conversationId ?? "").trim() || null;
  const { before, turnStaff } = splitTurn(o.recent, o.sentMessage);
  const sent = sentThisTurn({ actionType: o.actionType, turnStaff });
  const asks = outstandingAsks(o.recent, turnStaff, nowMs, o.brainRequestStatus);
  const promises = openPromises(o.recent, turnStaff, nowMs);
  const bundle = lastCustomerBundle(before);
  const costKind = askedCostKind(bundle);

  let postApply = true, cutoffAll = false, sensitive = false, readFailed = !cid;
  let account: string | null = null, ngPoints = (o.ngPointsFromBrain ?? "").trim() || null;
  let answers: string[] = [];
  if (cid) {
    try {
      const [facts, conv, checks, sens] = await Promise.all([
        loadPostApplyFacts(supabase, cid),
        supabase.from("conversations").select("account, property_customer_id").eq("id", cid).maybeSingle(),
        supabase.from("aix_usage_logs").select("generated_text, created_at").eq("conversation_id", cid)
          .eq("aix_type", "property_check_result").not("sent_at", "is", null).order("created_at", { ascending: false }).limit(10),
        screeningPiiClaudeEnabled()
          ? (screeningSensitiveInMessages(o.recent.map((m) => ({ sender: m.sender ?? null, text: m.text ?? null }))) ?? loadScreeningSensitive(supabase, cid))
          : Promise.resolve(null),
      ]);
      postApply = resolvePostApply(facts).postApply;
      cutoffAll = cutoffMs(deepseekSafeCutoff(facts)) === NO_CUTOFF;
      sensitive = !!sens;
      readFailed = false;
      const c = (conv.data ?? null) as { account?: string | null; property_customer_id?: string | null } | null;
      account = c?.account ?? null;
      answers = confirmAnswersOf((checks.data ?? []) as Array<{ generated_text?: string | null; created_at?: string | null }>, { nowMs });
      if (!ngPoints && c?.property_customer_id) {
        const { data: pc } = await supabase.from("property_customers").select("ng_points").eq("id", c.property_customer_id).maybeSingle();
        ngPoints = ((pc as { ng_points?: string | null } | null)?.ng_points ?? "").trim() || null;
      }
    } catch (e) {
      // 読めない時は Claude に固定（個人情報を外に出さない側）
      readFailed = true;
      console.warn("[second-materials] 読めない → Claude に固定", e instanceof Error ? e.message : String(e));
    }
  }
  // お客様のメモは返信と同じ関数（申込以降・読めない時は渡さない）
  const memoNote = cid && !postApply && !readFailed
    ? await within(5_000, import("@/app/lib/customer-memo-server").then((m) => m.customerMemoReplyNoteFor(cid, { scene: resolveReplyScene({ customerText: bundle.join("\n") }).scene })), "")
    : "";
  const companyFactsNote = buildCompanyFactsNote(bundle, { account });
  let note = buildSecondMaterialsNote({ sent, asks, promises, answers, ngPoints, companyFactsNote, memoNote, costKind });

  let goesAlt = false;
  try { goesAlt = (await import("@/app/lib/llm-alt-provider")).willRouteAlt("aix_template", { postApply }); } catch { goesAlt = false; }
  const route = secondMaterialsRoute({ postApply, cutoffAll, sensitive, readFailed, goesAlt });
  const headers: Record<string, string> = route === "pin"
    ? { ...sumoraLlmMarks("aix_template", cid), [LLM_POST_APPLY_HEADER]: "1" }
    : route === "alt" ? { ...sumoraLlmMarks("aix_template", cid), [LLM_CUTOFF_HEADER]: "all" } : {};
  if (route === "alt" && note) {
    try { note = maskPIIForAlt(note, await loadAltNameMask(cid, o.names)); }
    catch { return { note: "", sent, asks, costKind, headers: { ...sumoraLlmMarks("aix_template", cid), [LLM_POST_APPLY_HEADER]: "1" }, route: "pin" }; }
  }
  console.log(JSON.stringify({ tag: "aix-template-generate:second-materials", route, sent: { kind: sent.kind, est: sent.estimates.length, img: sent.images, any: sent.anySent }, asks: asks.length, promises: promises.length, answers: answers.length, memo: memoNote.length, cost: costKind }));
  return { note, sent, asks, costKind, headers, route };
}
