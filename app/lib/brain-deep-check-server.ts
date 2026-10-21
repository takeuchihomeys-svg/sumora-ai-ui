// app/lib/brain-deep-check-server.ts（サーバー専用・DB・必要な時だけ間取り図の読み）
// ブレインの1回目の判断で「根拠が足りない」依頼があった時だけ、足りない種類の材料を追加で引く（brain-deep-check.ts の決まりで呼ぶ）。
//   1回目と違う所: ①網に当てる文はブレインが言い換えた依頼（quote）＋お客様の文 ②対象の物件はブレインの current_property（1回目はお客様が物件を持ち込んだ番は対象なし）
//   ③過去の会話（1回目の履歴より前も）から依頼の型の行。材料の作り方そのものは今ある関数（設備・契約条件・間取り/広さ・手続き・確認した系・会社の事実）。
import { supabase } from "@/app/lib/supabase-server";
import { buildCompanyFactsNote } from "@/app/lib/company-facts";
import { detectConfirmTopics } from "@/app/lib/procedure-question";
import { splitPropertyName } from "@/app/lib/customer-state";
import { pastConversationLines, newMaterialOnly, queryKeywords, type DeepCheckTopic } from "@/app/lib/brain-deep-check";

export type DeepCheckMaterial = { notes: string[]; sources: string[]; ms: number };

export async function loadDeepCheckMaterial(o: {
  conversationId: string;
  /** ブレインの依頼の言葉（gap=material／網の候補） */
  queries: string[];
  topics: DeepCheckTopic[];
  customerText: string;
  /** ブレインの current_property（無ければ1回目の主のお部屋） */
  currentProperty: string | null;
  fallbackTarget: { name: string; roomNo: string | null; vacating?: boolean } | null;
  /** 1回目にブレインへ渡した文（同じ材料は足さない） */
  alreadyGiven: string;
  turnStartIso: string | null;
  account?: string | null;
  budgetMs?: number;
}): Promise<DeepCheckMaterial> {
  const t0 = Date.now();
  const budget = o.budgetMs ?? 12_000;
  const text = [...o.queries.map((q) => (/[?？]|ですか|ますか/.test(q) ? q : `${q}ですか？`)), o.customerText].join("\n");
  const ref = o.currentProperty ? splitPropertyName(o.currentProperty) : null;
  const target = ref?.building ? { name: ref.building, roomNo: ref.room ?? null } : o.fallbackTarget ? { name: o.fallbackTarget.name, roomNo: o.fallbackTarget.roomNo } : null;
  const notes: Array<{ src: string; note: string | null | undefined }> = [];
  const jobs: Array<Promise<void>> = [];
  const add = (src: string, p: Promise<string | null | undefined>) => jobs.push(p.then((note) => { notes.push({ src, note }); }).catch((e) => { console.warn(`[brain-deep-check] ${src} skipped:`, e instanceof Error ? e.message : String(e)); }));
  add("equipment", import("@/app/lib/equipment-answer-server").then(({ loadEquipmentAnswerWithin }) => loadEquipmentAnswerWithin(budget, { conversationId: o.conversationId, customerText: text })).then((r) => r?.note));
  add("contract_terms", import("@/app/lib/contract-terms-answer-server").then(({ loadContractTermsAnswerWithin }) => loadContractTermsAnswerWithin(budget, { conversationId: o.conversationId, customerText: text, target })).then((r) => r?.note));
  add("material", import("@/app/lib/material-answer-server").then(({ loadMaterialAnswerWithin }) => loadMaterialAnswerWithin(budget, { conversationId: o.conversationId, customerText: text, target })).then((r) => r?.note));
  add("procedure", import("@/app/lib/procedure-answer-server").then(({ loadProcedureAnswerWithin }) => loadProcedureAnswerWithin(budget, { conversationId: o.conversationId, customerText: text, target: target ? { ...target, vacating: o.fallbackTarget?.vacating } : null })).then((r) => r?.note));
  const confirmTopics = detectConfirmTopics(text);
  if (confirmTopics.length && target) {
    add("confirm_topic", import("@/app/lib/procedure-answer-server").then(({ loadConfirmTopicRoutesWithin }) => loadConfirmTopicRoutesWithin(budget, { conversationId: o.conversationId, topics: confirmTopics, target })).then((r) => r?.note));
  }
  add("company_fact", Promise.resolve(buildCompanyFactsNote(text, { account: o.account ?? null })));
  // 過去の会話（1回目の履歴より前も・依頼の型の語がある行だけ・最大6行）
  add("past_conversation", (async () => {
    const keywords = queryKeywords(o.queries);
    if (!o.topics.length && !keywords.length) return null;
    // 前のこちらの文（約束・資料の送付）も含める（線はその文の直後）
    const beforeMs = o.turnStartIso ? Date.parse(o.turnStartIso) + 1 : Date.now();
    const { data } = await supabase.from("messages").select("sender, text, created_at").eq("conversation_id", o.conversationId)
      .lt("created_at", new Date(beforeMs).toISOString()).order("created_at", { ascending: false }).limit(400);
    const rows = ((data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).reverse();
    // 履歴に既にある行も抜き出して見せる（1回目は履歴にあっても根拠に気づかなかった＝焦点を当てる）
    const lines = pastConversationLines({ messages: rows, topics: o.topics, beforeMs, max: 6, keywords });
    return lines.length ? `【過去の会話から（依頼に関係する行・古い履歴を含む・新しい順）】\n${lines.join("\n")}` : null;
  })());
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, budget + 1_000))]);
  const fresh = newMaterialOnly(notes.map((n) => n.note), o.alreadyGiven);
  const sources = notes.filter((n) => n.note && fresh.includes(String(n.note).trim())).map((n) => n.src);
  return { notes: fresh, sources, ms: Date.now() - t0 };
}
