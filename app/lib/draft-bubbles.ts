// app/lib/draft-bubbles.ts — 下書きを要件ごとの吹き出し（1通目・2通目）に分ける（純関数・DB/LLM なし）
//
// 2026-10-13 竹内さん（いしのまさや）「要件に合わせて文を分けて送る（1つに詰めない）」「まとめ方は実際の LINE を見れば分かる」:
//   竹内さんの実送信（scripts/audit-first-turn-split.ts・150日・お客様が物件を送った番 142）で2通に分けたのは、
//   送って頂いた物件の確認の約束と、ご条件で探す約束の両方をした番（b87d85・fb8043）。2通目はいつも「あわせまして／あわせて〈エリア〉周辺全域から…ピックアップ」で始まる。
//   → 下書きの中で「あわせまして／あわせて」で始まる行（空行の後・行頭）が探す約束で、その前の部分が確認・見積の約束なら、そこで2通に分ける。
//     それ以外（1通に収まる物・行の途中の「あわせて」・前に約束が無い）は分けない。
//   画面は今ある「2通目」の欄（extraDraftMessages・送ると時間差で別の吹き出し）に入れる。戻す: NEXT_PUBLIC_DRAFT_BUBBLES=off
// テスト: app/lib/__tests__/draft-bubbles.test.ts（実物の送信）

const SECOND_START_RE = /^(?:あわせまして|あわせて|併せまして|併せて|合わせまして|合わせて)[、,]?/;
const FIRST_PROMISE_RE = /(?:募集状況|空室状況|詳細)[^\n]{0,24}確認|御?見積書?[^\n]{0,24}(?:作成|お送り|ご用意|送らせ)|確認(?:出来|でき)次第/;
const SECOND_PICKUP_RE = /ピックアップ|お探し|探させ|ご紹介させて/;

// 画面（クライアント）では process.env.NEXT_PUBLIC_* を字のまま書かないと埋め込まれない
export function draftBubblesEnabled(env: Record<string, string | undefined> = { NEXT_PUBLIC_DRAFT_BUBBLES: process.env.NEXT_PUBLIC_DRAFT_BUBBLES }): boolean {
  return (env.NEXT_PUBLIC_DRAFT_BUBBLES ?? "").trim().toLowerCase() !== "off";
}

/** 2通に分ける所があれば [1通目, 2通目]、無ければ null */
export function splitDraftBubbles(draft: string | null | undefined): [string, string] | null {
  const text = String(draft ?? "");
  if (!text.trim()) return null;
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!SECOND_START_RE.test(line)) continue;
    const first = lines.slice(0, i).join("\n").replace(/\s+$/, "");
    const second = lines.slice(i).join("\n").trim();
    if (first.trim().length < 10 || second.length < 10) continue;
    if (!FIRST_PROMISE_RE.test(first.normalize("NFKC")) || !SECOND_PICKUP_RE.test(second)) continue;
    return [first, second];
  }
  return null;
}
