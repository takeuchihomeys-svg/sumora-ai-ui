// 送信前の未置換プレースホルダーを検出（送信ブロック用）
const PLACEHOLDER_ALLOWLIST = new Set(["[画像]", "[動画]", "[スタンプ]"]);

export function detectPlaceholders(text: string): string[] {
  const found = new Set<string>();
  // [日付] [物件名] [名前] など半角角括弧（20文字以内・改行なし）
  for (const m of text.matchAll(/\[[^\[\]\n]{1,20}\]/g)) {
    if (!PLACEHOLDER_ALLOWLIST.has(m[0])) found.add(m[0]);
  }
  // {name} {日付} など波括弧型
  for (const m of text.matchAll(/\{[^{}\n]{1,20}\}/g)) found.add(m[0]);
  // 〇〇・○○ 伏せ字型（2文字以上連続）
  for (const m of text.matchAll(/[〇○]{2,}/g)) found.add(m[0]);
  return [...found];
}

// ─── AIX専用コンテンツのハードゲート（生成後の機械検証）───
// enforcement_level='required' 等のAIX判定時もプロンプト指示（viewingFactNote / estimateGateNote /
// propertyFactGateNote / meetingPlaceGateNote）はLLMへの指示に過ぎず、無視された場合を止められない。
// ここで生成後テキストを文単位で検査し、違反文を許可済みの宣言テンプレに置換する最終防衛線。
const AIX_GATE_RULES: { name: string; test: (s: string) => boolean; replacement: string }[] = [
  {
    // 内覧候補日時の具体提示（「8/7（木）14:00〜」等）→ AIX「内覧へ」ボタン専用
    name: "内覧候補日時",
    test: (s) =>
      /[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}/.test(s) &&
      /(?:[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}\s*時|午前|午後)\s*[〜~～-]?/.test(s) &&
      /(?:内覧|内見|見学|ご案内|ご都合|いかが|ご希望|空いて)/.test(s),
    replacement: "お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！",
  },
  {
    // 見積金額内訳（「敷金50,000円」等）→ AIX「見積書送る」ボタン専用
    name: "見積金額内訳",
    test: (s) =>
      /[0-9０-９][0-9０-９,，．.]*\s*(?:万\s*)?円/.test(s) &&
      /(?:初期費用|敷金|礼金|仲介手数料|保証料|鍵交換|火災保険|前家賃|日割|御見積|お見積|見積|合計|総額|内訳)/.test(s),
    replacement: "最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！",
  },
  {
    // 住所・集合場所・集合時間の確定文 → AIX「待ち合わせ」ボタン専用
    name: "待ち合わせ確定",
    test: (s) =>
      /(?:エントランス|集合場所|現地集合|待ち合わせ場所)/.test(s) &&
      /(?:丁目|番地|〒|[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}\s*時)/.test(s),
    replacement: "内覧の詳細についてはご連絡させて頂きます！！",
  },
  {
    // 管理会社確認結果の断言（「空室でした」「埋まってしまいました」等）→ AIX「物件確認した」系ボタン専用
    name: "確認結果断言",
    test: (s) =>
      /(?:空室でした|空室と確認|空室を確認|空いておりました|募集中と確認|埋まって(?:しまいました|しまっており|おりました|しまったよう)|退去日は\s*[0-9０-９]|から(?:ご)?入居可能です)/.test(s),
    replacement: "確認しご連絡させて頂きます😊！！",
  },
];

export function enforceAixGates(text: string): { cleaned: string; violations: string[] } {
  const violations: string[] = [];
  const usedReplacement = new Set<string>();
  const outLines = text.split("\n").map((line) => {
    // 文末（。！!？?）で分割。「！！」等の連続記号は1文として保持する
    const sentences = line.split(/(?<=[。！!？?])(?![。！!？?])/);
    const outSentences: string[] = [];
    for (const s of sentences) {
      const rule = AIX_GATE_RULES.find((r) => r.test(s));
      if (!rule) {
        outSentences.push(s);
        continue;
      }
      violations.push(`${rule.name}: ${s.trim().slice(0, 40)}`);
      // 同一ルールの違反が複数文ある場合、宣言テンプレは1回だけ挿入し残りは除去（内訳の複数行等）
      if (!usedReplacement.has(rule.name)) {
        usedReplacement.add(rule.name);
        outSentences.push(rule.replacement);
      }
    }
    return outSentences.join("");
  });
  // 違反行の除去で生じた3連以上の改行を2連（空行1つ）に圧縮
  const cleaned = violations.length > 0
    ? outLines.join("\n").replace(/\n{3,}/g, "\n\n")
    : text;
  return { cleaned, violations };
}

export function validateAndClean(text: string, opts?: { aixGates?: boolean }): { cleaned: string; issues: string[] } {
  const issues: string[] = []
  let cleaned = text
  // **太字** → 太字なしに除去
  if (/\*\*[^*]+\*\*/.test(cleaned)) {
    issues.push("マークダウン太字(**)")
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1")
  }
  // さんさん → さん
  if (/さんさん/.test(cleaned)) {
    issues.push("敬称重複(さんさん)")
    cleaned = cleaned.replace(/さんさん/g, "さん")
  }
  // プレースホルダー残存チェック（削除はしない・issuesに追加のみ）
  const placeholders = detectPlaceholders(cleaned);
  if (placeholders.length > 0) issues.push("プレースホルダー残存: " + placeholders.join(" "));
  // 禁止ワード
  const banned = ["コスパ", "少々お待ちください", "共益費込み"]
  banned.forEach(w => { if (cleaned.includes(w)) issues.push("禁止ワード: " + w) })
  // AIXゲート機械検証（opt-in: generate-reply の通常返信ドラフトのみ。テンプレート最適化・パターン生成は対象外）
  if (opts?.aixGates) {
    const { cleaned: gated, violations } = enforceAixGates(cleaned);
    if (violations.length > 0) {
      issues.push(...violations.map(v => "AIXゲート違反(置換済): " + v));
      cleaned = gated;
    }
  }
  return { cleaned, issues }
}
