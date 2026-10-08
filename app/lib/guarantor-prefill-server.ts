// app/lib/guarantor-prefill-server.ts（サーバー専用・DB。画面側から import しない＝画面は /api/aix/guarantor-prefill を呼ぶ）
// AIX【保証会社について】を開いた時の先入れ: 会話から決めた物件（guarantor-target.ts）＋その物件の資料の保証会社（guarantor-material.ts）。
//
// 2026-10-06 竹内（松浦 麻夜 事例）「会話の流れからして送っている物件のことだと認識できるはず…資料に保証会社記載されているので、それも読みとる…
//   根本的な部分改善する必要がある」。新しい LLM 呼び出しは無い（保存済みの資料の文字・読み取り行を読むだけ）。
//   資料の出所（上から・号室まで合う物だけ・同じ建物の別の部屋の資料は使わない）:
//     ① この会話で送った画像の読み取り（sent_image_properties → image_details.lines）＝お客様が実際に見た資料
//     ② 売上サポの行（property_pickups: pdf_text の「保証会社」の見出し → 無ければ image_lines）。この会話・このお客様の行 → 無ければ全体（60日）
//   決まらない・読めない時は空＋理由（推測で入れない）
import { supabase } from "@/app/lib/supabase";
import { propertyLabelsForImages } from "@/app/lib/quoted-context";
import { resolveGuarantorTargets, type GuarantorTargetMsg, type GuarantorTargets } from "@/app/lib/guarantor-target";
import { guarantorFromMaterial, type MaterialGuarantorResult } from "@/app/lib/guarantor-material";
import { propertyKeyOf } from "@/app/lib/confirm-target-property";
import { normalizeGuarantorType, guarantorTypeSure, isMasterGuarantor, type GuarantorType } from "@/app/lib/guarantor-companies";
/** 先入れの種類: 分類表の会社は表で確かな種類だけ（確かでなければ空＝スタッフが選ぶ）・スタッフが登録した会社はその種類（10/08 竹内さん「独立系は確かな時だけ」） */
const prefillType = (c: { name: string; type: GuarantorType }): GuarantorType | "" => !isMasterGuarantor(c.name) ? c.type : (process.env.GUARANTOR_TYPE_SURE_ONLY === "off" ? c.type : (guarantorTypeSure(c.name).sure ? c.type : ""));

const PICKUP_MAX_DAYS = 60;

export type GuarantorPrefillCard = {
  /** 物件名（「H-maison大正VII 106号室」） */
  name: string;
  /** 資料の保証会社（1社だけ書いてある時だけ・それ以外は空） */
  company: string;
  type: GuarantorType | "";
  /** 資料に書かれた会社（2社以上の時の候補・画面に出す） */
  candidates: Array<{ name: string; type: GuarantorType }>;
  /** 資料のどこから（画面の「〜から自動」） */
  materialSource: "sent_image" | "pickup" | null;
  materialStatus: MaterialGuarantorResult["status"] | "no_material";
  /** 画面に出す一言（会社を入れた・入れなかった理由） */
  note: string;
  evidence: string | null;
};

export type GuarantorPrefill = {
  targets: GuarantorTargets;
  cards: GuarantorPrefillCard[];
};

type MsgRow = { id: string; line_message_id: string | null; sender: string; text: string | null; image_url: string | null; quoted_message_id: string | null; created_at: string };

/** その会話の直近の発言（古い順）。こちらの画像は送った物件の印「[画像: 〇〇 101号室の資料・御見積書]」に置き換える */
export async function loadGuarantorTargetMessages(conversationId: string, opts: { before?: string | null; limit?: number } = {}): Promise<GuarantorTargetMsg[]> {
  let q = supabase.from("messages").select("id, line_message_id, sender, text, image_url, quoted_message_id, created_at").eq("conversation_id", conversationId);
  if (opts.before) q = q.lte("created_at", opts.before);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(opts.limit ?? 80);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as MsgRow[]).reverse();
  const imgs = rows.filter((m) => m.sender !== "customer" && m.image_url).map((m) => m.image_url as string);
  const labels = imgs.length ? await propertyLabelsForImages(conversationId, imgs).catch(() => new Map<string, string>()) : new Map<string, string>();
  return rows.map((m) => {
    const label = m.sender !== "customer" && m.image_url ? labels.get(m.image_url) : undefined;
    // 引用返信の quoted_message_id は LINE の message id（messages.line_message_id）を指す
    return { id: m.line_message_id ?? m.id, sender: m.sender === "customer" ? "customer" : "staff", text: label ? `[画像: ${label}の資料・御見積書]` : m.text, createdAt: m.created_at, quotedId: m.quoted_message_id };
  });
}

