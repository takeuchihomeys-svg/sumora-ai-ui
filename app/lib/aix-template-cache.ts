// app/lib/aix-template-cache.ts
// AIX の文作り（/api/aix-template-generate・名札 aix_template）のプロンプトキャッシュを効かせるための純関数。
// 送る中身（どの原則・どのルールを入れるか）は1つも変えない。変えるのは「同じ物の並びを毎回同じにする」と「キャッシュの寿命」だけ。
//
// 2026-10-08 竹内「ブレインのところ更にキャッシュ効けるところはみつかっていないのかな？質重視で」:
//   本番 8.6日（9/29〜10/08・env=production・Sonnet 5.5）で aix_template は 100回 $19.8（DB 単価・月 約 $69）＝
//   ブレイン毎回の分析に次ぐ2番目の費用。命中 24%、鍵（system 全文のハッシュ）が 37種類。
//   ①同じ日・入力トークン数が1つも違わないのに鍵だけ違う組が並んでいた（10/04 86,098 で4鍵・10/06 88,000 で4鍵・10/02 85,435 で4鍵）
//     ＝同じ中身が並びだけ揺れている。出所は「絶対原則」（ai_reply_knowledge principle・importance 降順・上位12件）で、
//     今は importance 10 の行がちょうど12件＝全部同点。並びの指定が importance だけなので、更新の多い表（41万回更新）の
//     物理的な並びで毎回入れ替わる → 第2ブロック（DB 由来）の鍵が割れる。
//   ②呼び出しの間隔は 5分未満24回・5〜60分52回・60分超24回。5分の寿命では 52回が毎回 約86k を書き直していた。
//   同じ実物で計算（scripts/audit-aix-template-cache.ts）: 今 $16.70 → 1h だけ $13.12 → 1h＋並びの固定 $11.36（月 約 −$18.6・DB 単価）。
//   並びの固定だけ（5分のまま）は $16.70 で変わらない（間隔が5分を超えるため）＝2つ揃えて効く。

/** 絶対原則・失注パターンの1行（prompt-cache の KnowledgeItem と同じ形） */
export type AixKnowledgeItem = { id: string; title?: string | null; content: string; importance: number };

/**
 * 同じ集まりなら毎回同じ並びにする（importance 降順＝DB と同じ主の並び → 同点は id 昇順）。
 * 入れる物は変えない（足さない・抜かない・文を変えない）。元の配列は変えない。
 * AIX_TEMPLATE_PRINCIPLE_ORDER=db で DB が返した並びのまま（旧）。
 */
export function stableKnowledgeOrder<T extends AixKnowledgeItem>(items: readonly T[], env: Record<string, string | undefined> = process.env): T[] {
  if ((env.AIX_TEMPLATE_PRINCIPLE_ORDER ?? "").trim().toLowerCase() === "db") return [...items];
  return [...items].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 第2システムブロック（DB 学習資産）の文字列。文面は 2026-10-08 以前の route.ts の組み立てと1文字も同じ
 * （並びだけ stableKnowledgeOrder で固定する）。
 */
export function buildAixTemplateDbKnowledgeBlock(
  topPrinciples: readonly AixKnowledgeItem[],
  lossPatterns: readonly AixKnowledgeItem[],
  dbRules: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const principles = stableKnowledgeOrder(topPrinciples, env);
  const losses = stableKnowledgeOrder(lossPatterns, env);
  return [
    principles.length > 0
      ? "【📌 絶対原則（DB学習・全顧客共通・常時遵守）】\n" +
        principles.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n")
      : "",
    losses.length > 0
      ? "【🚫 避けるべき対応（失注実例より）】\n" +
        losses.map((p, i) => `${i + 1}. ${p.content}`).join("\n")
      : "",
    dbRules ? dbRules.trim() : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * system の2ブロックのキャッシュの寿命。既定 1h（AIX_TEMPLATE_CACHE_TTL=5m で旧）。
 * 中身が変われば寿命に関係なく外れるので、古い中身を使い回す事は無い（鮮度は変わらない）。
 * 1h の損益分岐は「次の呼び出しが5〜60分後に来る率」。2026-09-17 は3日に1回で 5m が得だったが、
 * 10/08 の実測は1日 約12回・5〜60分の間隔が 52%。
 */
export function aixTemplateCacheTtl(env: Record<string, string | undefined> = process.env): "5m" | "1h" {
  return (env.AIX_TEMPLATE_CACHE_TTL ?? "").trim().toLowerCase() === "5m" ? "5m" : "1h";
}
