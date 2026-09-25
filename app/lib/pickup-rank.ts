// app/lib/pickup-rank.ts
// 物件ピックアップの説明文に資料から AD を補い、🌟（オススメ）を DeepSeek で付ける。merge-pdfs と YUMA のテストが同じ関数を使う。
import Anthropic from "@anthropic-ai/sdk";

/**
 * 説明文に AD が無い物件は、資料の文字層（元付の2ページ目に AD が載る）から「AD Nヶ月」を足す。
 * 拡張の列読みと同じ行の形（"AD 1ヶ月" / "AD 50,000円"）にして、parsePropertyFacts がそのまま読めるようにする。
 * 文字層の取り出しは純 JS（外部 API なし）。失敗・文字なしは元の説明文のまま（fail-open）。最大10件。
 */
export async function enrichSummariesWithPdfAd(summaries: string[], pdfBase64List: Array<string | null>): Promise<string[]> {
  // 2026-09-25: 説明文にもう AD の行がある物（「AD 2ヶ月」「A D 250%」「AD なし」）は足さない
  const AD_RE = /(?:^|\n)\s*(?:A\s?D|ＡＤ|広告料|広告費)\s*[\d０-９なN無]/;
  const targets = summaries.map((s, i) => ({ s, i })).filter(({ s, i }) => !AD_RE.test(s) && !!pdfBase64List[i]).slice(0, 10);
  if (targets.length === 0) return summaries;
  const out = [...summaries];
  let added = 0;
  try {
    const { extractPdfText } = await import("@/app/lib/pdf-text");
    const { parseAdFromText } = await import("@/app/lib/property-pickups");
    await Promise.all(targets.map(async ({ s, i }) => {
      try {
        const t = await extractPdfText(pdfBase64List[i] as string, { maxPages: 2, maxChars: 8000 });
        if (!t.hasText) return;
        const ad = parseAdFromText(t.text);
        // 資料に「広告費 なし」＝ AD なし（parsePropertyFacts が 0 と読む・不明とは分ける）
        const line = ad.adMonths === 0 ? "AD なし" : ad.adMonths != null ? `AD ${String(ad.adMonths).replace(/\.0$/, "")}ヶ月` : ad.adYen != null ? `AD ${ad.adYen.toLocaleString()}円` : null;
        if (!line) return;
        out[i] = s.replace(/\s*$/, "") + `\n${line}`;
        added++;
      } catch { /* その物件は元のまま */ }
    }));
  } catch (e) {
    console.warn("[merge-pdfs] 資料からの AD 補完をスキップ:", e instanceof Error ? e.message : String(e));
    return summaries;
  }
  console.log(JSON.stringify({ tag: "merge-pdfs:ad-from-pdf", candidates: targets.length, added }));
  return out;
}

/**
 * 説明文の抜け（物件名・号室・賃料・管理費・間取り・㎡・最寄り駅と徒歩）を資料の文字層で補い、続けて AD も補う。
 * 2026-09-24 竹内「賃料と間取りも㎡数取り入れるようにする。そうじゃないとちゃんと判断できないので」
 *   「駅名や徒歩数もリアプロ itandi ともに読み取れているのか」
 *   → itandi の説明文は「【1】物件 AD 1ヶ月」だけ・リアプロは号室と駅・徒歩が無かった（listing-text.ts の冒頭に実測）。
 *   説明文にある値が正で、無い所だけ補う。名前が違う PDF（組の取り違え）は補わない。食い違いはログに出す。
 *   LINE グループの表示・🌟 の順位付け・送付記録（sent_properties）・売上サポ（property_pickups）が全部この説明文を読むので、ここで一度だけ補う。
 * 文字層の取り出しは純 JS（外部 API なし・1件 約50ms）。失敗は元の説明文のまま（fail-open）。
 */
