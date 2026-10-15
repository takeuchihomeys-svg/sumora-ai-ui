// app/lib/material-answer-server.ts（サーバー専用・DB・DeepSeek。画面側から import しない）
// お客様の質問が物件資料に書いてある事（間取り・水回りの配置・広さ・階・向き・収納・キッチン）の時に、物件検索ブレインの読み取りから材料を作る。
//   網と文は純関数 material-question.ts。ここは「どの物件の・どの読み取りを引くか」と「まだ読めていなければその場で図を読む」だけ。
//
// 引く順（安い順）:
//   ① 送った資料の書き写し（image_details.lines・send-line-message が送った時に読んだ物）
//   ② 売上サポの行の読み取り（property_pickups.image_analysis.sheet.facts_id → property_sheet_facts の間取り図の読み・設備欄）
//   ③ 保存したその場の読み（property_sheet_facts・unit_key='mplan|<画像URLの sha1>'・prompt_version=MATERIAL_PLAN_PROMPT_VERSION）
//   ④ 図を見ないと分からない話題（PLAN_READ_TOPICS）で③が無ければ、その物件の送った資料の画像を DeepSeek で1回読む（保存して使い回す）
// ⚠ 読むのはこちらが送った物件の資料の画像だけ（sent_image_properties の画像・image_details の kind が property か未読）。
//   お客様の画像・本人確認書類は絶対に回さない（設計知見「別クラウドに出してよいのは物件資料だけ」）。漢字は日本の字形に直してから使う（P0 89bc2c3e）。
import { createHash } from "node:crypto";
import { supabase } from "@/app/lib/supabase";
import { callDeepSeekRead } from "@/app/lib/vision-alt-provider";
import { pickEquipmentTargets, type SentPropertyLite, type EquipTarget } from "@/app/lib/equipment-question";
import {
  detectMaterialQuestion, buildMaterialAnswerNote, parseMaterialPlanRead, planReadLines, materialAnswerEnabled, materialAnswerReadEnabled,
  PLAN_READ_TOPICS, MATERIAL_PLAN_PROMPT, MATERIAL_PLAN_PROMPT_VERSION, MATERIAL_PLAN_MAX_TOKENS,
  type MaterialQuestion, type MaterialPropertyFacts, type MaterialPlanRead,
} from "@/app/lib/material-question";
import { fixChineseGlyphs } from "@/app/lib/japanese-glyph";
import { brainNameMatchesAny } from "@/app/lib/property-name-loose";
import { REALPRO_SLOTS } from "@/app/lib/sheet-layout";
import { loadSentBundles } from "@/app/lib/sent-bundles-server";
import { bundleOfQuoted, type SentBundle } from "@/app/lib/sent-bundles";

const FACTS_TABLE = "property_sheet_facts";
const MAX_DAYS = 60;

export type MaterialAnswer = {
  question: MaterialQuestion; note: string; properties: MaterialPropertyFacts[];
  /** 監査・ログ: 物件ごとにどこから読んだか・その場で読んだか */
  log: Array<{ name: string; sources: string[]; readMs: number | null }>;
};

const roomNorm = (r: string | null | undefined) => String(r ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+/, "").trim();
const glyph = (s: string) => fixChineseGlyphs(s).text;

type SheetFactsRow = { image_facts: Record<string, any> | null; text_facts: Record<string, any> | null };

/** 売上サポの行の読み取り（同じ物件名・号室。号室が無い時は行が1つだけの時） */
async function pickupSheetLines(name: string, roomNo: string | null): Promise<string[]> {
  const { data } = await supabase.from("property_pickups").select("room_no, image_analysis, created_at")
    .eq("property_name", name).gte("created_at", new Date(Date.now() - MAX_DAYS * 86_400_000).toISOString())
    .order("created_at", { ascending: false }).limit(10);
  const rows = (data ?? []) as Array<{ room_no: string | null; image_analysis: Record<string, any> | null }>;
  if (!rows.length) return [];
  const rn = roomNorm(roomNo);
  const row = rn ? rows.find((r) => roomNorm(r.room_no) === rn) : new Set(rows.map((r) => roomNorm(r.room_no))).size === 1 ? rows[0] : null;
  const factsId = row?.image_analysis?.sheet?.facts_id;
  if (!factsId) return [];
  const { data: f } = await supabase.from(FACTS_TABLE).select("image_facts, text_facts").eq("id", factsId).limit(1);
  const r = (f?.[0] ?? null) as SheetFactsRow | null;
  if (!r) return [];
  const L: string[] = [];
  const img = r.image_facts ?? {};
  const w = img.water ?? {};
  const water: string[] = [];
  if (w.bath_toilet === "別") water.push("浴室とトイレは別"); else if (w.bath_toilet === "同室") water.push("浴室とトイレは同じ空間");
  if (w.washbasin === "独立") water.push("洗面台は独立"); else if (w.washbasin === "浴室内") water.push("洗面台は浴室の中");
  if (w.laundry && w.laundry !== "不明") water.push(`洗濯機置場は${w.laundry}`);
  if (water.length) L.push(`水回り（売上サポの間取り図の読み）: ${water.join("・")}`);
  const rooms = Array.isArray(img.rooms) ? img.rooms.filter((x: any) => x?.jo != null).map((x: any) => `${x.name}${x.jo}帖`) : [];
  const t = r.text_facts ?? {};
  const lay = [t.madori || img.madori, rooms.join("・"), t.areaSqm ? `${t.areaSqm}㎡` : img.area_sqm ? `${img.area_sqm}㎡` : ""].filter(Boolean);
  if (lay.length) L.push(`間取り（売上サポの資料）: ${lay.join("・")}`);
  if (t.floor) L.push(`階（売上サポの資料）: ${t.floor}階`);
  if (t.direction) L.push(`向き（売上サポの資料）: ${t.direction}`);
  if (img.kitchen?.placement && img.kitchen.placement !== "不明") L.push(`キッチン（間取り図の読み）: ${img.kitchen.placement}`);
  if (typeof t.features === "string" && t.features.trim()) L.push(`設備欄（売上サポの資料）: ${t.features.replace(/\s+/g, " ").slice(0, 260)}`);
  return L.map(glyph);
}

