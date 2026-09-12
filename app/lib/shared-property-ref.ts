// app/lib/shared-property-ref.ts
// お客様が送ってきた物件の呼び方を「お送り頂きました物件（お部屋）」に揃える決定論の後処理（2026-09-12 竹内・YUYA 事例）。
//   お客様がポータルの共有文（「阪急神戸本線 十三 徒歩7分 1R 4万円 [詳細] https://…」）＋「ここはどうでしょうか？」を送った時、
//   下書きが「十三徒歩7分の物件、募集状況確認させて頂きます」と共有文の駅名・徒歩分で物件を呼んでいた（物件名ではないので違和感）。
//   実送信は「お送り頂きました物件の募集状況確認させて頂きます😊！！」。物件名・号室を書かない（竹内方針2）と同じ考えで、
//   共有文の駅名・徒歩分・家賃・間取り・建物名で物件を呼ばない。
//   生成（プロンプトの指示）に任せず、validateAndClean・final-check の修正版が通る applySurfaceFixes で置き換える（禁止語と同じ設計）。
// 依存なし（validate-reply から使う）。

/** ポータルの共有文の形（徒歩N分 と 家賃 N万円 が近くにある） */
const LISTING_SHAPE_RE = /徒歩\s*[0-9０-９]+\s*分[\s\S]{0,60}?[0-9０-９.．]+\s*万円|[0-9０-９.．]+\s*万円[\s\S]{0,60}?徒歩\s*[0-9０-９]+\s*分/;

/** お客様の連投に物件そのもの（URL・画像・ポータルの共有文）が含まれるか */
export function customerSharedProperty(customerTurn: string | null | undefined): boolean {
  const t = customerTurn ?? "";
  return /https?:\/\//.test(t) || /\[画像\]/.test(t) || LISTING_SHAPE_RE.test(t);
}

/** 共有文から、物件の呼び名に使われうる語（駅名・路線・徒歩分・家賃・間取り・建物名）を取り出す */
function listingTokens(customerTurn: string): string[] {
  const t = customerTurn.replace(/https?:\/\/\S+/g, " ");
  const out = new Set<string>();
  // 「十三 徒歩7分」「十三駅徒歩7分」の駅名
  for (const m of t.matchAll(/([^\s、。,\n\[\]「」]{1,10}?)駅?\s*(?:から)?\s*徒歩/g)) {
    const s = m[1].replace(/^(?:阪急|阪神|JR|ＪＲ|京阪|近鉄|南海|大阪メトロ|地下鉄)/, "");
    if (s.length >= 2 || /[一-龯]/.test(s)) out.add(s);
  }
  for (const m of t.matchAll(/[^\s、。,\n]{2,16}線/g)) out.add(m[0]);
  for (const m of t.matchAll(/徒歩\s*[0-9０-９]+\s*分/g)) out.add(m[0].replace(/\s+/g, ""));
  for (const m of t.matchAll(/[0-9０-９.．]+\s*万円?/g)) out.add(m[0].replace(/\s+/g, ""));
  for (const m of t.matchAll(/[1-9１-９](?:SLDK|LDK|SDK|DK|K|R)/g)) out.add(m[0]);
  for (const m of t.matchAll(/[ァ-ヶー・A-Za-zＡ-Ｚａ-ｚ]{3,}/g)) if (!/^(?:https?|www|com|nifty|suumo|homes|athome)$/i.test(m[0])) out.add(m[0]);
  return [...out].filter((x) => x.length >= 1);
}

/** 呼び名に使われる一般的な描写（共有文に無くても「〇〇徒歩N分の物件」は物件の呼び名として不自然） */
const GENERIC_DESCRIPTOR_RE = /徒歩\s*[0-9０-９]+\s*分|[0-9０-９.．]+\s*万円|[1-9１-９](?:SLDK|LDK|SDK|DK|K|R)(?![a-zA-Z])/;

/**
 * お客様が物件を送ってきた連投への返信で、「（駅名・徒歩分・家賃・間取り・建物名）の物件／お部屋」を「お送り頂きました物件／お部屋」に置き換える。
 * 例: 「十三徒歩7分の物件、募集状況確認させて頂きます」→「お送り頂きました物件、募集状況確認させて頂きます」
 * 置き換えない: 「お送り頂きました物件」「新着の物件」「ご希望条件のお部屋」など共有文の語を含まない呼び方
 */
export function normalizeSharedPropertyReference(text: string, customerTurn: string | null | undefined): { text: string; count: number } {
  if (!text || !customerSharedProperty(customerTurn)) return { text, count: 0 };
  const tokens = listingTokens(customerTurn ?? "");
  let count = 0;
  // 置き換える範囲は描写の文字（漢字・カタカナ・英数字・記号・「の」「から」）だけ。ひらがなの語（かしこまりました 等）は巻き込まない
  const out = text.replace(/((?:[一-龯々〆ヵヶァ-ヺー・A-Za-zＡ-Ｚａ-ｚ0-9０-９.．/／\-〜～]|の|から){2,30}?)の(物件|お部屋|部屋)/g, (whole, span: string, noun: string, offset: number, all: string) => {
    if (/お送り(?:頂|いただ)き|お送り(?:頂|いただ)い|ご紹介|オススメ|おすすめ|新着|ご希望|ご条件|条件に/.test(span)) return whole;
    const hit = GENERIC_DESCRIPTOR_RE.test(span) || tokens.some((k) => k.length >= 2 && span.includes(k));
    if (!hit) return whole;
    const nounOut = noun === "部屋" ? "お部屋" : noun;
    const before = all.slice(Math.max(0, offset - 16), offset);
    const sentenceRest = all.slice(offset + whole.length).split(/[。！!？?\n]/)[0] ?? "";
    // 同じ文の後ろで「お送り頂きありがとうございます」と受けている → 置き換えると「お送り頂きました物件…お送り頂き」と重なるので触らない
    if (/お送り(?:頂|いただ)き/.test(sentenceRest)) return whole;
    count++;
    // 直前が既に「お送り頂きました」（スタッフ実文「お送り頂きました園田1LDK3階のお部屋」）→ 描写だけ外す
    if (/お送り(?:頂|いただ)(?:きました|いた)\s*$/.test(before)) return nounOut;
    return `お送り頂きました${nounOut}`;
  });
  return { text: out, count };
}