export async function enrichSummariesFromPdf(summaries: string[], pdfBase64List: Array<string | null>, tag = "merge-pdfs"): Promise<string[]> {
  if (summaries.length === 0) return summaries;
  const out = [...summaries];
  const stat = { candidates: 0, filled: 0, skipped: 0, conflicts: [] as string[], fields: {} as Record<string, number> };
  try {
    const { extractPdfText } = await import("@/app/lib/pdf-text");
    const { parseListingText, fillSummaryFromListing } = await import("@/app/lib/listing-text");
    await Promise.all(summaries.map(async (s, i) => {
      const b64 = pdfBase64List[i];
      if (!b64) return;
      stat.candidates++;
      try {
        const t = await extractPdfText(b64, { maxPages: 2, maxChars: 8000 });
        if (!t.hasText) return;
        const r = fillSummaryFromListing(s, parseListingText(t.text));
        if (r.skipped) stat.skipped++;
        if (r.conflicts.length) stat.conflicts.push(`${i + 1}:${r.conflicts.join("/")}`);
        if (r.filled.length) {
          out[i] = r.summary;
          stat.filled++;
          for (const f of r.filled) stat.fields[f] = (stat.fields[f] ?? 0) + 1;
        }
      } catch { /* その物件は元のまま */ }
    }));
  } catch (e) {
    console.warn(`[${tag}] 資料からの説明文の補いをスキップ:`, e instanceof Error ? e.message : String(e));
    return summaries;
  }
  console.log(JSON.stringify({ tag: `${tag}:fill-from-pdf`, ...stat }));
  return enrichSummariesWithPdfAd(out, pdfBase64List);
}

/**
 * 🌟 の順位付けの固定の前置き（毎回同じ文字＝DeepSeek の前置きキャッシュが効くよう、お客様の条件・物件一覧より**前**に置く）。
 * 2026-09-25 任務B（スタッフが実際に選んだ🌟 522通・候補の回 82回を実データで読んだ）で直した所:
 *   - 家賃は「安いほど良い（㎡あたり）」をやめた: 🌟の家賃は上限の 0.95（中央値）＝予算の上の方で選んでいる。超過は 1万円以内が 80%
 *   - スタッフが🌟の本文で訴求している点を多い順に足した: 敷礼0 56%（初期費用を抑えたい方 65%）・築浅（新築・築5年以内 52%）・
 *     駅近 72%・広さ／ゆとり 52%・オートロック 46%・独立洗面 44%・ネット無料 42%・宅配ボックス 32%・浴室乾燥 26%・角部屋 24%
 *   - 間取り: 2DK↔1LDK は同じ広さの級・希望より広い間取りは可（🌟で 2DK↔1LDK 4人・広い間取り 5人）
 *   - 同じくらいなら元の並び（拡張の順位は🌟の 1位 41.5%・3位以内 80.5% で、点より強い材料）
 *   - AD の扱い（2ヶ月以上を最上位）は竹内さんの 9/24 の指示のまま（データでは🌟は AD で選ばれていない＝判断待ち）
 */
export const RANK_PROMPT_PREFIX = `あなたは賃貸仲介のスタッフです。後ろの【物件一覧】から、お客様に一番オススメの物件の番号（【N】の N）を上位1〜3件選び、JSONだけで返してください。配列の先頭が一番オススメです。

判断基準（優先順位が高い順）:
1. お客様の希望条件への合致（最優先）:
   - 家賃（管理費込み）が予算以内か。予算内なら安さでは選ばない（スタッフが実際に選ぶ物件は予算の上の方が多い）。上限を1万円まで超える物件は候補に残してよい
   - 間取りが希望どおりか（2DK と 1LDK は同じ広さの級として扱う。希望より広い間取りは可）
   - 徒歩分数・専有面積・築年数・入居時期・設備の希望に合うか
   - 敷金・礼金は0に近いほど良い（なし > 1ヶ月 > 2ヶ月以上）。初期費用を抑えたい方には特に強く優先する
   ※ 予算を大幅に超える（上限＋2万円超）物件・希望より狭い間取りの物件は選ばないこと
2. AD（弊社の報酬・1 を満たす物件の中では最も重視する）:
   - 「AD 2ヶ月」「AD 200%」以上 = 家賃×2ヶ月分以上の報酬（1 を満たす物件の中では必ず最上位に置く。3ヶ月以上ならさらに上）
   - 「AD 1ヶ月」「AD 100%」 = 家賃×1ヶ月分の報酬（AD なしより上）
   - 「AD 50,000円」のような円は家賃で割って月数に直す
   - 「AD なし」・AD の記載なし = 報酬ゼロ（他の条件が同じなら AD ありを上に）
3. スタッフが一番オススメで実際に訴求している良さ（多い順）:
   敷金礼金0 ／ 築浅（新築・築5年以内） ／ 駅近（徒歩5分以内） ／ 広さ（ゆとりのある帖数・㎡） ／ オートロック ／ 独立洗面台 ／ ネット無料 ／ 宅配ボックス ／ 浴室乾燥機 ／ 角部屋
4. 同じくらいなら元の並び（番号の小さい方）を上にする

各物件の「資料:」の行は物件資料（PDF）の表から読んだ事実です。書いていない事は「分からない」として扱い、減点しないこと。
返事の形: {"recommended":[2,5]}（JSONのみ）`;

