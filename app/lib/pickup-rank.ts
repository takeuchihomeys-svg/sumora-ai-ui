// app/lib/pickup-rank.ts
// 物件ピックアップの説明文に資料から AD を補い、🌟（オススメ）を DeepSeek で付ける。merge-pdfs と YUMA のテストが同じ関数を使う。
import Anthropic from "@anthropic-ai/sdk";

/**
 * 説明文に AD が無い物件は、資料の文字層（元付の2ページ目に AD が載る）から「AD Nヶ月」を足す。
 * 拡張の列読みと同じ行の形（"AD 1ヶ月" / "AD 50,000円"）にして、parsePropertyFacts がそのまま読めるようにする。
 * 文字層の取り出しは純 JS（外部 API なし）。失敗・文字なしは元の説明文のまま（fail-open）。最大10件。
 */
export async function enrichSummariesWithPdfAd(summaries: string[], pdfBase64List: Array<string | null>): Promise<string[]> {
  const AD_RE = /(?:^|\n)\s*(?:AD|ＡＤ|広告料)\s*[\d０-９]/;
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
        const line = ad.adMonths != null ? `AD ${String(ad.adMonths).replace(/\.0$/, "")}ヶ月` : ad.adYen != null ? `AD ${ad.adYen.toLocaleString()}円` : null;
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

/** 🌟 の順位付けに渡す文（DeepSeek と、失敗時の Claude で**同じ文**を使う） */
export function buildRankPrompt(summaries: string[], customerConditions?: string | null): string {
  const conditionsBlock = customerConditions
    ? `【お客様の希望条件（最優先で照らし合わせること）】\n${customerConditions}\n\n`
    : "";
  return `以下の物件一覧を見て、お客様に最もオススメの物件番号（1始まり）を選んでください。上位1〜3件をJSONで返してください。JSONのみ返すこと。

${conditionsBlock}判断基準（優先順位が高い順）:
1. お客様希望条件への合致度（最優先）:
   - 家賃が希望予算以内か
   - 間取りが希望と一致するか
   - 徒歩分数が希望以内か
   - 専有面積が希望以上か
   - 敷・礼が0ヶ月に近いほど良い（なし > 1ヶ月 > 2ヶ月以上）
   ※ 予算を大幅に超える・希望外間取りの物件は絶対に選ばないこと
2. AD（弊社の報酬・条件に合う物件の中では最も重視する）:
   - 「AD 2ヶ月」「AD 200%」以上 = 家賃×2ヶ月分以上の報酬（1 を満たす物件の中では必ず最上位に置く。3ヶ月以上ならさらに上）
   - 「AD 1ヶ月」「AD 100%」 = 家賃×1ヶ月分の報酬（AD なしより上）
   - 「AD 50,000円」のような円は家賃で割って月数に直す
   - AD記載なし = 報酬ゼロ（他の条件が同じなら AD ありを上に）
3. ㎡あたりの家賃（安いほど良い）
4. 間取りと面積の広さ（2LDK>1LDK>1DK>1K>1R、かつ㎡数が大きいほど良い）
5. 駅からの徒歩分数（近いほど良い）

${summaries.join('\n\n')}

例: {"recommended":[2,5]}`;
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
  //   推論モデルなので max_tokens は大きめ（小さいと推論で使い切って答えが空になる・property-image-read の罠）
  const { callDeepSeek, VISION_ALT_MODEL_DEFAULT } = await import("@/app/lib/vision-alt-provider");
  const startedAt = Date.now();
  const res = await callDeepSeek(null, prompt, { maxTokens: 4000, timeoutMs: 30_000, effort: "low" });
  const nums = res ? parseRankReply(res.text) : null;
  void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => {
    recordAltUsage({
      model: res?.model ?? VISION_ALT_MODEL_DEFAULT, action: "property_rank", conversationId: null,
      usage: { input_tokens: res?.usage.cacheMiss ?? 0, output_tokens: res?.usage.output ?? 0, cache_read_input_tokens: res?.usage.cacheHit ?? 0 },
      status: res ? 200 : 0, errorType: res ? (nums ? null : "empty_or_unparsable") : "no_response",
      durationMs: Date.now() - startedAt, sysHead: "【🌟 順位付け】" + prompt.slice(0, 120), sysKeyFull: null, maxTokens: 4000,
    });
  }).catch(() => {});
  return nums;
}

export async function rankAndAnnotateSummaries(summaries: string[], customerConditions?: string | null): Promise<string[]> {
  if (summaries.length <= 1) return summaries;
  try {
    const prompt = buildRankPrompt(summaries, customerConditions);
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
