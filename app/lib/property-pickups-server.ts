// app/lib/property-pickups-server.ts
// merge-pdfs の後段で、1回分のピックアップを property_pickups に残す（PDF の文字層・判定・🌟・物件ごとの PDF）。
// 判定は property-brain（純関数）。行の作り方は property-pickups.ts（純関数）。ここは材料を引いて書くだけ。失敗しても投げない。
//
// 2026-09-24 竹内「ピックアップしたのを一度アプリの売上サポに飛ばして、DeepSeek が送る物件とオススメを判断して共有。
//   スタッフは確認してお客さんに送るだけ」「これはブレインモードで拡張ツールを行った時の限定機能」
//   → 呼ぶのは merge-pdfs で拡張の brain_mode=true の時だけ（通常・スタッフモードでは記録しない）
import { supabase } from "@/app/lib/supabase";
import { extractPdfText } from "@/app/lib/pdf-text";
import { renderPdfPageToPng } from "@/app/lib/pdf-render";
import { buildPickupRows, parseAdFromText, CUSTOMER_PAGE, AGENT_PAGE, type PickupItemInput } from "@/app/lib/property-pickups";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, applyImageFacts, type CustomerLike, type SentRowLike, type PatternRowLike, type Judgment } from "@/app/lib/property-brain";
import { loadCustomerProfit } from "@/app/lib/estimate-profit-server";
import { readPropertyImageDetail } from "@/app/lib/property-image-read";
import { readFloorPlanFacts } from "@/app/lib/property-brain-image";

/** 画像を読む上限（1回分）。DeepSeek は1枚 約$0.002〜0.004・15〜25秒。10件を並列で読み、merge-pdfs の 90秒に収める */
const IMAGE_READ_MAX_PER_BATCH = 10;
// 2026-09-24 YUMA テスト: 元付の資料は1枚 27〜40秒（出力 5,600〜8,700 のほぼ推論）。25秒では3件中2件が時間切れで空だった → 70秒
const IMAGE_READ_TIMEOUT_MS = 70_000;

export type RecordPickupInput = {
  batchId: string;
  propertyCustomerId: string | null;
  conversationId: string | null;
  customerName: string | null;
  site: string | null;
  /** 🌟 付きの説明文（merge-pdfs の rankAndAnnotateSummaries の後） */
  summaries: string[];
  /** 説明文と同じ並びの印刷用 PDF の URL（無い時は null） */
  pdfUrls: Array<string | null>;
  /** 説明文と同じ並びの PDF（base64） */
  pdfBase64List: Array<string | null>;
};

/** お客様の会話（LINE の宛先）を物件顧客から引く（最新1件） */
async function resolveConversationId(propertyCustomerId: string | null, conversationId: string | null): Promise<string | null> {
  if (conversationId) return conversationId;
  if (!propertyCustomerId) return null;
  const { data } = await supabase.from("conversations").select("id").eq("property_customer_id", propertyCustomerId).order("updated_at", { ascending: false }).limit(1);
  return ((data ?? [])[0] as { id?: string } | undefined)?.id ?? null;
}

/** 判定のプロフィール（judge API と同じ材料） */
async function loadProfile(propertyCustomerId: string | null) {
  if (!propertyCustomerId) return null;
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  const [custRes, sentRes, patRes, convsRes] = await Promise.all([
    supabase.from("property_customers").select("rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet").eq("id", propertyCustomerId).maybeSingle(),
    supabase.from("sent_properties").select("property_name, rent").eq("property_customer_id", propertyCustomerId).gte("sent_at", since).limit(500),
    supabase.from("property_selection_patterns").select("selling_points, selection_label").eq("property_customer_id", propertyCustomerId).order("created_at", { ascending: false }).limit(60),
    supabase.from("conversations").select("id").eq("property_customer_id", propertyCustomerId).limit(10),
  ]);
  const customer = custRes.data as CustomerLike | null;
  if (!customer) return null;
  const convIds = ((convsRes.data ?? []) as Array<{ id: string }>).map((c) => c.id);
  const profit = await loadCustomerProfit({ propertyCustomerId, conversationIds: convIds });
  return buildCustomerProfile(customer, (sentRes.data ?? []) as SentRowLike[], (patRes.data ?? []) as PatternRowLike[], profit.discountMedianYen);
}

