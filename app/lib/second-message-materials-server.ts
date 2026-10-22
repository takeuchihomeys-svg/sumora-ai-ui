// app/lib/second-message-materials-server.ts
// AIX の2通目の材料を読む（DB）。判定・組み立ては second-message-materials.ts（純関数）。既定 on（SECOND_MSG_MATERIALS=off で呼ばない）。
import { supabase } from "@/app/lib/supabase-server";
import { LLM_POST_APPLY_HEADER, LLM_CUTOFF_HEADER, sumoraLlmMarks } from "@/app/lib/llm-usage-recorder";
import { loadPostApplyFacts, resolvePostApply, deepseekSafeCutoff, cutoffMs, NO_CUTOFF } from "@/app/lib/post-apply";
import { loadScreeningSensitive, screeningSensitiveInMessages, screeningPiiClaudeEnabled } from "@/app/lib/screening-sensitive";
import { buildCompanyFactsNote } from "@/app/lib/company-facts";
import { resolveReplyScene } from "@/app/lib/reply-scene";
import { maskPIIForAlt } from "@/app/lib/pii-mask";
import { loadAltNameMask } from "@/app/lib/pii-known-names";
import {
  splitTurn, sentThisTurn, outstandingAsks, openPromises, confirmAnswersOf, askedCostKind, lastCustomerBundle,
  buildSecondMaterialsNote, secondMaterialsRoute, buildBrainBundleNote, buildPropertyJudgeNote, type SmMsg, type SentThisTurn, type BrainBundleMeta,
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
  /** 2026-10-22 統括（LINE のブレイン）の判断（resolveBrainMetaForGeneration で戻した物＝1通目を送って suggested_aix_meta が消えた時は last_brain_meta） */
  brainMeta?: BrainBundleMeta;
  /** 押した AIX のピッカー（物件確認した＝check_pattern・物件オススメ＝pickup_type） */
  pickerValue?: string | null;
  /** 2通目が推す物件の売上サポの行（物件オススメ・ピックアップの後） */
  propertyRow?: { property_name?: string | null; room_no?: string | null; recommended?: number | boolean | null; reason_codes?: string[] | null } | null;
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
  let account: string | null = null, pcId: string | null = null, ngPoints = (o.ngPointsFromBrain ?? "").trim() || null;
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
      pcId = c?.property_customer_id ?? null;
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
  // 2026-10-22 統括の判断の束・このボタン／ピッカーの意味（竹内基準）・物件の判断の中身
  let brainBundleNote = "", meaningNote = "", propertyJudgeNote = "";
  try {
    const cat = await import("@/app/lib/aix-catalog");
    const labelOf = (k: string, p: string | null) => {
      const e = cat.AIX_CATALOG.find((x) => x.key === (p ? `${k}/${p}` : k)) ?? cat.AIX_CATALOG.find((x) => x.aixType === k);
      return e ? `【${e.button}】${e.picker && (!p || e.picker.value === p) ? `→${e.picker.label}` : ""}` : k;
    };
    brainBundleNote = buildBrainBundleNote(o.brainMeta, { actionType: o.actionType, checkPattern: o.pickerValue ?? null, messages: o.recent, labelOf });
    const a = (o.actionType ?? "").trim();
    // お手本（1通目の文）は渡さない: 1通目の金額・物件名を2通目に写す恐れ（試しの生成で「36,000円割引」のお手本がそのまま見えた）。
    //   竹内さんの文の型も1通目の物＝外す。目的・入る物・この後に多い事（次の一手＝2通目の締めの向き）だけ
    const m = a ? cat.aixMeaningForGenerator(a, o.pickerValue ?? null, { maxExemplars: 0 }).split("\n").filter((l) => !/^竹内さんの文の型|^竹内さんのお手本が少ない/.test(l)).join("\n") : "";
    if (m) meaningNote = `${m}\n（↑ 1通目（AIX）の意味・竹内さんの送信から学んだ物。2通目はこの目的の続き・「この後に多い事」へ自然につなぐ。1通目の言い回しを繰り返さない）`;
  } catch (e) { console.warn("[second-materials] 統括の判断・意味が読めない", e instanceof Error ? e.message : String(e)); }
  if (o.propertyRow?.property_name) {
    try {
      const { customerReasonSplit } = await import("@/app/lib/property-brain");
      const sp = customerReasonSplit(o.propertyRow.reason_codes ?? []);
      let reaction: { good?: boolean; declined?: boolean; attrsJa?: string[] } | null = null;
      let bundleNegativesJa: string[] = [];
      // 送った物件へのお客様の反応（AIX_REACTIONS_LINK の時だけ loadReactionState が読む・申込以降・読めない時は渡さない）
      if (cid && pcId && !postApply && !readFailed) {
        const rx = await import("@/app/lib/reaction-negatives-server");
        const st = await within(5_000, rx.loadReactionState(supabase, pcId), null);
        if (st) {
          const { REACTION_ATTR_JA } = await import("@/app/lib/reaction-negatives");
          const pr = st.perProperty[rx.propKeyOf(o.propertyRow.property_name, o.propertyRow.room_no ?? null).key];
          if (pr) reaction = { good: pr.good, declined: pr.declined, attrsJa: pr.attrs.map((x) => REACTION_ATTR_JA[x]) };
          bundleNegativesJa = [...new Set(st.negatives.filter((x) => !(pr && x.scope === "property" && x.propKey === rx.propKeyOf(o.propertyRow?.property_name, o.propertyRow?.room_no ?? null).key)).map((x) => REACTION_ATTR_JA[x.attr]))];
        }
      }
      const room = o.propertyRow.room_no ? `${String(o.propertyRow.room_no).replace(/号室$/, "")}号室` : "";
      propertyJudgeNote = buildPropertyJudgeNote({ label: [o.propertyRow.property_name, room].filter(Boolean).join(" "), recommended: !!o.propertyRow.recommended, goodJa: sp.goodJa, badJa: sp.badJa, reaction, bundleNegativesJa });
    } catch (e) { console.warn("[second-materials] 物件の判断が読めない", e instanceof Error ? e.message : String(e)); }
  }
  let note = buildSecondMaterialsNote({ sent, asks, promises, answers, ngPoints, companyFactsNote, memoNote, costKind, brainBundleNote, meaningNote, propertyJudgeNote });

  let goesAlt = false;
  try { goesAlt = (await import("@/app/lib/llm-alt-provider")).willRouteAlt("aix_template", { postApply }); } catch { goesAlt = false; }
  // 審査について（guarantor_info）・物件確認した→審査（mgmt_screening）の2通目は 1通目と同じく Claude に固定（aixRequestMustUseClaude）
  let mustClaude = false;
  try { mustClaude = (await import("@/app/lib/aix-new-pickers")).aixRequestMustUseClaude({ action: o.actionType ?? null, check_pattern: o.pickerValue ?? null }); } catch { mustClaude = true; }
  const route = secondMaterialsRoute({ postApply, cutoffAll, sensitive: sensitive || mustClaude, readFailed, goesAlt });
  const headers: Record<string, string> = route === "pin"
    ? { ...sumoraLlmMarks("aix_template", cid), [LLM_POST_APPLY_HEADER]: "1" }
    : route === "alt" ? { ...sumoraLlmMarks("aix_template", cid), [LLM_CUTOFF_HEADER]: "all" } : {};
  if (route === "alt" && note) {
    try { note = maskPIIForAlt(note, await loadAltNameMask(cid, o.names)); }
    catch { return { note: "", sent, asks, costKind, headers: { ...sumoraLlmMarks("aix_template", cid), [LLM_POST_APPLY_HEADER]: "1" }, route: "pin" }; }
  }
  console.log(JSON.stringify({ tag: "aix-template-generate:second-materials", route, sent: { kind: sent.kind, est: sent.estimates.length, img: sent.images, any: sent.anySent }, asks: asks.length, promises: promises.length, answers: answers.length, memo: memoNote.length, cost: costKind, bundle: brainBundleNote.length, meaning: meaningNote.length, judge: propertyJudgeNote.length }));
  return { note, sent, asks, costKind, headers, route };
}

