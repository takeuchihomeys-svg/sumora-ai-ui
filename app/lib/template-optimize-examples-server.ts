// app/lib/template-optimize-examples-server.ts
// AIX の後の一言（テンプレ最適化・🟣 AIX モード）に見せる「同じテンプレのスタッフの実送信」を DB から引く（判定は template-optimize-context.ts の純関数）。
//
// 2026-09-27 竹内「実際のスタッフが送った文のように質を上げる」:
//   旧は adaptation_improvement_rules の上位5件を「必ず守ること」で入れていた（「ご査収で締める」と「積極的な申込を提示」が食い違う・
//   見積書の2位が「冒頭は〇〇さんお待たせ致しました」＝9/27 の禁止と逆・件数はバッチの修正件数の水増し）。
//   代わりに、同じテンプレ（template_id）を最適化して実際に送った文を新しい順に、同じピッカーを優先して3通まで見せる。
//   他のお客様の会話なので、名前・物件名・金額・駅・日付を伏せ（maskStaffExample）、伏せた物件名は漏れの検査に返す。
//   テスト用の会話（YUMA）・今の会話は除く。本文が長すぎる物（600字超）は手本にしない（一言の形の手本なので）。
import { maskStaffExample, pickStaffExamples, buildStaffExamplesNote } from "./template-optimize-context";
import { TEST_CONVERSATIONS_IN } from "./test-conversations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SbLike = { from: (t: string) => any };

export type StaffTemplateExamples = { note: string; masked: string[]; count: number };

export async function fetchStaffTemplateExamples(
  sb: SbLike,
  opts: {
    templateId: string | null; templateLabel: string; templateCategory: string; pickerMode: string | null;
    conversationId: string | null | undefined;
    /** 過去の実例で作り直す時だけ（手元の開発サーバ）: この時刻より前の送信だけを手本にする */
    before?: string | null;
    days?: number; limit?: number;
  },
): Promise<StaffTemplateExamples> {
  const empty: StaffTemplateExamples = { note: "", masked: [], count: 0 };
  try {
    let id = opts.templateId;
    if (!id && opts.templateLabel) {
      const q = sb.from("templates").select("id").eq("label", opts.templateLabel);
      const { data } = await (opts.templateCategory ? q.eq("category", opts.templateCategory) : q).limit(1);
      id = (data as Array<{ id: string }> | null)?.[0]?.id ?? null;
    }
    if (!id) return empty;
    const beforeMs = opts.before ? Date.parse(opts.before) : Date.now();
    const since = new Date(beforeMs - (opts.days ?? 60) * 86400e3).toISOString();
    const { data, error } = await sb.from("template_selection_logs")
      .select("conversation_id, picker_mode, final_sent_text, created_at")
      .eq("template_id", id)
      .not("final_sent_text", "is", null)
      .not("conversation_id", "in", TEST_CONVERSATIONS_IN)
      .gte("created_at", since)
      .lt("created_at", new Date(beforeMs).toISOString())
      .order("created_at", { ascending: false })
      .limit(40);
    if (error || !data) return empty;
    const rows = (data as Array<{ conversation_id: string | null; picker_mode: string | null; final_sent_text: string | null }>)
      .filter((r) => (r.final_sent_text ?? "").trim().length > 0 && (r.final_sent_text ?? "").length <= 600)
      .map((r) => ({ text: r.final_sent_text as string, pickerMode: r.picker_mode, conversationId: r.conversation_id }));
    const picked = pickStaffExamples(rows, { pickerMode: opts.pickerMode, excludeConversationId: opts.conversationId ?? null, limit: opts.limit ?? 3 });
    if (picked.length === 0) return empty;
    const convIds = [...new Set(picked.map((p) => p.conversationId).filter((c): c is string => !!c))];
    // 表示名と、希望条件の登録名（property_customers.customer_name・表示名と違う呼び名のことがある）の両方を伏せる候補にする（9/27 検証の指摘）
    const names = new Map<string, Array<string | null>>();
    if (convIds.length) {
      const { data: convs } = await sb.from("conversations").select("id, customer_name, property_customer_id").in("id", convIds);
      const rowsC = (convs ?? []) as Array<{ id: string; customer_name: string | null; property_customer_id?: string | null }>;
      const pcIds = [...new Set(rowsC.map((c) => c.property_customer_id).filter((x): x is string => !!x))];
      const pcName = new Map<string, string | null>();
      if (pcIds.length) {
        const { data: pcs } = await sb.from("property_customers").select("id, customer_name").in("id", pcIds);
        for (const p of (pcs ?? []) as Array<{ id: string; customer_name: string | null }>) pcName.set(p.id, p.customer_name);
      }
      for (const c of rowsC) names.set(c.id, [c.customer_name, c.property_customer_id ? pcName.get(c.property_customer_id) ?? null : null]);
    }
    const masked: string[] = [];
    const texts = picked.map((p) => {
      const m = maskStaffExample(p.text, p.conversationId ? names.get(p.conversationId) ?? [] : []);
      masked.push(...m.masked);
      return m.text;
    });
    return { note: buildStaffExamplesNote(texts), masked: [...new Set(masked)], count: texts.length };
  } catch (e) {
    console.error("[template-optimize-examples] 手本の取得に失敗 — 手本なしで続行:", e instanceof Error ? e.message : e);
    return empty;
  }
}
