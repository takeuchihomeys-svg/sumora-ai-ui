// app/lib/draft-bubbles.ts — 下書きを要件ごとの吹き出し（1通目・2通目）に分ける（純関数・DB/LLM なし）
//
// 2026-10-13 竹内さん（いしのまさや）「要件に合わせて文を分けて送る（1つに詰めない）」「まとめ方は実際の LINE を見れば分かる」:
//   竹内さんの実送信（scripts/audit-first-turn-split.ts・150日・お客様が物件を送った番 142）で2通に分けたのは、
//   送って頂いた物件の確認の約束と、ご条件で探す約束の両方をした番（b87d85・fb8043）。2通目はいつも「あわせまして／あわせて〈エリア〉周辺全域から…ピックアップ」で始まる。
//   → 下書きの中で「あわせまして／あわせて」で始まる行（行頭）が探す約束で、その前の部分が確認・見積の約束なら、そこで2通に分ける。
//   10/13 竹内さんの答え: ①1通で送った「確認の約束＋改行＋あわせて…ピックアップ」も2通に分ける ②空行の後の「初期費用も…抑え／割引」（ご希望を受ける一言）も2通目
//     それ以外（1通に収まる物・行の途中の「あわせて」・前に約束が無い）は分けない。
//   画面は今ある「2通目」の欄（extraDraftMessages・送ると時間差で別の吹き出し）に入れる。戻す: NEXT_PUBLIC_DRAFT_BUBBLES=off
// テスト: app/lib/__tests__/draft-bubbles.test.ts（実物の送信）

const SECOND_START_RE = /^(?:あわせまして|あわせて|併せまして|併せて|合わせまして|合わせて)[、,]?/;
const FIRST_PROMISE_RE = /(?:募集状況|空室状況|詳細)[^\n]{0,24}確認|御?見積書?[^\n]{0,24}(?:作成|お送り|ご用意|送らせ)|確認(?:出来|でき)次第/;
const SECOND_PICKUP_RE = /ピックアップ|お探し|探させ|ご紹介させて/;
// 10/13 竹内さん②: 2通目＝ご希望（初期費用を抑えたい・敷金礼金なし）を受ける一言（「初期費用も最大限割引させて頂き…抑えさせて頂きます」）
const WISH_START_RE = /^初期費用(?:も|につきましても|面も|につきましても)/;
const WISH_BODY_RE = /抑え|割引/;

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
    const isPickup = SECOND_START_RE.test(line), isWish = WISH_START_RE.test(line) && lines[i - 1].trim() === "";
    if (!isPickup && !isWish) continue;
    const first = lines.slice(0, i).join("\n").replace(/\s+$/, "");
    const second = lines.slice(i).join("\n").trim();
    if (first.trim().length < 10 || second.length < 10) continue;
    // 1通目は約束の形（「〜させて頂きます」「確認出来次第」）。「お送りさせて頂きました」（報告）だけの時は分けない（監査 7df536）
    if (!/させて(?:頂|いただ)きます|(?:出来|でき)次第|ご用意(?:いた|致)します/.test(first.normalize("NFKC"))) continue;
    if (!FIRST_PROMISE_RE.test(first.normalize("NFKC")) || !(isPickup ? SECOND_PICKUP_RE : WISH_BODY_RE).test(second)) continue;
    return [first, second];
  }
  return null;
}
