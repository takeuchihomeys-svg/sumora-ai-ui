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
    // 見積金額内訳（「敷金50,000円」「家賃72,000円」「敷金1ヶ月分」等）→ AIX「見積書送る」ボタン専用
    // AIは物件資料・見積書の画像を読めないため、物件固有の金額・数値（家賃・管理費・割引額等）の生成は絶対禁止
    name: "見積金額内訳",
    test: (s) =>
      (/[0-9０-９][0-9０-９,，．.]*\s*(?:万\s*)?円/.test(s) &&
        /(?:初期費用|敷金|礼金|仲介手数料|保証料|鍵交換|火災保険|前?家賃|管理費|共益費|日割|御見積|お見積|見積|合計|総額|内訳|割引|スモ割|節約)/.test(s)) ||
      // 「敷金1ヶ月分」等の月数表記（円なし）も物件固有数値としてブロック
      (/[0-9０-９]+(?:[.．][0-9０-９]+)?\s*[ヶケか]月分?/.test(s) &&
        /(?:敷金|礼金|保証料|前家賃)/.test(s)),
    replacement: "最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！",
  },
  {
    // 物件固有金額（¥表記・「数万円」「〜万円」等の曖昧額の断定提示）→ AIX「見積書送る」ボタン専用
    // 上の「見積金額内訳」は数字+円/万円を検出するが、¥50,000 等の通貨記号表記と、
    // 「スモ割適用後の金額は〜万円となります」のような数字を伏せた断定文はすり抜けるためここで補完する。
    // 一般知識文（「敷金は1〜2ヶ月分が目安です」等）や金額を伴わない「家賃」単独では発火させない。
    name: "物件固有金額",
    test: (s) =>
      /(?:管理費|共益費|敷金|礼金|初期費用|合計|総額|スモ割)/.test(s) &&
      // ¥50,000・￥５万 等の通貨記号+数字表記
      (/[¥￥]\s*[0-9０-９][0-9０-９,，．.]*\s*万?/.test(s) ||
        // 「数万円」「〜万円」「約 万円」等、数字を伏せつつ物件固有額として断定する文
        // （目安・相場・一般的 等の一般知識マーカーがある文は除外）
        (/(?:数|[〜~～]|約\s*)万\s*円/.test(s) &&
          /(?:です|となります|になります|でございます|かかります|頂きます|いただきます)/.test(s) &&
          !/(?:目安|相場|一般的|通常|平均|多いです|ケースが|場合が)/.test(s))),
    replacement: "物件の詳細な費用は、スタッフが資料を確認してAIX【見積書送る】からお送りします！！",
  },
  {
    // 見積書カバー文（数字なしでも「御見積書となります」「ご査収ください」等で送付済みを装う文）
    // → AIX「見積書送る」ボタン専用。数字+円がなくても添付済みを偽装する文を止める
    name: "見積書カバー文",
    test: (s) =>
      /(?:御?見積書|お見積書)/.test(s) &&
      /(?:となります|同封|添付|ご査収|お送りしました|お送り致しました)/.test(s) &&
      !/作成|お送りさせて頂きます|お送りいたします/.test(s),
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

// ─── 物件固有金額のソース検証（テンプレート最適化モード用の軽量ポストチェック）───
// 【物件固有の金額・数値はAIが画像を見れないため生成禁止】
// AIは物件資料・見積書等の画像を読み取ることができない。そのため、家賃・管理費・敷金礼金・初期費用内訳・
// 合計金額・割引額など、物件固有の具体的な数値に関する質問には、AIが推測・生成して回答することを絶対禁止とする。
// これらの数値は必ずスタッフが画像を確認した上で、AIX（見積書送る／物件確認した等）から送付する。
// テンプレート最適化モードは aixGates を無効化しているため、出力中の「〜円」金額が
// スタッフ由来ソーステキスト（AIX物件情報・テンプレ原文等）に実在するかをここで機械検証する。
const normalizeAmountDigits = (s: string): string =>
  s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[,，]/g, "");

export function verifyAmountsAgainstSource(text: string, sourceText: string): { cleaned: string; unmatched: string[] } {
  const normalizedSource = normalizeAmountDigits(sourceText);
  const unmatched: string[] = [];
  const cleaned = text.replace(/[0-9０-９][0-9０-９,，]*円/g, (m) => {
    // 数字部分（円を除く）を半角・カンマなしに正規化してソース内に存在するか確認
    const digits = normalizeAmountDigits(m).slice(0, -1);
    if (normalizedSource.includes(digits)) return m; // ソースに実在 → 正当な金額
    unmatched.push(m);
    return "〇〇円"; // ソースに存在しない金額（ハルシネーション）→ 伏せ字に置換
  });
  return { cleaned, unmatched };
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
