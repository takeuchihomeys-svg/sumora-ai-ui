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
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, applyImageFacts, fillFactsFromTerms, isSentRoom, type CustomerLike, type CustomerProfile, type PropertyFacts, type SentRowLike, type PatternRowLike, type Judgment } from "@/app/lib/property-brain";
import { buildBatchEquipment } from "@/app/lib/pickup-equipment";
import { parseListingTerms, type ListingTerms } from "@/app/lib/listing-terms";
import { buildPickupTerms } from "@/app/lib/pickup-terms";
import { loadCustomerProfit } from "@/app/lib/estimate-profit-server";
import { readPropertyImageDetail } from "@/app/lib/property-image-read";
import { readFloorPlanFacts } from "@/app/lib/property-brain-image";
import { dedupeSameBuilding, dedupeNoteJa } from "@/app/lib/pickup-dedupe";
import { parseAreaWant, parseCommuteWants, buildPropertyLocation, matchArea, matchCommute, locationReasonCodes, toPickupLocation, type AreaWant, type CommuteWant, type PickupLocation } from "@/app/lib/area-want";
import { parseListingText } from "@/app/lib/listing-text";

/**
 * 2026-09-25 自動の読み取り（pickup-auto-analyze）を始めてよい締め切り（recordPickupBatch の開始から）。merge-pdfs の maxDuration 300秒に収める。
 *   反証レビューで 150→110 秒: recordPickupBatch は merge-pdfs の結合・順位付け・LINE 送信の後（waitUntil）に始まり、その時間も 300秒に入る。
 *   1件の読み取りは最悪 取得15＋読み40＋読み直し90＋希望の照合30 秒なので、始める線を早めて途中で切られる読みを減らす
 *   （切られても property_pickups の行は先に入れてあるので記録は残る）
 */
const AUTO_ANALYZE_DEADLINE_MS = 110_000;

type LocationWants = { area: AreaWant; commute: CommuteWant[] };
/** 物件の場所（説明文・文字層）と希望のエリア・通勤を照らす（決定論・DeepSeek 0円） */
function locateItem(summary: string, pdfText: string | null, w: LocationWants | null): { codes: string[]; saved: PickupLocation | null } {
  const loc = buildPropertyLocation(summary, pdfText);
  if (!w) return { codes: [], saved: loc.stations.length || loc.ward ? toPickupLocation(loc, null, []) : null };
  const area = matchArea(w.area, loc);
  const commute = matchCommute(w.commute, loc);
  return { codes: locationReasonCodes(area, commute), saved: toPickupLocation(loc, area, commute) };
}

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

/** 判定のプロフィール（judge API と同じ材料）と、設備の希望を読む条件欄（customer） */
async function loadProfile(propertyCustomerId: string | null): Promise<{ profile: CustomerProfile; customer: CustomerLike; location: LocationWants | null } | null> {
  if (!propertyCustomerId) return null;
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  const [custRes, sentRes, patRes, convsRes] = await Promise.all([
    // 2026-09-25: 広さ・条件フォームの原文（間取りの「も可」）・エリア・通勤も引く
    supabase.from("property_customers").select("rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes, structure_types").eq("id", propertyCustomerId).maybeSingle(),
    // room_no: 送付済みの照合を号室で見る（同じ建物の別の部屋は外す候補にしない・2026-09-25）
    supabase.from("sent_properties").select("property_name, rent, delivery, source, room_no").eq("property_customer_id", propertyCustomerId).gte("sent_at", since).limit(500),
    supabase.from("property_selection_patterns").select("selling_points, selection_label").eq("property_customer_id", propertyCustomerId).order("created_at", { ascending: false }).limit(60),
    supabase.from("conversations").select("id").eq("property_customer_id", propertyCustomerId).limit(10),
  ]);
  const customer = custRes.data as (CustomerLike & { desired_area?: string | null; commute_station?: string | null; commute_minutes?: number | null }) | null;
  if (!customer) return null;
  const convIds = ((convsRes.data ?? []) as Array<{ id: string }>).map((c) => c.id);
  const profit = await loadCustomerProfit({ propertyCustomerId, conversationIds: convIds });
  // 2026-09-25 エリア（desired_area＋自由文の「以外・より北」）と通勤（列・自由文の「◯◯まで30分」）
  const area = parseAreaWant(customer.desired_area, [customer.preferences, customer.other_requests].filter(Boolean).join("\n"));
  const commute = parseCommuteWants(customer);
  return {
    profile: buildCustomerProfile(customer, (sentRes.data ?? []) as SentRowLike[], (patRes.data ?? []) as PatternRowLike[], profit.discountMedianYen),
    customer,
    location: area.any || commute.length ? { area, commute } : null,
  };
}

