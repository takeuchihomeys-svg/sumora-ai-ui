// app/lib/concern-subtopic.ts — お客様の懸念（customer_concern）を2段に分ける（純関数・DB/LLM なし）
//
// 2026-11-13 作業員1（統括役・点検役の読み「19番中5番が部分の読みが粗い」・竹内さん「足りていない土台の強化と具体的な細分化」）
//   今の懸念は topic 12種（費用・設備…）と object（40字）だけで、「初期費用のどの項目か」「設備のどれか」「どの号室か」を持たない。
//   下の段の名前は見積の項目（御見積書の行: 敷金・礼金・仲介手数料・前家賃・日割家賃・鍵交換・保証料・火災保険・管理費）と
//   物件の資料の設備の欄（キッチン・エアコン・床・浴室・トイレ・洗濯機置場・収納・インターネット）から取った。
//   号室: 懸念の中・お客様の文の号室を拾い、掲載（送った物件）の号室と見積の号室が違う時に印を付ける。
//   既定 off（BRAIN_CONCERN_SUBTOPIC=on の時だけ meta に customer_concern_detail を記録・道は変えない）

export function concernSubtopicOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_CONCERN_SUBTOPIC ?? "").trim().toLowerCase() === "on";
}

/** 費用 → 見積の項目 */
const COST_SUBS: Array<{ sub: string; re: RegExp }> = [
  { sub: "鍵交換", re: /鍵(?:交換|代)|カギ|キー交換/ },
  { sub: "日割家賃", re: /日割|日割り/ },
  { sub: "前家賃", re: /前家賃|翌月分|初月/ },
  { sub: "礼金", re: /礼金/ },
  { sub: "敷金", re: /敷金|保証金/ },
  { sub: "仲介手数料", re: /仲介(?:手数料)?|手数料/ },
  { sub: "保証料", re: /保証(?:料|会社の(?:費用|初回))/ },
  { sub: "火災保険", re: /火災保険|保険料/ },
  { sub: "管理費", re: /管理費|共益費/ },
  { sub: "クリーニング", re: /クリーニング|清掃費/ },
  { sub: "支払い方法", re: /分割|カード|振込|支払(?:い)?方法/ },
  { sub: "総額", re: /総額|合計|全部で|初期費用/ },
];
/** 設備 → 物件の資料の設備の欄 */
const EQUIP_SUBS: Array<{ sub: string; re: RegExp }> = [
  { sub: "キッチン", re: /キッチン|コンロ|IH|ガスコンロ|シンク/ },
  { sub: "エアコン", re: /エアコン|冷暖房/ },
  { sub: "床・内装", re: /床|フローリング|壁紙|クロス|内装|色/ },
  { sub: "浴室", re: /浴室|風呂|バス(?!トイレ別)|追い?焚き|浴槽/ },
  { sub: "トイレ", re: /トイレ|ウォシュレット|温水洗浄/ },
  { sub: "洗濯機置場", re: /洗濯機|洗濯/ },
  { sub: "収納", re: /収納|クローゼット|押入/ },
  { sub: "インターネット", re: /ネット|Wi-?Fi|光回線/i },
  { sub: "バストイレ別", re: /バストイレ別|BT別|セパレート/ },
];

const ROOM_RE = /([0-9０-９]{3,4})\s*(?:号室|号)?/g;
const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

export type ConcernDetail = { topic: string; sub: string | null; rooms: string[]; roomMismatch: { listed: string; estimate: string } | null };

/** 懸念の下の段（topic が費用・設備の時だけ。他は sub=null） */
export function concernSub(topic: string, text: string): string | null {
  const list = topic === "費用" ? COST_SUBS : topic === "設備" ? EQUIP_SUBS : null;
  if (!list) return null;
  return list.find((x) => x.re.test(text))?.sub ?? null;
}
/** 文の中の号室（3〜4桁・半角にそろえる・同じ物は1つ） */
export function roomsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of toHalf(text).matchAll(ROOM_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
/**
 * 懸念の詳しい形。listedRoom＝掲載（送った・持ち込みの）物件の号室、estimateRoom＝最後の見積の号室（呼ぶ側が記録から渡す）。
 *   両方あって違う時だけ roomMismatch（お客様が「掲載の号室と見積の号室が違う」と気にしている番の材料）
 */
export function concernDetail(c: { topic: string; object: string } | null, customerText: string, o: { listedRoom?: string | null; estimateRoom?: string | null } = {}): ConcernDetail | null {
  if (!c) return null;
  const text = `${c.object}\n${customerText}`;
  const listed = o.listedRoom ? toHalf(o.listedRoom).replace(/\D/g, "") : "";
  const est = o.estimateRoom ? toHalf(o.estimateRoom).replace(/\D/g, "") : "";
  return { topic: c.topic, sub: concernSub(c.topic, text), rooms: roomsIn(text), roomMismatch: listed && est && listed !== est ? { listed, estimate: est } : null };
}