/**
 * 2026-10-20 レビュー: 材料のスイッチが off の時も、AIX テンプレ（aix_template）が DeepSeek に回る設定の時だけ、個人情報の線を同じ決まりで引く。
 *   旧は会話の印もヘッダも無く、出口の時刻の線の歯止め（cutoffGateDecision）が「印なし＝回す」と読んで、申込以降・審査の事情の会話も DeepSeek に出ていた。
 *   本番は aix_template を回していない（LLM_ALT_ACTIONS=reply_generate）ので、呼ぶ側は willRouteAlt が true の時だけ呼ぶ＝本番の Claude の呼び出しは1バイトも変わらない。
 *   戻り: Claude に固定（申込以降・審査の事情・申込の線・読めない）／全部渡してよい会話は印 all（今までどおり回る）
 */
export async function aixTemplatePiiHeaders(conversationId: string | null | undefined, recent: ReadonlyArray<SmMsg>): Promise<Record<string, string>> {
  const cid = (conversationId ?? "").trim() || null;
  const pin = { ...sumoraLlmMarks("aix_template", cid), [LLM_POST_APPLY_HEADER]: "1" };
  if (!cid) return pin;
  try {
    const [facts, sens] = await Promise.all([
      loadPostApplyFacts(supabase, cid),
      screeningPiiClaudeEnabled()
        ? (screeningSensitiveInMessages(recent.map((m) => ({ sender: m.sender ?? null, text: m.text ?? null }))) ?? loadScreeningSensitive(supabase, cid))
        : Promise.resolve(null),
    ]);
    const postApply = resolvePostApply(facts).postApply;
    const cutoffAll = cutoffMs(deepseekSafeCutoff(facts)) === NO_CUTOFF;
    return secondMaterialsRoute({ postApply, cutoffAll, sensitive: !!sens, goesAlt: true }) === "alt"
      ? { ...sumoraLlmMarks("aix_template", cid), [LLM_CUTOFF_HEADER]: "all" }
      : pin;
  } catch {
    return pin;
  }
}
