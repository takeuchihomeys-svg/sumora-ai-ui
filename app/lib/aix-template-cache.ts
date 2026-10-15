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

/**
 * 2026-10-15 竹内「キャッシュの見直し。質が落ちないように改善する形で」（AIX の2通目）:
 *   後ろのブロック（DB 由来・24〜33k）を、変わる単位で3つに分ける（中身・並びは1文字も変えない＝3つを "" で繋ぐと旧の1ブロックと同じ文字列）。
 *     global … 絶対原則＋失注（全員・全ボタンで同じ。DB の学習で日に1回程度変わる）
 *     state  … generate_reply＋全体のルール（会話の状態で変わる）
 *     action … ボタン別のルール（LEARN-AIX 含む・ボタン×状態で変わる）
 *   旧は1つの印で、ボタンか状態のどちらかが前の呼び出しと違うだけで後ろを丸ごと書き直していた。
 *   分けると、ボタン・状態が違っても global（と同じ状態なら state）は読める。印は先頭ブロック＋3つ＝4つ（上限）。
 *   区切りの文字（"\n\n"・"\n"）は後ろのブロックの先頭に付ける（ブロックの末尾に空白を残さない）。
 *   分けられない形（片方が空・境目が trim で消える）は1ブロック（旧と同じ）。AIX_TEMPLATE_BLOCK_SPLIT=off で旧（1ブロック）。
 */
export type AixDbKnowledgePart = { kind: "global" | "state" | "action" | "all"; text: string };

export function aixTemplateBlockSplitEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AIX_TEMPLATE_BLOCK_SPLIT ?? "").trim().toLowerCase() !== "off";
}

export function aixTemplateDbKnowledgeParts(
  topPrinciples: readonly AixKnowledgeItem[],
  lossPatterns: readonly AixKnowledgeItem[],
  dbRulesGeneric: string,
  dbRulesAction: string,
  env: Record<string, string | undefined> = process.env,
): AixDbKnowledgePart[] {
  const raw = [dbRulesGeneric, dbRulesAction].filter(Boolean).join("\n");
  const whole = buildAixTemplateDbKnowledgeBlock(topPrinciples, lossPatterns, raw, env);
  if (!whole) return [];
  const one: AixDbKnowledgePart[] = [{ kind: "all", text: whole }];
  if (!aixTemplateBlockSplitEnabled(env)) return one;
  const g = buildAixTemplateDbKnowledgeBlock(topPrinciples, lossPatterns, "", env);
  const r = raw.trim();
  if (!g || !r) return one;
  const parts: AixDbKnowledgePart[] = [{ kind: "global", text: g }];
  const lead = raw.length - raw.trimStart().length;
  // r の中で action が始まる位置（generic と action の間の "\n" の次）
  const idx = dbRulesGeneric && dbRulesAction ? dbRulesGeneric.length + 1 - lead : -1;
  const st = idx > 1 ? r.slice(0, idx - 1) : "";
  const ac = idx > 1 ? r.slice(idx) : "";
  if (st.trim() && ac.trim() && r.charAt(idx - 1) === "\n") {
    parts.push({ kind: "state", text: `\n\n${st}` }, { kind: "action", text: `\n${ac}` });
  } else {
    parts.push({ kind: dbRulesAction && !dbRulesGeneric ? "action" : "state", text: `\n\n${r}` });
  }
  // ブロックの末尾の空白は次のブロックの先頭へ送る（繋いだ文字列は同じ・ブロックが空白で終わらない）
  for (let i = 0; i < parts.length - 1; i++) {
    const core = parts[i].text.trimEnd();
    if (core.length < parts[i].text.length) { parts[i + 1].text = parts[i].text.slice(core.length) + parts[i + 1].text; parts[i].text = core; }
  }
  // 安全網: 繋いで旧の1ブロックと1文字も違わない時だけ分ける（空白だけのブロックも作らない）
  return parts.map((p) => p.text).join("") === whole && parts.every((p) => p.text.trim()) ? parts : one;
}

/**
 * 温め（prefix-warm・aix_template_warm）用: ボタンに依らない後ろのブロック（global＋state）を、ボタン別のルールがある本物と同じ形で作る。
 *   本物は action が空でない時 state を generic.trimStart() で切る → ここでも「action あり」の形で切って action を捨てる（同じ関数・同じ文字列）。
 *   分けない設定（AIX_TEMPLATE_BLOCK_SPLIT=off）や分けられない形の時は [] ＝先頭ブロックだけ温める（旧）。
 */
export function aixTemplateSharedParts(
  topPrinciples: readonly AixKnowledgeItem[],
  lossPatterns: readonly AixKnowledgeItem[],
  dbRulesGeneric: string,
  env: Record<string, string | undefined> = process.env,
): AixDbKnowledgePart[] {
  const parts = aixTemplateDbKnowledgeParts(topPrinciples, lossPatterns, dbRulesGeneric, "x", env);
  if (parts.length === 3 && parts[0].kind === "global" && parts[1].kind === "state") return parts.slice(0, 2);
  if (parts.length === 2 && parts[0].kind === "global" && parts[1].kind === "action") return parts.slice(0, 1); // 全体のルールが空
  return [];
}