const sameRoom = (a: string | null | undefined, b: string | null | undefined) => {
  const x = String(a ?? "").normalize("NFKC").replace(/号室?\s*$/, "").replace(/^0+(?=\d)/, "").trim();
  const y = String(b ?? "").normalize("NFKC").replace(/号室?\s*$/, "").replace(/^0+(?=\d)/, "").trim();
  return !!x && x === y;
};
const sameBuilding = (a: string | null | undefined, b: string | null | undefined) => {
  const x = propertyKeyOf(String(a ?? "")).base;
  const y = propertyKeyOf(String(b ?? "")).base;
  return x.length >= 2 && x === y;
};

/** 物件1件の資料の保証会社 */
export async function loadMaterialGuarantor(o: { conversationId: string; propertyCustomerId: string | null; label: string; customs?: ReadonlyArray<{ name: string; type: GuarantorType }> }): Promise<{ result: MaterialGuarantorResult; source: "sent_image" | "pickup" } | null> {
  // 「H-maison大正VII 106号室」「H-maison大正Ⅶ 106」（売上サポの渡し方は号室の字なし）
  const lm = o.label.normalize("NFKC").trim().match(/^(.*?)\s*([0-9]{1,4}[A-Za-z]?)\s*(?:号室|号)?$/);
  const building = (lm?.[1] ?? "").trim();
  const room = lm?.[2] ?? null;
  if (!room) return null;   // 号室が分からない物件は資料を結ばない（同じ建物の別の部屋の資料を使わない）
  const customs = o.customs ?? [];
  let fallback: { result: MaterialGuarantorResult; source: "sent_image" | "pickup" } | null = null;
  const consider = (r: MaterialGuarantorResult, source: "sent_image" | "pickup") => {
    if (r.status === "named" || r.status === "multiple") return { result: r, source };
    if (!fallback || (fallback.result.status === "none" && r.status === "unnamed")) fallback = { result: r, source };
    return null;
  };
  // ① この会話で送った画像の読み取り
  const { data: sent } = await supabase.from("sent_image_properties").select("property_name, room_no, image_url, created_at")
    .eq("conversation_id", o.conversationId).order("created_at", { ascending: false }).limit(200);
  const urls = ((sent ?? []) as Array<{ property_name: string | null; room_no: string | null; image_url: string | null }>)
    .filter((s) => s.image_url && sameBuilding(s.property_name, building) && sameRoom(s.room_no, room)).map((s) => s.image_url as string);
  if (urls.length) {
    const { data: det } = await supabase.from("image_details").select("image_url, kind, lines, read_at").in("image_url", urls).order("read_at", { ascending: false });
    for (const d of (det ?? []) as Array<{ kind: string | null; lines: string[] | null }>) {
      if (d.kind !== "property" || !(d.lines ?? []).length) continue;
      const hit = consider(guarantorFromMaterial({ lines: d.lines }, customs), "sent_image");
      if (hit) return hit;
    }
  }
  // ② 売上サポの行（この会話・このお客様 → 全体）
  const since = new Date(Date.now() - PICKUP_MAX_DAYS * 86_400_000).toISOString();
  const pickRows: Array<{ property_name: string | null; room_no: string | null; pdf_text: string | null; image_lines: string[] | null }> = [];
  {
    let q = supabase.from("property_pickups").select("property_name, room_no, pdf_text, image_lines, created_at").gte("created_at", since);
    q = o.propertyCustomerId ? q.or(`conversation_id.eq.${o.conversationId},property_customer_id.eq.${o.propertyCustomerId}`) : q.eq("conversation_id", o.conversationId);
    const { data } = await q.order("created_at", { ascending: false }).limit(300);
    pickRows.push(...((data ?? []) as typeof pickRows));
  }
  const tryRows = (rows: typeof pickRows) => {
    for (const r of rows) {
      if (!sameBuilding(r.property_name, building) || !sameRoom(r.room_no, room)) continue;
      const hit = consider(guarantorFromMaterial({ pdfText: r.pdf_text, lines: r.image_lines }, customs), "pickup");
      if (hit) return hit;
    }
    return null;
  };
  const own = tryRows(pickRows);
  if (own) return own;
  // 全体（同じ部屋の資料は他のお客様の行でも同じ物件の資料）: 建物名の頭の字で引いて正規化して比べる
  const head = building.normalize("NFKC").replace(/[\s　]+/g, "").slice(0, 4).replace(/[%_,()]/g, "");
  if (head.length >= 2) {
    const { data } = await supabase.from("property_pickups").select("property_name, room_no, pdf_text, image_lines, created_at")
      .gte("created_at", since).ilike("property_name", `${head}%`).order("created_at", { ascending: false }).limit(50);
    const all = tryRows((data ?? []) as typeof pickRows);
    if (all) return all;
  }
  return fallback;
}

