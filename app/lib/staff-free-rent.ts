// app/lib/staff-free-rent.ts（純関数・DB/ネットに触れない）
// フリーレントは「スタッフが送った文に書いた物件だけ」を事実にする。
//
// 2026-10-08 竹内（8巡目・最優先）「フリーレントは全部の物件につくわけではない。資料にフリーレントの項目が書かれていて間違えて読み取ってしまう
//   可能性があるので要注意。フリーレントかどうかの判断は、AIX で物件オススメする際スタッフが入れていたらフリーレントなので、その物件はフリーレントと
//   保管していれば間違えることないし質が上がる、その方向でいく」
//   ・資料（pdf_text・image_lines・terms.freeRent）からは読まない（「フリーレント」の項目名・空欄・キャンペーン終了の備考を誤読する）
//   ・保管＝こちらが送った文そのもの（messages の staff の行・AIX の物件オススメ／物件確認した／手打ち）。物件ごとに読み直す＝過去の送付も同じ関数で拾える（埋める SQL は要らない）
//   実物（scripts/audit-r8-free-rent.ts・180日 staff の「フリーレント」62通・AIX 22通）:
//     付く   「・フリーレント1ヶ月（家賃1ヶ月分免除）」「新築物件フリーレントで家賃1ヶ月分免除」「フリーレントキャンペーンの為ご入居後家賃1ヶ月分免除」
//     相談   「・フリーレント相談可」「フリーレント1ヶ月相談可」「フリーレント交渉可能」「フリーレントもつけられるお部屋」
//     無い   「管理会社に確認させていただきましたが、現在フリーレント対応はしていないとのことです」
//     別の話 「フリーレント付きのお部屋も含めてピックアップ」「フリーレント物件も含めて」（探す約束・条件）＝物件の事実ではない
// 戻す: STAFF_FREE_RENT=off（資料から読む旧の道ではなく、フリーレントに触れない＝確認に倒す）

export type FreeRentKind = "yes" | "negotiable" | "none";
export type StaffFreeRentFact = {
  /** 物件の名前（🌟の見出し・文の中の「建物 101号室」）。決まらなければ null（その送信の物件が1つの時はそれ） */
  property: string | null;
  kind: FreeRentKind;
  /** スタッフの文のまま（1行） */
  phrase: string;
  at: string | null;
};

const NOT_FACT_RE = /探|ピックアップ|含め|限り|というご条件|ご要望は|物件(?:も|を|で)|お部屋も|交渉させ(?:て)?(?:頂|いただ)きます|確認させ(?:て)?(?:頂|いただ)きます|でしょうか|ですか|ますか/;
const NONE_RE = /(?:フリーレント)[^。\n]{0,24}(?:していない|しておりません|考えていない|実施していない|対応はしていない|対応していない|ございません|無し|なし|不可|出来ない|できない)|(?:管理会社|貸主|交渉|確認)[^。\n]*(?:していない|考えていない|実施していない|しておりません)/;
const NEGOTIABLE_RE = /相談も可能|ご相談も|相談可|交渉可|相談(?:出来|でき)|交渉(?:出来|でき)|つけられる|付けられる|つけれる|付けれる|をつけ(?:る事|ること)が(?:出来|でき)/;