export async function recordPickupBatch(input: RecordPickupInput): Promise<{ rows: number; withText: number; withBlob: number; withImage: number; imageRead: number; error: string | null }> {
  const out = { rows: 0, withText: 0, withBlob: 0, withImage: 0, imageRead: 0, error: null as string | null };
  try {
    if (input.summaries.length === 0) return out;
    const conversationId = await resolveConversationId(input.propertyCustomerId, input.conversationId);
    const profile = await loadProfile(input.propertyCustomerId);
    const { put } = await import("@vercel/blob");
    const stamp = Date.now();
    const base = `pickups/${input.batchId.replace(/\.pdf$/i, "")}`;
    const items: PickupItemInput[] = await Promise.all(input.summaries.map(async (summary, i) => {
      const b64 = input.pdfBase64List[i] ?? null;
      let pdfText: string | null = null;
      let pdfBlobUrl: string | null = null;
      let pageImageUrl: string | null = null;
      let agentImageUrl: string | null = null;
      if (b64) {
        // 2026-09-24 竹内「1ページ目は弊社に帯替えされた資料、2ページ目が元付業者の資料でそこに AD が載る。偶数ページを判断すれば正確」
        //   文字層（両ページ）・1ページ目（弊社＝お客様に送る画像）・2ページ目（元付＝AD・条件を読む画像）を並列で作る
        const [t, pngCustomer, pngAgent] = await Promise.all([
          extractPdfText(b64, { maxPages: 2, maxChars: 8000 }),
          renderPdfPageToPng(b64, { page: CUSTOMER_PAGE, scale: 1.5 }),
          renderPdfPageToPng(b64, { page: AGENT_PAGE, scale: 1.5 }),
        ]);
        pdfText = t.text || null;
        const puts = await Promise.allSettled([
          put(`${base}_${i + 1}_${stamp}.pdf`, Buffer.from(b64, "base64"), { access: "public", contentType: "application/pdf" }),
          pngCustomer ? put(`${base}_${i + 1}_${stamp}_p1.png`, pngCustomer.png, { access: "public", contentType: "image/png" }) : Promise.reject(new Error("no png p1")),
          // 1ページしか無い PDF は pngAgent が null（pdf-render は無いページを丸めない）
          pngAgent ? put(`${base}_${i + 1}_${stamp}_p2.png`, pngAgent.png, { access: "public", contentType: "image/png" }) : Promise.reject(new Error("no png p2")),
        ]);
        const [pdfPut, p1Put, p2Put] = puts;
        if (pdfPut.status === "fulfilled") pdfBlobUrl = pdfPut.value.url; else console.warn("[property-pickups] 物件ごとの PDF を置けない:", String(pdfPut.reason?.message ?? pdfPut.reason));
        if (p1Put.status === "fulfilled") pageImageUrl = p1Put.value.url; else if (pngCustomer) console.warn("[property-pickups] 画像(p1)を置けない:", String(p1Put.reason?.message ?? p1Put.reason));
        if (p2Put.status === "fulfilled") agentImageUrl = p2Put.value.url;
      }
      // 判定の材料: 表の文字（説明文）が正。AD だけは元付の資料（PDF の文字層）にしか無い事が多いので、無ければそこから補う
      const facts = parsePropertyFacts(summary);
      if (facts.adMonths == null && facts.adYen == null && pdfText) {
        const ad = parseAdFromText(pdfText);
        if (ad.adMonths != null) facts.adMonths = ad.adMonths;
        else if (ad.adYen != null) facts.adYen = ad.adYen;
      }
      let judgment: Judgment | null = null;
      if (profile) {
        try { judgment = judgeProperty(facts, profile, i); } catch { judgment = null; }
      }
      return { summary, pdfUrl: input.pdfUrls[i] ?? null, pdfBlobUrl, pdfText, judgment, pageImageUrl, agentImageUrl, imageLines: null, imageFacts: null };
    }));

    // AD が PDF の文字層から取れたら、送付記録（sent_properties・同じ印刷用 URL の行）にも入れる（見積書の割引と結び付ける材料）
    await Promise.allSettled(items.map(async (it) => {
      const j = it.judgment;
      if (!it.pdfUrl || !j || (j.facts.adMonths == null && j.facts.adYen == null)) return;
      await supabase.from("sent_properties")
        .update({ ad_months: j.facts.adMonths ?? null, ad_yen: j.adYen ?? j.facts.adYen ?? null })
        .eq("property_url", it.pdfUrl).is("ad_months", null);
    }));

    // 2026-09-24 竹内「PDF の文字だけではよくない。資料を読み取れる形にしたい」:
    //   画像になった資料を DeepSeek が読む。①資料に書いてある条件（駐車場・ペット・保証会社・設備… 有無・可否だけ）
    //   ②お客様の希望に画像でしか分からない語（バストイレ別・独立洗面・収納・南向き・2階以上）があれば、その有無で判定を更新
    //   失敗は判定を変えない（設計知見: 推論モデルは答え0文字で失敗する・失敗は記録に残さない）
    //   読むのは**元付業者の資料（2ページ目）**。無ければ1ページ目（竹内「偶数ページを画像として判断すればより正確」）
    const targets = items.map((it, i) => ({ it, i })).filter((x) => x.it.agentImageUrl || x.it.pageImageUrl).slice(0, IMAGE_READ_MAX_PER_BATCH);
    out.withImage = items.filter((it) => it.pageImageUrl || it.agentImageUrl).length;
    await Promise.allSettled(targets.map(async ({ it, i }) => {
      const url = (it.agentImageUrl ?? it.pageImageUrl) as string;
      const wants = profile?.imageWants ?? [];
      const [detail, facts] = await Promise.all([
        readPropertyImageDetail(url, { timeoutMs: IMAGE_READ_TIMEOUT_MS }),
        wants.length > 0 ? readFloorPlanFacts(url, wants, { timeoutMs: Math.min(IMAGE_READ_TIMEOUT_MS, 60_000) }) : Promise.resolve(null),
      ]);
      if (detail.kind === "property" && detail.lines.length > 0) { it.imageLines = detail.lines; out.imageRead++; }
      if (facts?.facts) {
        it.imageFacts = facts.facts;
        if (it.judgment) it.judgment = applyImageFacts(it.judgment, facts.facts);
        if (!it.imageLines) out.imageRead++;
      }
      void i;
    }));
    const rows = buildPickupRows({
      batchId: input.batchId, propertyCustomerId: input.propertyCustomerId, conversationId,
      customerName: input.customerName, site: input.site,
    }, items);
    const { error } = await supabase.from("property_pickups").insert(rows);
    if (error) { out.error = error.message; return out; }
    out.rows = rows.length;
    out.withText = rows.filter((r) => r.pdf_has_text).length;
    out.withBlob = rows.filter((r) => r.pdf_blob_url).length;
    // 画像から読んだ条件は、引用返信・ブレインが同じ表（image_details）から引けるように残す（既存の仕組みと同じ鍵＝画像の URL）
    const detailRows = rows.filter((r) => (r.agent_image_url || r.page_image_url) && r.image_lines && r.image_lines.length > 0)
      .map((r) => ({ image_url: (r.agent_image_url ?? r.page_image_url) as string, conversation_id: conversationId, kind: "property", lines: r.image_lines, model: "deepseek-flash", read_at: new Date().toISOString() }));
    if (detailRows.length > 0) {
      const { error: dErr } = await supabase.from("image_details").upsert(detailRows, { onConflict: "image_url" });
      if (dErr) console.warn("[property-pickups] image_details に残せない:", dErr.message);
    }
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  } finally {
    console.log(JSON.stringify({ tag: "property-pickups:record", batch: input.batchId.slice(0, 40), customer: input.propertyCustomerId?.slice(0, 8) ?? null, ...out }));
  }
}