/** 画面の一言（会社を入れた・入れなかった理由） */
export function guarantorCardNote(m: { result: MaterialGuarantorResult; source: "sent_image" | "pickup" } | null): string {
  if (!m) return "資料が見つからないので保証会社は空です（管理会社に確かめて入れてください）";
  const from = m.source === "sent_image" ? "送った資料" : "売上サポの資料";
  const r = m.result;
  if (r.status === "named") return `${from}から自動（${r.evidence[0]?.slice(0, 40) ?? ""}）・違えば直す`;
  if (r.status === "multiple") return `${from}に ${r.companies.length}社（${r.companies.map((c) => c.name).join("・")}）書かれているので選んでください`;
  if (r.status === "unnamed") return `${from}に会社名が無い（「${r.evidence[0]?.slice(0, 20) ?? "利用必須"}」だけ）ので空です・管理会社に確かめて入れてください`;
  return `${from}に保証会社の記載が無いので空です`;
}

/** AIX【保証会社について】の先入れ（物件＋資料の保証会社） */
export async function loadGuarantorPrefill(conversationId: string, opts: { before?: string | null; names?: string[] | null } = {}): Promise<GuarantorPrefill> {
  const [msgs, conv, customsRes] = await Promise.all([
    loadGuarantorTargetMessages(conversationId, { before: opts.before ?? null }),
    supabase.from("conversations").select("property_customer_id").eq("id", conversationId).maybeSingle(),
    supabase.from("guarantor_companies").select("name, type"),
  ]);
  const propertyCustomerId = (conv.data as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
  const customs = ((customsRes.data ?? []) as Array<{ name: string; type: string | null }>).map((c) => ({ name: c.name, type: normalizeGuarantorType(c.type) ?? "unknown" as GuarantorType }));
  // 売上サポで選んで渡した物件（スタッフが選んだ＝一番確か）があればそれを使い、会話から決めない
  const picked = (opts.names ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 10);
  const targets: GuarantorTargets = picked.length
    ? { names: picked, source: null, question: null, reason: "売上サポで選んだ物件" }
    : resolveGuarantorTargets(msgs);
  const cards: GuarantorPrefillCard[] = [];
  for (const name of targets.names) {
    const m = await loadMaterialGuarantor({ conversationId, propertyCustomerId, label: name, customs }).catch(() => null);
    const named = m?.result.status === "named" ? m.result.companies[0] : null;
    cards.push({
      name,
      company: named?.name ?? "",
      type: named ? prefillType(named) : "",
      candidates: m?.result.status === "multiple" ? m.result.companies.map((c) => ({ name: c.name, type: prefillType(c) || "unknown" as GuarantorType })) : [],
      materialSource: m?.source ?? null,
      materialStatus: m?.result.status ?? "no_material",
      note: guarantorCardNote(m),
      evidence: m?.result.evidence[0] ?? null,
    });
  }
  return { targets, cards };
}