const STAR_HEAD_RE = /^\s*[🌟⭐★☆]\s*(.+?)\s*$/u;
const ROOM_LABEL_RE = /([^\s、。！!（）()【】・「」]{2,30}?)\s*([0-9０-９]{2,5}[A-Za-z]?)\s*(?:号室|号)?(?=$|[\s、。！!が・は（(の])/u;

/** 見出し（🌟〇〇 101号室）から物件の名前（「〇〇 101号室」）。見積書の「🌟26,500円割引」・「🌟1件新着で…」は名前にしない */
export function starPropertyLabel(line: string): string | null {
  const m = STAR_HEAD_RE.exec(String(line ?? ""));
  if (!m) return null;
  const body = m[1].normalize("NFKC");
  if (/円|割引|新着|キャンペーン|フリーレント|オススメ|お部屋/.test(body)) return null;
  // 末尾の号室（「Avantio Anhelo(アバンティオアネーロ) 202号室」＝建物名に括弧・空白があっても）→ 文の中の号室 → 建物名だけ
  const tail = /^(.*?\S)\s*([0-9]{2,5}[A-Za-z]?)\s*(?:号室?)?\s*$/.exec(body);
  if (tail && tail[1].length >= 2) return `${tail[1].trim()} ${tail[2]}号室`;
  const r = ROOM_LABEL_RE.exec(body);
  if (r) return `${r[1].trim()} ${r[2]}号室`;
  return body.length <= 40 ? body.trim() : null;
}

/** 文の中の「建物 101号室」（最初の1つ） */
function inlineLabel(line: string): string | null {
  const t = String(line ?? "").normalize("NFKC");
  const m = /([A-Za-zァ-ヶー・'’一-鿿0-9 .]{2,30}?)\s*([0-9]{2,5})\s*号室/.exec(t);
  return m ? `${m[1].trim().replace(/^(?:特に|中でも|でも|も|の|は)/, "")} ${m[2]}号室` : null;
}

/**
 * スタッフの1通からフリーレントの事実を拾う。🌟の見出しから次の🌟までを1つの物件のまとまりとして読み、
 * まとまりの外の行は同じ行の「建物 101号室」・無ければその通の唯一の🌟の物件。
 */
export function freeRentFactsFromStaffText(text: string | null | undefined, at: string | null = null): StaffFreeRentFact[] {
  if ((typeof process !== "undefined" ? process.env.STAFF_FREE_RENT : undefined) === "off") return [];
  const lines = String(text ?? "").split(/\n/);
  if (!lines.some((l) => /フリーレント/.test(l))) return [];
  const stars = lines.map(starPropertyLabel).filter((x): x is string => !!x);
  const single = stars.length === 1 ? stars[0] : null;
  const out: StaffFreeRentFact[] = [];
  let current: string | null = null;
  for (const raw of lines) {
    const head = starPropertyLabel(raw);
    if (head) { current = head; }
    if (!/フリーレント/.test(raw)) continue;
    const line = raw.trim();
    const kind: FreeRentKind | null = NONE_RE.test(line) && !/フリーレント(?:あり|有り|付き|つき)/.test(line) ? "none" : NOT_FACT_RE.test(line) ? null : NEGOTIABLE_RE.test(line) ? "negotiable" : "yes";
    if (!kind) continue;
    const property = current ?? inlineLabel(line) ?? single;
    out.push({ property, kind, phrase: line.slice(0, 120), at });
  }
  return out;
}

/** 会話のスタッフの文（古い順）から、物件ごとの一番新しいフリーレントの事実 */
export function collectStaffFreeRent(staffMessages: ReadonlyArray<{ text: string | null; createdAt?: string | null }>): StaffFreeRentFact[] {
  const byKey = new Map<string, StaffFreeRentFact>();
  for (const m of staffMessages) for (const f of freeRentFactsFromStaffText(m.text, m.createdAt ?? null)) byKey.set(propertyKey(f.property), f);
  return [...byKey.values()];
}

/** 物件の名前の比べ方（空白・記号・号室・先頭の0を外す） */
export function propertyKey(name: string | null | undefined): string {
  return String(name ?? "").normalize("NFKC").replace(/号室?/g, "").replace(/[\s　・,.'’\-ー()（）【】🌟★☆]/gu, "").replace(/(?<=\D)0+(?=\d)/g, "").toLowerCase();
}

/** 物件（名前・号室）のフリーレントの事実。建物名の頭が合えば同じ物件とみなす（号室があれば号室も合う物） */
export function staffFreeRentFor(facts: ReadonlyArray<StaffFreeRentFact>, name: string, roomNo: string | null): StaffFreeRentFact | null {
  const nk = propertyKey(name);
  const rk = String(roomNo ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+/, "");
  const base = nk.slice(0, Math.min(6, nk.length));
  const hits = facts.filter((f) => {
    const fk = propertyKey(f.property);
    if (!fk || base.length < 2 || !fk.startsWith(base)) return false;
    if (!rk) return true;
    // 号室は元の名前の末尾の「 706号室」から（記号を外した鍵では建物名の数字とくっつく＝「Luxe難波西2 706」→「2706」）
    const fr = /(?:^|[\s　])([0-9０-９]{2,5})\s*(?:号室?)?\s*$/.exec(String(f.property ?? "").normalize("NFKC"))?.[1]?.replace(/^0+/, "") ?? "";
    return !fr || fr === rk;
  });
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * 出口（最終チェック）: 下書きがフリーレントを「付く」と言っているのに、この会話でスタッフがフリーレントを書いた物件が1つも無い時の文。
 * 探す約束・条件の言い直し・質問・確認の約束・「無い」は対象外。当たった文を返す（無ければ null）
 */
const ASSERT_RE = /フリーレント[^。\n！!]{0,20}(?:付き|つき|付いて|ついて|適用|免除|となります|のお部屋|キャンペーン|[0-9０-９]ヶ月|[0-9０-９]か月)|(?:家賃|賃料)[^。\n]{0,8}(?:[0-9０-９]ヶ月分?)?(?:無料|免除)/;
export function ungroundedFreeRentSentence(draft: string, facts: ReadonlyArray<StaffFreeRentFact>): string | null {
  if ((typeof process !== "undefined" ? process.env.FREE_RENT_EXIT : undefined) === "off") return null;
  if (facts.some((f) => f.kind === "yes" || f.kind === "negotiable")) return null;
  for (const s of String(draft ?? "").split(/(?<=[。！!？?\n])/)) {
    if (!ASSERT_RE.test(s)) continue;
    // お客様の条件の言い直し（「フリーレント・風呂トイレ別のご希望も踏まえて」）は物件の事実ではない
    if (NOT_FACT_RE.test(s) || NONE_RE.test(s) || /確認|交渉|ご希望|ご条件|ご要望|踏まえ/.test(s)) continue;
    return s.trim();
  }
  return null;
}