/** 🌟 の順位付けに渡す文（DeepSeek と、失敗時の Claude で**同じ文**を使う）。materials は物件ごとの「資料:」の1行（プロンプトだけに入れる・説明文は変えない） */
export function buildRankPrompt(summaries: string[], customerConditions?: string | null, materials?: Array<string | null> | null): string {
  const conditionsBlock = customerConditions
    ? `【お客様の希望条件（最優先で照らし合わせること）】\n${customerConditions}\n\n`
    : "";
  const list = summaries.map((s, i) => (materials?.[i] ? `${s}\n資料: ${materials[i]}` : s));
  return `${RANK_PROMPT_PREFIX}

${conditionsBlock}【物件一覧】
${list.join('\n\n')}`;
}

/**
 * 🌟 に渡すお客様の条件の文（純関数）。
 * 2026-09-25 YUMA テスト（条件の違うお客様6人）: 拡張が送る条件の文（popup.js buildCustomerConditionsString）は
 *   ①家賃を万で丸める（7.5万→「予算8万円以内」・6.2万→「6万円」）②設備・入居時期・初期費用・通勤・広さ以外の希望が入らない
 *   → 宅配ボックス必須のお客様・入居10月中旬のお客様でも DeepSeek は知らずに選んでいた（前回の報告の残り 4）。
 *   売上サポの詳細と同じ「条件の要約」（condition-summary・DB の条件欄から決定論で作る）があればそれを正にし、拡張の文は要約が無い時だけ使う。
 *   初期費用を抑えたい方（判定の ZERO_ZERO_MATCH と同じ判定）は一言足す（要約は上限の金額だけで「敷礼0」を落とすことがあった）
 */
