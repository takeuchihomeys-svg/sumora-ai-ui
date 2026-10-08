// app/lib/contract-terms-answer-server.ts（サーバー専用・DB。画面側から import しない）
// お客様が送った物件の契約条件（礼金・敷金・フリーレント・保証会社・保証人・入居時期／退去予定・駐車場・管理会社）を聞いた時に、
// 対象の物件（equipment-question.pickEquipmentTargets と同じ決め方）の資料の該当の所だけ読んで、答え方の材料を作る。
// 決まり（どの項目か・本文で答えるか AIX【確認した】か）は純関数 contract-terms-question.ts に1つ。
//
// 2026-10-08 竹内（8巡目）「資料に書いてある事は返信の本文で答えて良い」。新しい LLM 呼び出しは無い（保存済みの資料を読むだけ）。
//   資料の出所（号室が合う物だけ。号室が無い時は建物単位の項目＝駐車場・管理会社だけ）:
//     ① 売上サポの行（property_pickups: terms・image_lines・pdf_text・60日以内）
//     ② この会話で送った画像の読み取り（image_details.lines）
//   質問でなければ DB も引かない。失敗・時間切れは null（呼び出し側は今まで通り）。戻す CONTRACT_TERMS_ANSWER=off
import { supabase } from "@/app/lib/supabase";
import { pickEquipmentTargets, type SentPropertyLite } from "@/app/lib/equipment-question";
import { collectStaffFreeRent, staffFreeRentFor, type StaffFreeRentFact } from "@/app/lib/staff-free-rent";
import {
  detectContractTermTopics, routeContractTerm, buildContractTermsNote, contractTermsAllInMaterial,
  type ContractTermTopic, type ContractRoute, type ContractMaterial, type ContractTarget,
} from "@/app/lib/contract-terms-question";

const PICKUP_MAX_DAYS = 60;
const BUILDING_TOPICS: ReadonlySet<ContractTermTopic> = new Set(["parking", "management_company"]);
const roomNorm = (r: string | null | undefined) => String(r ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+/, "").trim();

export type ContractTermsMaterial = {
  topics: ContractTermTopic[];
  target: ContractTarget;
  routes: ContractRoute[];
  allInMaterial: boolean;
  note: string;
  /** どこから読んだか（監査・ログ用） */
  source: "pickup" | "image_details" | "both" | "none";
};

export function contractTermsAnswerEnabled(): boolean {
  return process.env.CONTRACT_TERMS_ANSWER !== "off";
}

/** 対象の物件の資料（売上サポの行＋送った画像の読み取り） */
export async function loadContractMaterial(o: { conversationId: string; name: string; roomNo: string | null; imageUrl?: string | null }): Promise<{ material: ContractMaterial; source: ContractTermsMaterial["source"] }> {
  const rn = roomNorm(o.roomNo);
  const { data: picks } = await supabase.from("property_pickups")
    .select("room_no, pdf_text, image_lines, terms, created_at")
    .eq("property_name", o.name).gte("created_at", new Date(Date.now() - PICKUP_MAX_DAYS * 86_400_000).toISOString())
    .order("created_at", { ascending: false }).limit(10);
  const pick = ((picks ?? []) as Array<{ room_no: string | null; pdf_text: string | null; image_lines: string[] | null; terms: ContractMaterial["terms"] }>)
    .find((r) => (rn ? roomNorm(r.room_no) === rn : true));
  let detLines: string[] = [];
  if (o.imageUrl) {
    const { data: det } = await supabase.from("image_details").select("lines, kind, read_at").eq("image_url", o.imageUrl).order("read_at", { ascending: false }).limit(3);
    const row = ((det ?? []) as Array<{ kind: string | null; lines: string[] | null }>).find((d) => d.kind === "property" && (d.lines ?? []).length > 0);
    detLines = (row?.lines ?? []).map((l) => String(l));
  }
  const lines = [...(pick?.image_lines ?? []), ...detLines.filter((l) => !(pick?.image_lines ?? []).includes(l))];
  const source: ContractTermsMaterial["source"] = pick && detLines.length ? "both" : pick ? "pickup" : detLines.length ? "image_details" : "none";
  return { material: { terms: pick?.terms ?? null, lines, pdfText: pick?.pdf_text ?? null }, source };
}

/**
 * この会話でスタッフが送った文のフリーレントの事実（期間を問わず・新しい方 200通まで）。
 * 2026-10-08 竹内「スタッフが AIX で入れていたらフリーレント…その物件はフリーレントと保管」＝保管はこちらが送った文そのもの（過去の送付も同じ関数で拾える）
 */
export async function loadStaffFreeRentFacts(conversationId: string): Promise<StaffFreeRentFact[]> {
  const { data, error } = await supabase.from("messages").select("text, created_at").eq("conversation_id", conversationId).eq("sender", "staff")
    .ilike("text", "%フリーレント%").order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return collectStaffFreeRent(((data ?? []) as Array<{ text: string | null; created_at: string }>).reverse().map((m) => ({ text: m.text, createdAt: m.created_at })));
}

/** 対象の物件を決める時に「知らない建物の名前」と読まれないよう、項目の語を外す（フリーレント・オーナー 等のカタカナ） */
const TOPIC_WORDS_RE = /フリーレント|オーナー|バイク|パーキング|オートバイ|ナンバー/g;

/**
 * 今回のお客様の文が契約条件の質問なら、対象の物件と資料から答えの材料を作る。質問でない・物件が決まらなければ null。
 * askedAt＝お客様の発言の時刻（それより前に送った物件だけ見る）。
 */
