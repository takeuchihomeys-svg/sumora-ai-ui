// app/lib/pickup-line.ts
// AIX【物件ピックアップ】のピックアップ行に物件名を入れない（純関数・DB 依存なし）。
//
// 2026-09-17 竹内（✩ さん事例）「AIX物件オススメの生成された文で何故かへんな物件名が入ってしまった」
//
// 生成（aix_generate_log・action=property_send・13:00）:
//   「お世話になっております！！／堺筋本町・長堀橋周辺全域から広めで初期費用安いお部屋、
//     **堺筋本町・長堀橋・OPUS RESIDENCE SHINSAIBASHI SOUTHで**お客様にオススメできるお部屋ピックアップさせて頂きました！！／
//     お手隙の際にご査収ください😌！！」
// 実送信（13:01）:
//   「お世話になっております！！／堺筋本町・長堀橋周辺全域から広めで初期費用を抑える事が出来るお部屋
//     ピックアップさせて頂きました！！／お手隙の際にご査収ください😌！！」
//
// 原因: この生成の conditions_snapshot は {"psp":null,"customer_conditions":null}＝**条件の材料が空**。
//   指示は「エリア・条件を書く」と求めるので、LLM が会話から拾って埋めた。拾ったのは同じ会話で
//   02:17 に見積書を送った物件名（OPUS RESIDENCE SHINSAIBASHI SOUTH 302号室）。
//   さらにエリア（堺筋本町・長堀橋）を2回書いている。
//
// 実データ（365日・ピックアップ文363件）: ピックアップ行の型は例外なく
//   「[エリア]から[お客様名]さん(ご希望の)[条件]のお部屋ピックアップさせて頂きました！！」で、
//   ・号室 … **0件**
//   ・英大文字が2語以上続く固有名（OPUS RESIDENCE …）… **0件**
//     （ローマ字が入る13件は全てお客様名 1語＝YUMA・RYUSEI・AKANE・MATSUO・SATOKO・HONOKA…）
//   ・「マンション」を含む3件は「マンションタイプ」「鉄筋・鉄骨造マンション」＝物件の**種類**
//   ＝ピックアップ行に入るのはエリア・お客様名・条件だけ。物件名はカード側で書く。

/** ピックアップの宣言（この語から後ろは述部として残す） */
const PICKUP_VERB_RE = /ピックアップ(?:さ|し)|お送りさせて|お探しさせて/;
/** 物件名の印（会話から取れた名前が無い時の受け皿）。号室・英大文字2語以上の連なり */
const ROOM_NO_RE = /[0-9０-９]{2,4}\s*号室/;
const ROMAN_NAME_RE = /[A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,}){1,}/;

export type PickupLineResult = { text: string; removed: string[] };

/** 行が物件ピックアップの宣言行か */
function isPickupLine(line: string): boolean {
  return PICKUP_VERB_RE.test(line);
}

/** 節に物件名が入っているか（会話から取れた名前・号室・英大文字2語以上） */
function hasPropertyName(chunk: string, names: readonly string[]): boolean {
  if (ROOM_NO_RE.test(chunk) || ROMAN_NAME_RE.test(chunk)) return true;
  return names.some((n) => {
    const t = n.replace(/\s*[0-9０-９]{2,4}\s*号室\s*$/, "").trim();
    return t.length >= 3 && chunk.includes(t);
  });
}

/**
 * ピックアップ行から物件名の混ざった列挙を落とす。
 * 「A、B(物件名を含む)〜ピックアップさせて頂きました！！」→「A ピックアップさせて頂きました！！」
 * ・A が「お部屋」等の名詞で終わっていればそのまま述部に繋ぐ（実送信の形）
 * ・物件名が無ければ触らない
 * propertyNames は会話・送付済みから取れた物件名（無くても号室・英大文字2語で拾う）
 */
export function stripPropertyNameFromPickupLine(text: string, propertyNames: readonly string[] = []): PickupLineResult {
  const src = text ?? "";
  if (!src.trim()) return { text: src, removed: [] };
  const removed: string[] = [];
  const out = src.split("\n").map((line) => {
    if (!isPickupLine(line)) return line;
    const chunks = line.split(/(?<=[、,])/);
    if (chunks.length < 2) return line;
    // 述部（ピックアップ〜）を含む節を探す
    const lastIdx = chunks.findIndex((c) => PICKUP_VERB_RE.test(c));
    if (lastIdx <= 0) return line;
    const tailChunk = chunks[lastIdx];
    if (!hasPropertyName(tailChunk, propertyNames)) return line;
    // 述部の直前までを落とす（「堺筋本町・長堀橋・OPUS RESIDENCE SHINSAIBASHI SOUTHでお客様にオススメできるお部屋」）
    const vm = PICKUP_VERB_RE.exec(tailChunk);
    if (!vm) return line;
    const dropped = tailChunk.slice(0, vm.index).trim();
    if (!dropped) return line;
    removed.push(dropped);
    const head = chunks.slice(0, lastIdx).join("").replace(/[、,]\s*$/, "");
    const tail = tailChunk.slice(vm.index);
    return `${head}${tail}${chunks.slice(lastIdx + 1).join("")}`;
  }).join("\n");
  if (removed.length === 0) return { text: src, removed: [] };
  return { text: out, removed };
}

/** 生成の指示（ピックアップ行に物件名を入れさせない） */
export const PICKUP_LINE_NOTE = [
  "【ピックアップ行に物件名を書かない】",
  "・「〜ピックアップさせて頂きました！！」の行に入れてよいのは エリア・お客様名・ご希望条件（間取り・家賃・築年数・設備）だけ",
  "・物件名・号室（「OPUS RESIDENCE …」「〇〇マンション 302号室」）は書かない（物件名は同封する資料・物件カードで伝える）",
  "・エリアと条件は1回だけ書く（「〇〇周辺全域から…お部屋、〇〇・〇〇で…お部屋」のように重ねない）",
  "・条件が分からない時は「〇〇周辺全域から〇〇さんにオススメできるお部屋ピックアップさせて頂きました！！」で足りる（無い条件を会話から作らない）",
  "・実データ: ピックアップ文363件のうち、この行に号室が入った例は0件・英大文字2語以上の物件名が入った例は0件",
].join("\n");
