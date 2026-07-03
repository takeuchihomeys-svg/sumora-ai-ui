export function validateAndClean(text: string): { cleaned: string; issues: string[] } {
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
  if (/〇〇|○○/.test(cleaned)) issues.push("〇〇プレースホルダー残存")
  if (/\[日付\]|\[時間帯\]|\[物件名\]/.test(cleaned)) issues.push("角括弧プレースホルダー残存")
  // 禁止ワード
  const banned = ["コスパ", "少々お待ちください", "共益費込み"]
  banned.forEach(w => { if (cleaned.includes(w)) issues.push("禁止ワード: " + w) })
  return { cleaned, issues }
}
