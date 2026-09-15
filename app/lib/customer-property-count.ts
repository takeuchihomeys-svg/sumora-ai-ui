// app/lib/customer-property-count.ts
// 2026-09-15 竹内（みく事例）「AIX の物件確認したの送られた物件数を判断する。間違えがあれば入れる」:
//   お客様の最新の発言（最後のスタッフ発言より後の連投。最後がスタッフならその前の連投）で送られた物件の数を数える。
//   物件の URL（1通に複数あれば URL の数。アプリの案内リンクは数えない）＋お客様の画像（スクショ）。
//   1件も無い（「こちら3階は空きありますか？」のように既に話題の物件への質問）は数えない＝basis none（画面は空欄のまま）。
//   依存ゼロ（画面から使う）

type Msg = { sender?: string | null; text?: string | null };

/** 物件ではないリンク（アプリの案内・LINE の友だち追加など） */
const NON_PROPERTY_URL_RE = /\/apps?\/?(?:$|[?#])|(?:^|\/\/)(?:line\.me|lin\.ee|apps\.apple\.com|play\.google\.com)\b/i;
const URL_RE = /https?:\/\/[^\s）)」』]+/g;
const IMAGE_RE = /^\s*\[画像\]/;

function latestCustomerTurn(messagesOldestFirst: ReadonlyArray<Msg>): Msg[] {
  const msgs = messagesOldestFirst.filter((m) => !!(m.text ?? "").trim());
  let end = msgs.length - 1;
  while (end >= 0 && msgs[end].sender !== "customer") end--;
  if (end < 0) return [];
  let start = end;
  while (start - 1 >= 0 && msgs[start - 1].sender === "customer") start--;
  return msgs.slice(start, end + 1);
}

/** お客様の最新の発言で送られた物件の数（最大5）。basis: url / image / mixed / none */
export function countCustomerSentProperties(messagesOldestFirst: ReadonlyArray<Msg>): { count: number; basis: "url" | "image" | "mixed" | "none" } {
  let urls = 0;
  let images = 0;
  for (const m of latestCustomerTurn(messagesOldestFirst)) {
    const t = m.text ?? "";
    if (IMAGE_RE.test(t)) { images++; continue; }
    const found = [...new Set((t.match(URL_RE) ?? []).filter((u) => !NON_PROPERTY_URL_RE.test(u)))];
    urls += found.length;
  }
  const count = Math.min(5, urls + images);
  const basis = count === 0 ? "none" : urls > 0 && images > 0 ? "mixed" : urls > 0 ? "url" : "image";
  return { count, basis };
}