/**
 * 読ませる画像: 資料の1ページ全体＋（横長の資料＝リアプロの形の時）間取り図の枠と室内写真の枠を2倍に拡大した切り出し。
 *   1ページ全体のままだと間取り図が小さく、水回りの並び（洗面台がトイレと同じ空間か）が読めない（055d4212 の資料で「独立した洗面所」と読んだ）。
 *   切り出せない時は1ページ全体だけ（今まで通り）
 */
async function planReadContent(imageUrl: string): Promise<Array<Record<string, unknown>>> {
  const base: Array<Record<string, unknown>> = [{ type: "text", text: MATERIAL_PLAN_PROMPT }, { type: "image_url", image_url: { url: imageUrl } }];
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return base;
    const buf = Buffer.from(await res.arrayBuffer());
    const { loadImageCanvas, cropCanvas } = await import("@/app/lib/pdf-sheet-crop");
    const canvas = await loadImageCanvas(buf);
    if (!canvas || canvas.width <= canvas.height * 1.2) return base;   // 横長（リアプロの形）だけ
    const floor = await cropCanvas(canvas, REALPRO_SLOTS.floor, { maxScale: 3 });
    const photos = await cropCanvas(canvas, REALPRO_SLOTS.photos, { maxScale: 2 });
    const toUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString("base64")}`;
    const out = [...base];
    if (floor) out.push({ type: "text", text: "↓ 上の資料の間取り図の部分を拡大した物（水回りの並び・帖数はここで読む）" }, { type: "image_url", image_url: { url: toUrl(floor.jpeg) } });
    if (photos) out.push({ type: "text", text: "↓ 上の資料の室内写真の部分を拡大した物（洗面台・トイレ・浴室が同じ空間に写っているかの確かめに使う。写真だけで有無を決めない）" }, { type: "image_url", image_url: { url: toUrl(photos.jpeg) } });
    return out;
  } catch { return base; }
}

/** その場の図の読み（保存した物を先に・無ければ DeepSeek で1回） */
export async function readMaterialPlan(imageUrl: string, o: { conversationId: string; timeoutMs: number; allowRead: boolean }): Promise<{ read: MaterialPlanRead | null; source: "saved" | "read" | "none"; ms: number }> {
  const t0 = Date.now();
  if (!/^https?:\/\//.test(imageUrl)) return { read: null, source: "none", ms: 0 };
  const unitKey = `mplan|${createHash("sha1").update(imageUrl).digest("hex")}`;
  const { data: saved } = await supabase.from(FACTS_TABLE).select("text_facts").eq("unit_key", unitKey).eq("prompt_version", MATERIAL_PLAN_PROMPT_VERSION).limit(1);
  const hit = (saved?.[0]?.text_facts ?? null) as MaterialPlanRead | null;
  if (hit && typeof hit === "object" && "bath_toilet" in hit) return { read: hit, source: "saved", ms: Date.now() - t0 };
  if (!o.allowRead) return { read: null, source: "none", ms: Date.now() - t0 };
  const content = await planReadContent(imageUrl);
  const budget = o.timeoutMs;
  const res = await callDeepSeekRead(null, content, { maxTokens: MATERIAL_PLAN_MAX_TOKENS, timeoutMs: budget }, (t) => parseMaterialPlanRead(t, glyph),
    { retryIf: (elapsed) => budget - elapsed >= 3_000, retryTimeoutMs: (elapsed) => budget - elapsed });
  void import("./llm-usage-recorder").then(({ recordAltUsage }) => {
    for (const a of res.attempts) {
      recordAltUsage({
        model: a.res?.model ?? "deepseek", action: "material_plan_read", conversationId: o.conversationId,
        usage: { input_tokens: a.res?.usage.cacheMiss ?? 0, output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
        status: a.res ? 200 : 0, errorType: a.ok ? null : a.res ? "empty_or_unparsable" : "no_response",
        durationMs: a.ms, sysHead: (a.retry ? "【読み直し】" : "") + MATERIAL_PLAN_PROMPT.slice(0, 180), sysKeyFull: null, maxTokens: MATERIAL_PLAN_MAX_TOKENS,
      });
    }
  }).catch(() => {});
  const read = res.value;
  if (!read) return { read: null, source: "none", ms: Date.now() - t0 };
  if ((process.env.MATERIAL_ANSWER_NO_SAVE ?? "") !== "1") {
    const { error } = await supabase.from(FACTS_TABLE).upsert({
      unit_key: unitKey, site: null, sheet_type: "material_plan", crop_mode: "page", crop_basis: null,
      image_facts: null, text_facts: read, model: res.res?.model ?? null, prompt_version: MATERIAL_PLAN_PROMPT_VERSION, updated_at: new Date().toISOString(),
    }, { onConflict: "unit_key,prompt_version" });
    if (error) console.warn("[material-answer] 読み取りを保存できない:", error.message);
  }
  return { read, source: "read", ms: Date.now() - t0 };
}

/**
 * 今回のお客様の文が資料に書いてある事の質問（網）なら、対象の物件と読み取りから材料を作る。当たらない・物件が無ければ null。
 * target＝ブレイン側の主のお部屋（customer-state の focus）。送った物件の中で名前が合えばそれを先に使う。
 */
export async function loadMaterialAnswer(o: {
  conversationId: string; customerText: string; askedAt?: string | null; timeoutMs?: number;
  target?: { name: string; roomNo: string | null } | null;
}): Promise<MaterialAnswer | null> {
  if (!materialAnswerEnabled()) return null;
  const question = detectMaterialQuestion(o.customerText);
  if (!question) return null;
  const { data: lastCust } = await supabase.from("messages").select("created_at, quoted_message_id")
    .eq("conversation_id", o.conversationId).eq("sender", "customer").order("created_at", { ascending: false }).limit(1);
  const askedAt = o.askedAt ?? (lastCust?.[0]?.created_at as string | undefined) ?? new Date().toISOString();
  const quotedLineId = o.askedAt ? null : ((lastCust?.[0]?.quoted_message_id as string | null | undefined) ?? null);
  const { data: sent } = await supabase.from("sent_image_properties")
    .select("property_name, room_no, channel, created_at, image_url")
    .eq("conversation_id", o.conversationId).lte("created_at", askedAt).order("created_at", { ascending: false }).limit(40);
  const sentRows = (sent ?? []) as SentPropertyLite[];
  let quotedImageUrl: string | null = null;
  if (quotedLineId) {
    const { data: q } = await supabase.from("messages").select("image_url").eq("conversation_id", o.conversationId).eq("line_message_id", quotedLineId).limit(1);
    quotedImageUrl = (q?.[0]?.image_url as string | null) ?? null;
  }
  const { data: custImgs } = await supabase.from("messages").select("created_at")
    .eq("conversation_id", o.conversationId).eq("sender", "customer").not("image_url", "is", null)
    .lte("created_at", askedAt).gte("created_at", new Date(Date.parse(askedAt) - 14 * 86_400_000).toISOString()).limit(20);
  // 対象: 送った物件（名前・引用・直前の送付＝equipment と同じ決まり）を先に、主のお部屋（ブレイン側の focus）が別ならそれも並べる（どちらの話かはブレインが決める）
  //   YUMA の再生（055d4212）で、主のお部屋が前の別の物件のまま「ここって〜」の直前の送付と食い違った
  let targets: Array<Pick<EquipTarget, "property_name" | "room_no" | "by">> = pickEquipmentTargets(o.customerText, sentRows, { askedAt, quotedImageUrl, customerImageAts: ((custImgs ?? []) as Array<{ created_at: string }>).map((r) => r.created_at), max: 2 });
  // 2026-10-15 軸の直し③（送った束・未桜さん 22b2511e 10/09）: 引用した通が画像でない（室内イメージの URL・🌟の文）時も、その通が入っている AIX の束の物件を先に
  //   （束は文の物件名と画像の読みの名前が合う物だけ・sent-bundles.ts）。戻す SENT_BUNDLES=off
  let quotedBundle: SentBundle | null = null;
  if (quotedLineId && !quotedImageUrl) {
    const bundles = await loadSentBundles(o.conversationId, { untilIso: askedAt }).catch(() => [] as SentBundle[]);
    quotedBundle = bundleOfQuoted(bundles, quotedLineId);
    if (quotedBundle) {
      const qb = quotedBundle;
      targets = [{ property_name: qb.property, room_no: null, by: "quote" as EquipTarget["by"] }, ...targets.filter((t) => !brainNameMatchesAny(qb.property, [t.property_name]))];
      for (const im of qb.images) if (!sentRows.some((r) => r.image_url === im.url)) sentRows.push({ property_name: qb.property, room_no: null, channel: "aix", created_at: qb.sentAt, image_url: im.url } as SentPropertyLite);
      console.log(JSON.stringify({ tag: "material-answer:quoted-bundle", conversationId: o.conversationId, property: qb.property, images: qb.images.length, urls: qb.urls.length }));
    }
  }
  if (o.target?.name && !targets.some((t) => brainNameMatchesAny(o.target!.name, [t.property_name]))) {
    const same = sentRows.find((r) => brainNameMatchesAny(o.target!.name, [r.property_name]));
    targets = [...targets, { property_name: same?.property_name ?? o.target.name, room_no: o.target.roomNo ?? same?.room_no ?? null, by: "brain_focus" as EquipTarget["by"] }];
  }
  if (!targets.length) return null;
  const budget = Math.max(4_000, (o.timeoutMs ?? 10_000) - 1_500);
  const log: MaterialAnswer["log"] = [];
  const properties: MaterialPropertyFacts[] = await Promise.all(targets.slice(0, 3).map(async (t) => {
    const sources: string[] = [];
    const urls = [...new Set(sentRows.filter((r) => r.image_url && brainNameMatchesAny(t.property_name, [r.property_name])).map((r) => r.image_url as string))].slice(0, 3);
    let textLines: string[] = [];
    let kinds = new Map<string, string>();
    if (urls.length) {
      const { data: det } = await supabase.from("image_details").select("image_url, kind, lines").in("image_url", urls);
      kinds = new Map(((det ?? []) as Array<{ image_url: string; kind: string }>).map((d) => [d.image_url, d.kind]));
      for (const u of urls) {
        const d = ((det ?? []) as Array<{ image_url: string; kind: string; lines: string[] | null }>).find((x) => x.image_url === u);
        if (d?.kind === "property" && Array.isArray(d.lines) && d.lines.length) { textLines = d.lines.map((l) => glyph(String(l))).slice(0, 12); sources.push("image_details"); break; }
      }
    }
    const pk = await pickupSheetLines(t.property_name, t.room_no).catch(() => [] as string[]);
    if (pk.length) sources.push("pickup_sheet");
    let planLines: string[] = [];
    let readMs: number | null = null;
    const needPlan = question.topics.some((x) => PLAN_READ_TOPICS.has(x));
    // 図を読む画像: 書き写しで物件の資料と分かっている画像 → 未読の画像（kind が property 以外＝見積書・室内写真等は読まない）
    const planUrl = urls.find((u) => kinds.get(u) === "property") ?? urls.find((u) => !kinds.has(u)) ?? null;
    if (needPlan && planUrl) {
      const r = await readMaterialPlan(planUrl, { conversationId: o.conversationId, timeoutMs: budget, allowRead: materialAnswerReadEnabled() }).catch(() => ({ read: null, source: "none" as const, ms: 0 }));
      if (r.read) { planLines = planReadLines(r.read); sources.push(r.source === "saved" ? "plan_saved" : "plan_read"); }
      readMs = r.source === "read" ? r.ms : null;
    }
    log.push({ name: t.property_name, sources, readMs });
    return { name: t.property_name, roomNo: t.room_no, by: t.by === ("brain_focus" as EquipTarget["by"]) ? "ブレインの主のお部屋" : t.by === "name" ? "お客様が名前を出した物件" : t.by === "quote" ? "引用した資料" : "直前に送った物件", textLines: [...textLines, ...pk], planLines, sources };
  }));
  const note = buildMaterialAnswerNote(question, properties);
  return note ? { question, note, properties, log } : null;
}

/** 時間の枠つき（返信生成・ブレインは待ちすぎない）。枠を過ぎたら null＝今まで通り */
export async function loadMaterialAnswerWithin(ms: number, o: Parameters<typeof loadMaterialAnswer>[0]): Promise<MaterialAnswer | null> {
  if (!materialAnswerEnabled() || !detectMaterialQuestion(o.customerText)) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      loadMaterialAnswer({ ...o, timeoutMs: ms }),
      new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); }),
    ]);
  } catch (e) {
    console.warn("[material-answer] 失敗:", o.conversationId, e instanceof Error ? e.message : e);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}