export function buildRankConditions(extConditions: string | null | undefined, detail?: { summaryLine?: string | null; lowInitialCost?: boolean } | null): string | null {
  const line = detail?.summaryLine?.trim() || null;
  const parts = [line ? `${line}` : (extConditions?.trim() || null), detail?.lowInitialCost ? "初期費用を抑えたい（敷金・礼金0の物件を優先）" : null].filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

/**
 * 🌟 に渡す条件の文を DB の条件欄から作る（merge-pdfs と YUMA テストが同じ関数を使う）。DB だけ（DeepSeek は呼ばない＝保存済みの要約だけ使う）。
 * 失敗・お客様が無い時は拡張の文のまま（fail-open）
 */
export async function loadRankConditions(propertyCustomerId: string | null, extConditions: string | null | undefined): Promise<string | null> {
  if (!propertyCustomerId) return buildRankConditions(extConditions, null);
  try {
    const [{ supabase }, { loadConditionSummary, SUMMARY_COLS }, { detectWantsLowInitialCost }] = await Promise.all([
      import("@/app/lib/supabase"), import("@/app/lib/condition-summary-server"), import("@/app/lib/property-brain"),
    ]);
    const { data } = await supabase.from("property_customers").select(SUMMARY_COLS).eq("id", propertyCustomerId).maybeSingle();
    if (!data) return buildRankConditions(extConditions, null);
    const c = data as unknown as Parameters<typeof detectWantsLowInitialCost>[0] & NonNullable<Parameters<typeof loadConditionSummary>[1]>["customer"];
    const s = await loadConditionSummary(propertyCustomerId, { allowLlm: false, customer: c });
    return buildRankConditions(extConditions, { summaryLine: s?.line ?? null, lowInitialCost: detectWantsLowInitialCost(c) });
  } catch (e) {
    console.warn("[merge-pdfs] 🌟 の条件の要約をスキップ:", e instanceof Error ? e.message : String(e));
    return buildRankConditions(extConditions, null);
  }
}

/** 資料の表から🌟の判断材料の1行を作る（敷礼・築年・入居時期・スタッフがよく訴求する設備）。純関数 */
export function rankMaterialLine(terms: { hasText: boolean; depositMonths: number | null; keyMoneyMonths: number | null; buildingAgeYears: number | null; newBuild: boolean; moveIn: { kind: string; date?: string; part?: string; day?: number; vacateMonthDay?: string } },
  equipOk: string[]): string | null {
  if (!terms.hasText) return null;
  const parts: string[] = [];
  const m = (v: number | null) => (v == null ? "?" : v === 0 ? "なし" : `${v}ヶ月`);
  if (terms.depositMonths != null || terms.keyMoneyMonths != null) parts.push(`敷${m(terms.depositMonths)}・礼${m(terms.keyMoneyMonths)}`);
  if (terms.newBuild) parts.push("新築");
  else if (terms.buildingAgeYears != null) parts.push(`築${terms.buildingAgeYears}年`);
  const mi = terms.moveIn;
  if (mi.kind === "immediate") parts.push("即入居");
  else if (mi.kind === "date" && mi.date) parts.push(`入居${parseInt(mi.date.slice(5), 10)}月${mi.day ? `${mi.day}日` : mi.part ?? ""}〜`);
  // 退去予定日があれば出す（「退去予定(10/31)/相談」＝ 11/1 より前には入れない・監査 E4）
  else if (mi.vacateMonthDay) parts.push(`退去予定${parseInt(mi.vacateMonthDay.slice(0, 2), 10)}/${parseInt(mi.vacateMonthDay.slice(3), 10)}（入居はその後・相談）`);
  else if (mi.kind === "consult") parts.push("入居時期は相談");
  if (equipOk.length) parts.push(`設備: ${equipOk.join("・")}`);
  return parts.length ? parts.join(" ／ ") : null;
}

/** 🌟の判断材料に出す設備（スタッフの訴求が多い順・任務B） */
const RANK_EQUIP_KEYS = ["autolock", "washbasin", "net_free", "delivery_box", "bath_dryer", "corner", "bath_toilet"] as const;

/**
 * 物件ごとの資料の文字層から🌟の判断材料（rankMaterialLine）を作る。文字層の取り出しは純 JS（外部 API なし）。失敗・文字なしは null（fail-open）
 */
export async function buildRankMaterials(pdfBase64List: Array<string | null>): Promise<Array<string | null>> {
  try {
    const { extractPdfText } = await import("@/app/lib/pdf-text");
    const { parseListingTerms } = await import("@/app/lib/listing-terms");
    const { parseListingEquipment, EQUIP_LABELS } = await import("@/app/lib/listing-equipment");
    return await Promise.all(pdfBase64List.map(async (b64) => {
      if (!b64) return null;
      try {
        const t = await extractPdfText(b64, { maxPages: 2, maxChars: 8000 });
        if (!t.hasText) return null;
        const eq = parseListingEquipment(t.text);
        const ok = RANK_EQUIP_KEYS.filter((k) => eq.items[k]?.status === "ok").map((k) => EQUIP_LABELS[k]);
        return rankMaterialLine(parseListingTerms(t.text), ok);
      } catch { return null; }
    }));
  } catch (e) {
    console.warn("[merge-pdfs] 🌟の判断材料（資料の表）をスキップ:", e instanceof Error ? e.message : String(e));
    return pdfBase64List.map(() => null);
  }
}

/** 返事の JSON から番号を読む（DeepSeek・Claude 共通） */
export function parseRankReply(text: string): number[] | null {
  const match = text.match(/"recommended"\s*:\s*\[([^\]]*)\]/);
  if (!match) return null;
  return match[1].split(",").map((n) => parseInt(n.trim())).filter((n) => !isNaN(n));
}