export async function loadContractTermsAnswer(o: {
  conversationId: string; customerText: string; askedAt?: string | null;
  /** 物件を決めてある時（ブレインの主のお部屋）。無ければ送った物件から決める */
  target?: { name: string; roomNo: string | null } | null;
  /** 他の材料が受け持つ項目（手続きの質問が入居時期を答える時は move_in・確認した系が受け持つ物） */
  excludeTopics?: ReadonlyArray<ContractTermTopic>;
}): Promise<ContractTermsMaterial | null> {
  if (!contractTermsAnswerEnabled()) return null;
  const topics = detectContractTermTopics(o.customerText).filter((t) => !(o.excludeTopics ?? []).includes(t));
  if (!topics.length) return null;
  const { data: lastCust } = await supabase.from("messages").select("created_at, quoted_message_id")
    .eq("conversation_id", o.conversationId).eq("sender", "customer").order("created_at", { ascending: false }).limit(1);
  const askedAt = o.askedAt ?? (lastCust?.[0]?.created_at as string | undefined) ?? new Date().toISOString();
  const { data: sent } = await supabase.from("sent_image_properties")
    .select("property_name, room_no, channel, created_at, image_url")
    .eq("conversation_id", o.conversationId).order("created_at", { ascending: false }).limit(40);
  const sentRows = (sent ?? []) as SentPropertyLite[];
  let target: { name: string; roomNo: string | null; imageUrl: string | null } | null = null;
  const quotedLineId = o.askedAt ? null : ((lastCust?.[0]?.quoted_message_id as string | null | undefined) ?? null);
  let quotedImageUrl: string | null = null;
  if (quotedLineId) {
    const { data: q } = await supabase.from("messages").select("image_url").eq("conversation_id", o.conversationId).eq("line_message_id", quotedLineId).limit(1);
    quotedImageUrl = (q?.[0]?.image_url as string | null) ?? null;
  }
  const { data: custImgs } = await supabase.from("messages").select("created_at")
    .eq("conversation_id", o.conversationId).eq("sender", "customer").not("image_url", "is", null)
    .lte("created_at", askedAt).gte("created_at", new Date(Date.parse(askedAt) - 14 * 86_400_000).toISOString())
    .order("created_at", { ascending: false }).limit(20);
  const picked = pickEquipmentTargets(o.customerText.replace(TOPIC_WORDS_RE, " "), sentRows, {
    askedAt, quotedImageUrl, max: 1, customerImageAts: ((custImgs ?? []) as Array<{ created_at: string }>).map((r) => r.created_at),
  });
  // 物件ごとの台帳（property-thread）が今の番の物件を1つに決めている時はそれを先に使う（引用・名指し・「最初に送った物件」等の推定。
  //   YUMA の持ち込みの場面で、直前の送付に倒すと「最初に送った物件」のフリーレントを別の物件で答えた＝記録の担当の指摘・10/08）
  try {
    const { loadPropertyThreads } = await import("@/app/lib/property-thread-server");
    const pt = await Promise.race([loadPropertyThreads(o.conversationId), new Promise<null>((r) => setTimeout(() => r(null), 5_000))]);
    const keys = [...new Set((pt?.turnTargets ?? []).map((t) => t.roomKey))];
    const room = keys.length === 1 ? pt?.rooms.find((r) => r.key === keys[0]) ?? null : null;
    if (room?.ref.building) {
      const sentHit = sentRows.find((s) => room.names.includes(s.property_name) || s.property_name === room.ref.building);
      target = { name: sentHit?.property_name ?? room.ref.building, roomNo: room.ref.room ?? sentHit?.room_no ?? null, imageUrl: sentHit?.image_url ?? null };
    }
  } catch { /* 台帳が読めなければ今まで通り */ }
  if (!target && picked.length) target = { name: picked[0].property_name, roomNo: picked[0].room_no ?? null, imageUrl: picked[0].image_url ?? null };
  else if (!target && o.target) target = { name: o.target.name, roomNo: o.target.roomNo, imageUrl: null };
  if (!target) return null;
  // 号室が分からない物件は建物単位の項目だけ（同じ建物の別の部屋の礼金・入居時期を答えない）
  const usable = target.roomNo ? topics : topics.filter((t) => BUILDING_TOPICS.has(t));
  if (!usable.length) return null;
  const { material, source } = await loadContractMaterial({ conversationId: o.conversationId, name: target.name, roomNo: target.roomNo, imageUrl: target.imageUrl });
  // フリーレントは資料から読まず、この会話でスタッフが送った文だけ（期間を問わず・staff-free-rent.ts）
  if (usable.includes("free_rent")) {
    const facts = await loadStaffFreeRentFacts(o.conversationId).catch(() => []);
    material.staffFreeRent = staffFreeRentFor(facts, target.name, target.roomNo);
  }
  const routes = usable.map((t) => routeContractTerm(t, material, { questionText: o.customerText }));
  const t: ContractTarget = { name: target.name, roomNo: target.roomNo };
  return { topics: usable, target: t, routes, allInMaterial: contractTermsAllInMaterial(routes), note: buildContractTermsNote(t, routes), source };
}

/** 時間の枠つき（返信生成・ブレインは待ちすぎない）。枠を過ぎたら null＝今まで通り */
export async function loadContractTermsAnswerWithin(ms: number, o: Parameters<typeof loadContractTermsAnswer>[0]): Promise<ContractTermsMaterial | null> {
  if (!contractTermsAnswerEnabled() || !detectContractTermTopics(o.customerText).filter((t) => !(o.excludeTopics ?? []).includes(t)).length) return null; // 質問でなければ DB も引かない
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      loadContractTermsAnswer(o),
      new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); }),
    ]);
  } catch (e) {
    console.warn("[contract-terms] 失敗:", o.conversationId, e instanceof Error ? e.message : e);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}
