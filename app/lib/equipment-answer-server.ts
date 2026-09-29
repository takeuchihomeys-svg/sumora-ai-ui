// app/lib/equipment-answer-server.ts（サーバー専用・DB・DeepSeek。画面側から import しない）
// お客様が送った物件の設備を聞いた時に、資料（文字層・送った資料の画像の設備欄・間取り図の読み取り）から答えの材料を作る。
// 決まり（どの物件か・有る／言い切れない／分からない・本文で答えるか確認するか）は純関数 equipment-question.ts に1つ。
//
// 2026-09-29 竹内（林田尚貴さん「ガスコンロはついてないのですか？」）「この場合はガスコンロ付きかどうか画像分析をおこなう」
//   ・新しい LLM 呼び出しは「文字層が無い（画像だけで送った）物件の設備欄を、送った資料の画像から写す」1回だけ。
//     同じ画像は property_sheet_facts に保存して読み直さない（sheet_type='equipment_text'・prompt_version=SHEET_EQTEXT_PROMPT_VERSION・
//     unit_key='eqtext|<画像URLのハッシュ>'。画像で分析の読み取り SHEET_PROMPT_VERSION とは版が違うので、そちらの引き当てには混ざらない）
//   ・写真の中の設備（コンロ等）は読ませない（equipment-question.ts の説明: DeepSeek は両向きに読み違えた）
//   ・読めない・時間切れは「材料なし」（呼び出し側は今まで通り）。Claude には倒さない
import { createHash } from "node:crypto";
import { supabase } from "@/app/lib/supabase";
import { callDeepSeekRead } from "@/app/lib/vision-alt-provider";
import { parseListingEquipment, downgradeNegatedItems, type EquipKey, type EquipFact } from "@/app/lib/listing-equipment";
import {
  detectEquipmentQuestion, pickEquipmentTargets, resolveEquipAnswer, equipAnswerPlan, buildEquipmentAnswerNote, textItemsFromSheetText,
  parseSheetEquipText, SHEET_EQTEXT_PROMPT, SHEET_EQTEXT_PROMPT_VERSION, SHEET_EQTEXT_MAX_TOKENS,
  pickupMaterialUsable, PICKUP_MATERIAL_MAX_DAYS,
  type EquipmentQuestion, type EquipAnswerPlan, type EquipPropertyAnswer, type SheetEquipText, type PlanFactsLite, type SentPropertyLite,
} from "@/app/lib/equipment-question";

const FACTS_TABLE = "property_sheet_facts";
const READ_TIMEOUT_MS = 20_000;

export type SheetEquipTextRead = { facts: SheetEquipText | null; source: "saved" | "read" | "none"; ms: number };