// 2026-09-24 竹内「ここ Haiku じゃなくて DeepSeek 使う」: 🌟 の順位付けは DeepSeek（deepseek-flash・reasoning low・文字だけ）。
//   説明文は物件資料なので別クラウドに出してよい（お客様の個人情報は入れない: customerConditions は条件の文だけ）。
//   DeepSeek が空・失敗なら今までの Claude Haiku に倒す（fail-open）。費用は llm_usage_logs（action=property_rank）に残す。
export async function rankWithDeepSeek(prompt: string): Promise<number[] | null> {
  // ⚠ callVisionAlt は画像が無いと送らない（文字だけだと毎回 null → Haiku に落ちていた・2026-09-24 YUMA テストで発見）→ 文字も通す callDeepSeek
  const { callDeepSeek, VISION_ALT_MODEL_DEFAULT } = await import("@/app/lib/vision-alt-provider");
  // 2026-09-25 YUMA テスト（scripts/yuma-star-rank-test.ts・実物の資料3回分×旧/新/新2回目）: 推論 low・max 4000 は 9回中 5回が
  //   約20秒で答え0文字（推論で上限を使い切る）→ Haiku に落ちていた。推論なし（thinking:false・温度0）は 9回とも答え・1秒未満・
  //   2回目は同じ答え（揺れない）・固定の前置きのキャッシュが当たる（2回目 入力の 84〜94%）→ 推論なしに固定（送る形を変えるとキャッシュが外れる）
  const startedAt = Date.now();
  const res = await callDeepSeek(null, prompt, { maxTokens: 300, timeoutMs: 30_000, thinking: false, temperature: 0 });
  const nums = res ? parseRankReply(res.text) : null;
  void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => {
    recordAltUsage({
      model: res?.model ?? VISION_ALT_MODEL_DEFAULT, action: "property_rank", conversationId: null,
      usage: { input_tokens: res?.usage.cacheMiss ?? 0, output_tokens: res?.usage.output ?? 0, cache_read_input_tokens: res?.usage.cacheHit ?? 0 },
      status: res ? 200 : 0, errorType: res ? (nums ? null : "empty_or_unparsable") : "no_response",
      durationMs: Date.now() - startedAt, sysHead: "【🌟 順位付け】" + prompt.slice(0, 120), sysKeyFull: null, maxTokens: 300,
    });
  }).catch(() => {});
  return nums;
}

export async function rankAndAnnotateSummaries(summaries: string[], customerConditions?: string | null, materials?: Array<string | null> | null): Promise<string[]> {
  if (summaries.length <= 1) return summaries;
  try {
    const prompt = buildRankPrompt(summaries, customerConditions, materials);
    let recommendedArr = await rankWithDeepSeek(prompt);
    if (!recommendedArr) {
      console.warn("[merge-pdfs] 🌟 の順位付け: DeepSeek が答えなかったので Claude Haiku に倒す");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "") });
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      });
      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      recommendedArr = parseRankReply(text);
      if (!recommendedArr) return summaries;
    }
    const topPickNum = recommendedArr[0]; // AIの真の1位（配列の先頭が最高スコア）
    const recommended = new Set(recommendedArr);
    return summaries.map((summary, i) => {
      if (!recommended.has(i + 1)) return summary;
      const lines = summary.split("\n");
      // 真の1位は🌟★、それ以外の推薦は🌟のみ（buildLineMessageで区別するため）
      const marker = (i + 1) === topPickNum ? "【$1🌟★】" : "【$1🌟】";
      lines[0] = lines[0].replace(/^【(\d+)】/, marker);
      return lines.join("\n");
    });
  } catch (e) {
    console.warn("[merge-pdfs] AI ranking skipped:", e);
    return summaries;
  }
}