export async function recordPickupBatch(input: RecordPickupInput): Promise<{ rows: number; withText: number; withBlob: number; withImage: number; imageRead: number; deduped: number; noTextDraw: number; autoAnalyzed: number; autoLevel: string | null; summaryCalled: boolean; error: string | null }> {
  const out = { rows: 0, withText: 0, withBlob: 0, withImage: 0, imageRead: 0, deduped: 0, noTextDraw: 0, autoAnalyzed: 0, autoLevel: null as string | null, summaryCalled: false, error: null as string | null };
  const startedAt = Date.now();
  try {
    if (input.summaries.length === 0) return out;
    // 2026-09-24 竹内「同じ建物だと平米数2㎡以内だと家賃がひくい部屋をここにいれて、他の部屋は売上サポに飛ばさなくて大丈夫。
    //   同じマンションの部屋何個もお客さんに送らないので」→ 売上サポの記録だけ絞る（LINE グループ・結合 PDF・sent_properties は merge-pdfs のまま）。
    //   先に絞るので、落とした部屋の画像の描画・Blob・DeepSeek の読み取りの費用もかからない。順位（【N】）は元の番号のまま＝LINE グループと一致
    // 2026-09-25 送付済みの部屋は「残す部屋」に選ばない（同じ建物のまだ送っていない部屋を残す）→ 判定の材料（送付の記録）を先に読む
    const conversationId = await resolveConversationId(input.propertyCustomerId, input.conversationId);
    const loaded = await loadProfile(input.propertyCustomerId);
    const profile = loaded?.profile ?? null;
    const sentIdx = new Set<number>();
    if (profile && profile.history.sentCount > 0) input.summaries.forEach((s, i) => { try { if (isSentRoom(parsePropertyFacts(s), profile)) sentIdx.add(i); } catch { /* 読めない物は送付済みにしない */ } });
    const dd = dedupeSameBuilding(input.summaries, { isSent: (i) => sentIdx.has(i) });
    out.deduped = dd.dropped.length;
    if (dd.dropped.length > 0) {
      console.log(JSON.stringify({ tag: "property-pickups:dedupe", batch: input.batchId.slice(0, 40), kept: dd.keep.length, dropped: dd.dropped.map((d) => ({ rank: d.rank, name: d.name, area: d.areaSqm, rent: d.rentYen, keptRank: d.keptRank })) }));
    }
    /** 判定の材料（説明文＋AD の補い）。判定は設備の照合（回の全部の行が要る）の後で行う */
    const factsOf = new Map<number, PropertyFacts>();
    // 2026-09-25 竹内「敷金礼金と入居時期、組み込みたい」: 資料の表（文字層）の募集の条件（listing-terms.ts・決定論・DeepSeek 0円）。
    //   敷礼・築年は説明文に無い所だけ埋め（INITIAL_COST_UNKNOWN が 36行中33行だった）、入居時期・定期借家・入居の条件は判定の札に
    const termsOf = new Map<number, { t: ListingTerms; filled: string[] }>();
    // 2026-09-25 竹内「エリアの部分、把握できれば理想」「通勤の部分も沿線の知識」: 物件の場所と希望のエリア・通勤の照合（決定論）
    const locOf = new Map<number, { codes: string[]; saved: PickupLocation | null }>();
    const { put } = await import("@vercel/blob");
    const stamp = Date.now();
    const base = `pickups/${input.batchId.replace(/\.pdf$/i, "")}`;
    const items: PickupItemInput[] = await Promise.all(dd.keep.map(async (i) => {
      const summary = input.summaries[i];
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
        // 2026-09-24 竹内「文字が反映されていないバグ」: 文字層がある資料なのに描いた文字が 0 ＝ 文字抜けの画像（cMap が渡っていない等）。
        //   落ちずに「白い表」になるだけで誰も気付けなかったので、数えて警告とログに出す
        if (t.hasText && pngCustomer && pngCustomer.textDraws === 0) {
          out.noTextDraw++;
          console.warn("[property-pickups] 文字層がある資料なのに画像に文字が1つも描かれていない（文字抜け）:", `${base}_${i + 1}`);
        }
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
      if (pdfText) {
        const t = parseListingTerms(pdfText);
        termsOf.set(i, { t, filled: fillFactsFromTerms(facts, t) });
        // 2026-09-25 広さ（説明文に無い時は資料の文字層の専有面積）
        if (facts.areaSqm == null) { const a = parseListingText(pdfText).areaSqm; if (a != null) facts.areaSqm = a; }
      }
      factsOf.set(i, facts);
      locOf.set(i, locateItem(summary, pdfText, loaded?.location ?? null));
      const nDropped = dd.droppedCount.get(i) ?? 0;
      return {
        summary, pdfUrl: input.pdfUrls[i] ?? null, pdfBlobUrl, pdfText, judgment: null, pageImageUrl, agentImageUrl, imageLines: null, imageFacts: null,
        recommendedOverride: dd.inheritMark.get(i) ?? null,
        extraReasonsJa: nDropped > 0 ? [dedupeNoteJa(nDropped)] : null,
        fallbackRank: i + 1,
      };
    }));

    // 落とした部屋も LINE グループには送られ sent_properties に記録されている（merge-pdfs）→ AD の補いは落とした部屋にも行う
    //   （売上サポに載せないだけ。見積書の割引と結び付ける材料を失わない）。文字層だけ取る（画像・Blob・DeepSeek は使わない）
    //   2026-09-24: 落とした部屋の文字層は設備の補い（同じ建物の別の部屋に「宅配BOX」と書いてある）にも使う → 文字層は PDF がある部屋は全部取る
    const droppedText = new Map<number, string | null>();
    await Promise.allSettled(dd.dropped.map(async (d) => {
      const b64 = input.pdfBase64List[d.index] ?? null;
      if (!b64) return;
      const t = await extractPdfText(b64, { maxPages: 2, maxChars: 8000 });
      droppedText.set(d.index, t.text || null);
    }));

    // 2026-09-24 竹内「宅配BOX付きなども条件なのに入れていない」「設備欄を見る」「202号室なら2階」:
    //   資料の文字層の設備欄を決定論で読み（DeepSeek 0円）、同じ建物の別の部屋（落とした部屋も）で建物単位の設備を補い、
    //   お客様の条件欄の希望と照らす。結果は property_pickups.equipment と判定（EQUIP_*）に入れる
    const eqBatch = buildBatchEquipment([
      // label は補いの根拠に出す名前（LINE の【n】と同じ番号。落とした部屋は「（省略）」付き）
      ...items.map((it, k) => ({ key: `k${k}`, pdfText: it.pdfText, label: `【${dd.keep[k] + 1}】` })),
      ...dd.dropped.map((d) => ({ key: `d${d.index}`, pdfText: droppedText.get(d.index) ?? null, label: `【${d.index + 1}】（省略した部屋）` })),
    ], loaded?.customer ?? null);
    const eqOf = new Map(eqBatch.rows.map((r) => [r.key, r]));
    items.forEach((it, k) => {
      const e = eqOf.get(`k${k}`);
      it.equipment = e?.saved ?? null;
      const i = dd.keep[k];
      const facts = factsOf.get(i);
      const tm = termsOf.get(i);
      const lc = locOf.get(i);
      it.location = lc?.saved ?? null;
      if (profile && facts) {
        try { it.judgment = judgeProperty(facts, profile, i, { equipment: e?.match ?? null, terms: tm?.t ?? null, locationCodes: lc?.codes ?? null }); } catch { it.judgment = null; }
      }
      if (tm && tm.t.hasText) {
        try { it.terms = buildPickupTerms(tm.t, profile, { equipment: e?.match ?? null, filled: tm.filled }); } catch { it.terms = null; }
      }
    });
    console.log(JSON.stringify({ tag: "property-pickups:terms", batch: input.batchId.slice(0, 40),
      rows: items.map((it) => it.terms ? { l: it.terms.line, f: it.terms.filled, mi: it.terms.want.moveIn?.result ?? null, c: it.terms.want.conditions.map((c) => `${c.key}:${c.status}`) } : null) }));
    if (eqBatch.wants.wants.length > 0) {
      console.log(JSON.stringify({ tag: "property-pickups:equipment", batch: input.batchId.slice(0, 40), wants: eqBatch.wants.wants.length, uncovered: eqBatch.wants.uncovered.length,
        rows: items.map((it) => it.equipment ? { ok: it.equipment.ok, ng: it.equipment.ng, un: it.equipment.unlisted, f: it.equipment.floor } : null) }));
    }

    const droppedAd: Array<{ pdfUrl: string; judgment: Judgment | null }> = [];
    if (profile) {
      for (const d of dd.dropped) {
        const pdfUrl = input.pdfUrls[d.index] ?? null;
        if (!pdfUrl) continue;
        const facts = parsePropertyFacts(input.summaries[d.index]);
        const text = droppedText.get(d.index) ?? null;
        if (facts.adMonths == null && facts.adYen == null && text) {
          const ad = parseAdFromText(text);
          if (ad.adMonths != null) facts.adMonths = ad.adMonths;
          else if (ad.adYen != null) facts.adYen = ad.adYen;
        }
        const dt = text ? parseListingTerms(text) : null;
        if (dt) fillFactsFromTerms(facts, dt);
        if (facts.areaSqm == null && text) { const a = parseListingText(text).areaSqm; if (a != null) facts.areaSqm = a; }
        const dl = locateItem(input.summaries[d.index], text, loaded?.location ?? null);
        let judgment: Judgment | null = null;
        try { judgment = judgeProperty(facts, profile, d.index, { equipment: eqOf.get(`d${d.index}`)?.match ?? null, terms: dt, locationCodes: dl.codes }); } catch { judgment = null; }
        droppedAd.push({ pdfUrl, judgment });
      }
    }

    // AD が PDF の文字層から取れたら、送付記録（sent_properties・同じ印刷用 URL の行）にも入れる（見積書の割引と結び付ける材料）
    await Promise.allSettled([...items, ...droppedAd].map(async (it) => {
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
      // 設備欄で ○/× が決まった希望（バストイレ別・独立洗面・南向き・2階以上）は画像で読み直さない（judgeProperty の imageChecks）
      const wants = it.judgment ? it.judgment.imageChecks : (profile?.imageWants ?? []);
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
    // 2026-09-25 一番オススメ: 行の recommended（🌟★=2・🌟=1）は merge-pdfs で判定の**前**に DeepSeek が付けた印のまま残す（書き換えない）。
    //   売上サポの「一番オススメ」は判定の後の点の1位（👑・pickup-best の pickCustomerBest／roundBestId）で画面と「完了」のまとめが決め、
    //   recommended は「点が並んだ時の順番」（pickCustomerBest の tail・compareForReview）の材料にだけ使う。
    //   ここで付け直さない理由: 画像で分析が要るお客様の 👑 はこの後の自動の読み取り（pickup-auto-analyze）の点で決まり、回をまたいで変わる
    //   （ここで判定の点で付け直すと、画面の 👑 と食い違う印が DB に残る）。DeepSeek が何を選んだかの記録も消えない
    const rows = buildPickupRows({
      batchId: input.batchId, propertyCustomerId: input.propertyCustomerId, conversationId,
      customerName: input.customerName, site: input.site,
    }, items);
    let ins = await supabase.from("property_pickups").insert(rows).select("id");
    // 2026-09-25: location 列を本番に足す前に動いても記録は残す（列が無い時は location を外して入れ直す）
    if (ins.error && /location/.test(ins.error.message)) {
      console.warn("[property-pickups] location 列が無いので外して記録:", ins.error.message);
      ins = await supabase.from("property_pickups").insert(rows.map(({ location: _l, ...r }) => r)).select("id");
    }
    const { error } = ins;
    if (error) { out.error = error.message; return out; }
    out.rows = rows.length;
    const insertedIds = ((ins.data ?? []) as Array<{ id: number }>).map((r) => r.id);
    out.withText = rows.filter((r) => r.pdf_has_text).length;
    out.withBlob = rows.filter((r) => r.pdf_blob_url).length;
    // 画像から読んだ条件は、引用返信・ブレインが同じ表（image_details）から引けるように残す（既存の仕組みと同じ鍵＝画像の URL）
    const detailRows = rows.filter((r) => (r.agent_image_url || r.page_image_url) && r.image_lines && r.image_lines.length > 0)
      .map((r) => ({ image_url: (r.agent_image_url ?? r.page_image_url) as string, conversation_id: conversationId, kind: "property", lines: r.image_lines, model: "deepseek-flash", read_at: new Date().toISOString() }));
    if (detailRows.length > 0) {
      const { error: dErr } = await supabase.from("image_details").upsert(detailRows, { onConflict: "image_url" });
      if (dErr) console.warn("[property-pickups] image_details に残せない:", dErr.message);
    }
    // 2026-09-25 竹内「売上サポに送られたら、条件指定あれば間取り図とか設備も自動的に読み取る」「文章の部分も要約できるように」:
    //   ①画像でしか分からない希望があるお客様だけ、この回の物件を「🔍 画像で分析」と同じ形で自動で読む（pickup-auto-analyze）
    //   ②条件の自由文のうち決定論で読めない節だけ DeepSeek で要約して保存（文が変わっていなければ呼ばない）
    //   どちらも同じ waitUntil の中（応答は待たせない）・失敗しても記録は残す
    const [auto, summary] = await Promise.allSettled([
      import("@/app/lib/pickup-auto-analyze").then(({ autoAnalyzeBatch }) => autoAnalyzeBatch({
        ids: insertedIds, propertyCustomerId: input.propertyCustomerId, conversationId, deadlineAt: startedAt + AUTO_ANALYZE_DEADLINE_MS,
      })),
      input.propertyCustomerId
        ? import("@/app/lib/condition-summary-server").then(({ loadConditionSummary }) => loadConditionSummary(input.propertyCustomerId, { allowLlm: true, conversationId }))
        : Promise.resolve(null),
    ]);
    if (auto.status === "fulfilled") { out.autoAnalyzed = auto.value.analyzed; out.autoLevel = auto.value.level; }
    if (summary.status === "fulfilled" && summary.value) out.summaryCalled = summary.value.called;
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  } finally {
    console.log(JSON.stringify({ tag: "property-pickups:record", batch: input.batchId.slice(0, 40), customer: input.propertyCustomerId?.slice(0, 8) ?? null, ...out }));
  }
}