/** 送った資料の画像から設備欄の文字を写す（保存済みを先に引く・無ければ DeepSeek で1回＝崩れた時だけ同じ前置きで読み直し） */
export async function readSheetEquipText(imageUrl: string, o?: { conversationId?: string | null; timeoutMs?: number }): Promise<SheetEquipTextRead> {
  const t0 = Date.now();
  if (!/^https?:\/\//.test(imageUrl)) return { facts: null, source: "none", ms: 0 };
  const unitKey = `eqtext|${createHash("sha1").update(imageUrl).digest("hex")}`;
  const { data: saved, error } = await supabase.from(FACTS_TABLE).select("text_facts")
    .eq("unit_key", unitKey).eq("prompt_version", SHEET_EQTEXT_PROMPT_VERSION).limit(1);
  if (error) console.warn("[equipment-answer] 保存した読み取りを引けない:", error.message);
  const hit = (saved?.[0]?.text_facts ?? null) as SheetEquipText | null;
  if (hit && typeof hit.equip_text === "string") return { facts: hit, source: "saved", ms: Date.now() - t0 };

  const content = [{ type: "text", text: SHEET_EQTEXT_PROMPT }, { type: "image_url", image_url: { url: imageUrl } }];
  const budget = o?.timeoutMs ?? READ_TIMEOUT_MS;
  const read = await callDeepSeekRead(null, content, { maxTokens: SHEET_EQTEXT_MAX_TOKENS, timeoutMs: budget }, parseSheetEquipText,
    { retryIf: (elapsed) => budget - elapsed >= 3_000, retryTimeoutMs: (elapsed) => budget - elapsed });
  void import("./llm-usage-recorder").then(({ recordAltUsage }) => {
    for (const a of read.attempts) {
      recordAltUsage({
        model: a.res?.model ?? "deepseek", action: "equipment_sheet_text", conversationId: o?.conversationId ?? null,
        usage: { input_tokens: a.res?.usage.cacheMiss ?? 0, output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
        status: a.res ? 200 : 0, errorType: a.ok ? null : a.res ? "empty_or_unparsable" : "no_response",
        durationMs: a.ms, sysHead: (a.retry ? "【読み直し】" : "") + SHEET_EQTEXT_PROMPT.slice(0, 180), sysKeyFull: null, maxTokens: SHEET_EQTEXT_MAX_TOKENS,
      });
    }
  }).catch(() => {});
  const facts = read.value;
  if (!facts) return { facts: null, source: "none", ms: Date.now() - t0 };
  const { error: e2 } = await supabase.from(FACTS_TABLE).upsert({
    unit_key: unitKey, site: null, sheet_type: "equipment_text", crop_mode: "page", crop_basis: null,
    image_facts: null, text_facts: facts, model: read.res?.model ?? null, prompt_version: SHEET_EQTEXT_PROMPT_VERSION, updated_at: new Date().toISOString(),
  }, { onConflict: "unit_key,prompt_version" });
  if (e2) console.warn("[equipment-answer] 読み取りを保存できない:", e2.message);
  return { facts, source: "read", ms: Date.now() - t0 };
}

const roomNorm = (r: string | null | undefined) => String(r ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+/, "").trim();

/**
 * 売上サポの行（資料の文字層・画像で分析の間取り図）。同じ物件名・号室の一番新しい行。
 * 2026-09-29 反証: 資料の古さに上限（PICKUP_MATERIAL_MAX_DAYS）。号室が無い時に別の部屋の資料を使うかは呼び出し側（pickupMaterialUsable）で決める
 */
async function loadPickupMaterial(name: string, roomNo: string | null): Promise<{ pdfText: string | null; plan: PlanFactsLite } | null> {
  const { data, error } = await supabase.from("property_pickups").select("room_no, pdf_text, image_analysis, created_at")
    .eq("property_name", name).gte("created_at", new Date(Date.now() - PICKUP_MATERIAL_MAX_DAYS * 86_400_000).toISOString())
    .order("created_at", { ascending: false }).limit(10);
  if (error || !data?.length) return null;
  const rn = roomNorm(roomNo);
  const row = (data as Array<{ room_no: string | null; pdf_text: string | null; image_analysis: Record<string, unknown> | null }>)
    .find((r) => !rn || roomNorm(r.room_no) === rn);
  if (!row) return null;
  let plan: PlanFactsLite = null;
  const factsId = (row.image_analysis?.sheet as { facts_id?: number } | undefined)?.facts_id;
  if (factsId) {
    const { data: f } = await supabase.from(FACTS_TABLE).select("image_facts").eq("id", factsId).limit(1);
    plan = (f?.[0]?.image_facts ?? null) as PlanFactsLite;
  }
  return { pdfText: row.pdf_text, plan };
}

export type EquipmentAnswerMaterial = {
  question: EquipmentQuestion; plan: EquipAnswerPlan; note: string;
  /** どこから読んだか（監査・ログ用）: pdf＝文字層・image_saved／image_read＝画像から写した設備欄・none＝読めない */
  sources: Array<{ name: string; roomNo: string | null; source: "pdf" | "image_saved" | "image_read" | "none"; ms: number }>;
};

/**
 * 今回のお客様の文が設備の質問なら、対象の物件（決定論）と資料から答えの材料を作る。質問でない・送った物件が無ければ null。
 * askedAt＝お客様の発言の時刻（それより前に送った物件だけ見る）。
 */
export async function loadEquipmentAnswer(o: {
  conversationId: string; customerText: string; askedAt?: string | null; timeoutMs?: number;
}): Promise<EquipmentAnswerMaterial | null> {
  const question = detectEquipmentQuestion(o.customerText);
  if (!question) return null;
  // お客様の最新の発言（時刻＝それより前に送った物件だけ見る・引用返信＝LINE の quoted_message_id → 引用先の line_message_id）
  const { data: lastCust } = await supabase.from("messages").select("created_at, quoted_message_id")
    .eq("conversation_id", o.conversationId).eq("sender", "customer").order("created_at", { ascending: false }).limit(1);
  const askedAt = o.askedAt ?? (lastCust?.[0]?.created_at as string | undefined) ?? new Date().toISOString();
  const quotedLineId = o.askedAt ? null : ((lastCust?.[0]?.quoted_message_id as string | null | undefined) ?? null);
  const { data: sent, error } = await supabase.from("sent_image_properties")
    .select("property_name, room_no, channel, created_at, image_url")
    .eq("conversation_id", o.conversationId).order("created_at", { ascending: false }).limit(40);
  if (error) { console.warn("[equipment-answer] 送った物件を引けない:", error.message); return null; }
  let quotedImageUrl: string | null = null;
  if (quotedLineId) {
    const { data: q } = await supabase.from("messages").select("image_url").eq("conversation_id", o.conversationId).eq("line_message_id", quotedLineId).limit(1);
    quotedImageUrl = (q?.[0]?.image_url as string | null) ?? null;
  }
  // 2026-09-29 反証: 直前の送付より後にお客様が画像を送っていれば、お客様が見つけた物件の話かもしれない（latest に倒さない）
  const { data: custImgs } = await supabase.from("messages").select("created_at")
    .eq("conversation_id", o.conversationId).eq("sender", "customer").not("image_url", "is", null)
    .lte("created_at", askedAt).gte("created_at", new Date(Date.parse(askedAt) - 14 * 86_400_000).toISOString())
    .order("created_at", { ascending: false }).limit(20);
  const customerImageAts = ((custImgs ?? []) as Array<{ created_at: string }>).map((r) => r.created_at);
  const targets = pickEquipmentTargets(o.customerText, (sent ?? []) as SentPropertyLite[], { askedAt, quotedImageUrl, customerImageAts });
  if (!targets.length) return null;
  const sources: EquipmentAnswerMaterial["sources"] = [];
  const properties: EquipPropertyAnswer[] = await Promise.all(targets.map(async (t) => {
    const t0 = Date.now();
    const pk = pickupMaterialUsable(question.topics, t.room_no) ? await loadPickupMaterial(t.property_name, t.room_no).catch(() => null) : null;
    const eq = pk?.pdfText ? parseListingEquipment(pk.pdfText) : null;
    // 2026-09-29 反証: 文字層の「〇〇なし」を有ると読む穴（採点側は別の話）→ 質問に答える時だけ安全側に下げる
    let text: Partial<Record<EquipKey, EquipFact>> | null = eq?.hasText ? downgradeNegatedItems(eq.items, pk?.pdfText) : null;
    let textLabel = "資料の設備欄";
    let src: EquipmentAnswerMaterial["sources"][number]["source"] = text ? "pdf" : "none";
    if (!text && t.image_url) {
      const r = await readSheetEquipText(t.image_url, { conversationId: o.conversationId, timeoutMs: o.timeoutMs });
      text = textItemsFromSheetText(r.facts);
      textLabel = "資料の画像の設備欄";
      src = r.source === "saved" ? "image_saved" : r.source === "read" ? "image_read" : "none";
    }
    sources.push({ name: t.property_name, roomNo: t.room_no, source: src, ms: Date.now() - t0 });
    const answers = question.topics.map((topic) => resolveEquipAnswer(topic, { text, textLabel, plan: pk?.plan ?? null }));
    return { name: t.property_name, roomNo: t.room_no, by: t.by, answers, materialRead: !!text };
  }));
  const plan = equipAnswerPlan(properties);
  return { question, plan, note: buildEquipmentAnswerNote(plan), sources };
}

/** 時間の枠つき（返信生成・ブレインは待ちすぎない）。枠を過ぎたら null＝今まで通り */
export async function loadEquipmentAnswerWithin(ms: number, o: Parameters<typeof loadEquipmentAnswer>[0]): Promise<EquipmentAnswerMaterial | null> {
  if (!detectEquipmentQuestion(o.customerText)) return null; // 質問でなければ DB も引かない
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      loadEquipmentAnswer({ ...o, timeoutMs: Math.max(5_000, ms - 2_000) }),
      new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); }),
    ]);
  } catch (e) {
    console.warn("[equipment-answer] 失敗:", o.conversationId, e instanceof Error ? e.message : e);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}
