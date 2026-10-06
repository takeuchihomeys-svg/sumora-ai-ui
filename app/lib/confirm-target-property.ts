// app/lib/confirm-target-property.ts
// 「管理会社に確認した」（AIX【確認した（条件・交渉）】）の報告が、どのお部屋の話かを会話から決定論で決める（純関数・DB/LLM なし）。
//
// 2026-10-06 竹内（R 事例）「ここは確認した で管理会社にエアコンを確認した事を入れる形となる。これ別の物件がはいりこんでしまっているので
//   原因見つけて改善する（物件特定できる能力高める必要がある）」:
//   R 10/4 15:45 お客様が homes の URL で物件を送り見積を依頼 → 15:53「ちなみにこの物件はエアコン各部屋で2台付いているかも確認して…」
//   → 16:06 AIX【見積書送る】「【カーサピエント 203号室】」→ 16:09「エアコンにつきまして…明日確認しご連絡」。
//   会話にはその前に送った別の物件（🌟EIJU牧野駅前B 102・6件のピックアップ）も並んでいる。
//   旧: 確認した（設備・駐車場・ペット・初期費用・退去日 等）の [物件名] は LLM が「会話履歴からお客様が確認依頼した物件を特定する」だけ
//   （物件名の入力欄も無い）＝並んでいる別の物件の名前が入る余地があった。
//   → お客様の質問（要件の語がある発言）を起点に、①お客様がその発言で名前を出した、こちらが送った物件 ②お客様がその発言で共有した物件（共有文の物件名）
//     ③その質問に答えた直後のこちらの送付（御見積書・資料の【〇〇 号室】）が1件 ④「この物件」等で指し、質問の直前のこちらの1通に物件が1件、の順で決める。
//     決まらない（複数・名前の無い持ち込み・話題が別の持ち込みに移った）時は null＝今まで通り LLM が「ご確認頂きましたお部屋」にする（推測で名前を入れない）。
// 線（scripts/audit-confirm-target-property.ts・180日の AIX 生成と手打ちの報告を目で読む）:
//   初版で外れた実物 → 足した決まり: 要件が渡された時は他の要件の質問に広げない（110b3053）／起点の質問より後にお客様が別の物件を持ち込んだら決めない（ff668bb2）
//   ／持ち込みの連投で名前が出ても号室が合わなければ決めない（8590144d「Luxe難波 WEST 11階…同じ階の角部屋」）／こちらの手打ちの「〇〇 702号室」も物件に数える
//   （0133b787 エストボワール・2ae0d94e モラーダ 301号室＝名前の出た物件が2つになり決めない）／共有の URL が2つ以上なら決めない
import { extractPropertyLabels, confirmObjectFromCustomerTurn } from "./action-ledger";
import { customerSharedPropertyNames } from "./customer-property-names";

export type TargetMsg = { sender: string; text?: string | null; createdAt?: string | null; rawCreatedAt?: string | null };
export type ConfirmTargetSource = "customer_named" | "customer_shared" | "answered_after_question" | "single_before_question";
export type ConfirmTarget = { name: string; source: ConfirmTargetSource; question: string };

/** 会話の履歴でスタッフの画像を置き換えた印（app/api/aix/action/route.ts の historyRowsForAix）「[画像: 〇〇 101号室の資料・御見積書]」 */
const IMAGE_LABEL_RE = /\[画像:\s*([^\]]+?)の資料・御見積書\]/g;
/** 物件オススメ・新着1件の見出し「🌟H-maison大正VII 106」（号室の字なし・行全体） */
const STAR_LINE_ROOM_RE = /^[ \t]*🌟[ \t]*([^\n🌟【】]{2,40}?)[ \t　]+([0-9０-９]{3,4})[A-Za-zＡ-Ｚ]?[ \t]*$/gm;
/** こちらの手打ちの「エストボワール堂江 702号室」「モラーダ 301号室」（ひらがなで切る＝「お送り頂きました〇〇」の前置きは入らない） */
const PLAIN_ROOM_RE = /([ァ-ヶーｦ-ﾟA-Za-zＡ-Ｚａ-ｚ一-龠々]["'’.&\-A-Za-zＡ-Ｚａ-ｚァ-ヶーｦ-ﾟ一-龠々・･0-9０-９ 　]{1,40}?)\s*([0-9０-９]{2,4})\s*号室/g;
/** お客様が「〇〇は候補から外れました・確認不要です」と外した物件（名前の後ろ20字以内） */
const NEGATED_AFTER_RE = /^[^\n。！!？?]{0,20}?(?:外れ|不要|やめ|止め|辞め|キャンセル|見送|結構です|いらない|要らない)/;
/** お客様の持ち込み（ポータルの URL・画像） */
const CUSTOMER_BROUGHT_RE = /https?:\/\/|^\s*\[画像\]/;
const URL_G_RE = /https?:\/\/[^\s）)」』]+/g;
/** 「この物件」「こちらのお部屋」など、話している部屋を指す語 */
const DEMONSTRATIVE_RE = /この(?:物件|お?部屋|マンション)|こちらの(?:物件|お?部屋)|こちら|ここ|その(?:物件|お?部屋)|そちら|上記|今の(?:物件|お?部屋)/;
/** 号室の前に来ても物件名ではない語（「こちら 203号室」「1件目 203号室」） */
const NOT_NAME_RE = /^(?:こちら|そちら|お部屋|部屋|物件|号|階|件目?|[0-9０-９ 　]+)$/;

const nfkc = (s: string) => s.normalize("NFKC");
/** 照合の鍵（建物名の空白・記号・長音を外す＋号室の先頭0を外す） */
export function propertyKeyOf(label: string): { key: string; base: string; room: string | null } {
  const t = nfkc(label).replace(/[\s　]+/g, " ").trim();
  const m = t.match(/^(.*?)\s*([0-9]{1,4}[A-Za-z]?)\s*号室?\s*$/);
  const building = (m ? m[1] : t).trim();
  const room = m ? m[2].replace(/^0+(?=\d)/, "") : null;
  const base = building.replace(/[・･、。,（）()「」『』\[\]【】\-−ー_/／\s]/g, "").toLowerCase();
  return { key: `${base}#${room ?? ""}`, base, room };
}

/** こちらの1通に出てくる物件（🌟〇〇 305号室・【〇〇 305号室】・画像の印・手打ちの「〇〇 702号室」） */
export function staffLabelsOf(text: string | null | undefined): string[] {
  const t = String(text ?? "");
  const out = [...extractPropertyLabels(t)];
  const push = (n: string) => { const x = n.trim(); if (x && !out.some((o) => propertyKeyOf(o).key === propertyKeyOf(x).key)) out.push(x); };
  for (const m of t.matchAll(IMAGE_LABEL_RE)) push(m[1]);
  // 2026-10-06 竹内（松浦 麻夜 事例）: 新着1件・物件オススメの見出し「🌟H-maison大正VII 106」（号室の字なし）を物件に数えていなかった
  //   → 「ここは保証会社どこでしょうか？」の「ここ」が、その前の送付を飛ばして2日前の「🌟JPmaison此花 201号室」に決まり得た。
  //   見出しの行（🌟＋建物＋空白＋3〜4桁で終わる1行）だけを拾う（aix-material-facts STAR_HEAD_ROOM_RE と同じ形）
  for (const m of t.matchAll(STAR_LINE_ROOM_RE)) push(`${m[1].trim()} ${m[2]}号室`);
  for (const m of t.matchAll(PLAIN_ROOM_RE)) {
    const b = m[1].replace(/^[\s　]+|[\s　]+$/g, "");
    if (b.length < 2 || NOT_NAME_RE.test(b)) continue;
    push(`${b} ${m[2]}号室`);
  }
  return out;
}

function uniqByKey(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of labels) {
    const k = propertyKeyOf(l).key;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}
const brought = (m: TargetMsg) => m.sender === "customer" && CUSTOMER_BROUGHT_RE.test(String(m.text ?? ""));

/**
 * 確認の報告がどのお部屋の話か。msgs は古い順（こちら＝staff・お客様＝customer）。
 * topic（設備・駐車場…）があれば、その要件を聞いたお客様の発言を起点にする（無ければ要件のある最後の質問）。topic があって見つからなければ決めない
 */
export function resolveConfirmTargetProperty(msgs: ReadonlyArray<TargetMsg>, opts: { topic?: string | null } = {}): ConfirmTarget | null {
  const list = msgs.slice(-60);
  // ① 起点: 要件の語がある、お客様の最後の質問
  const want = (opts.topic ?? "").trim() || null;
  let qi = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].sender !== "customer") continue;
    const hit = confirmObjectFromCustomerTurn(list[i].text);
    if (hit && (!want || hit.object === want)) { qi = i; break; }
  }
  if (qi < 0) return null;
  const question = (confirmObjectFromCustomerTurn(list[qi].text)?.question ?? String(list[qi].text ?? "")).slice(0, 80);
  // その発言を含むお客様の連投
  let ts = qi, te = qi;
  while (ts - 1 >= 0 && list[ts - 1].sender === "customer") ts--;
  while (te + 1 < list.length && list[te + 1].sender === "customer") te++;
  // 起点の質問より後にお客様が別の物件を持ち込んだ → 話が移った（どれの話か決めない）
  if (list.slice(te + 1).some(brought)) return null;
  const turn = list.slice(ts, te + 1);
  const turnText = turn.map((m) => String(m.text ?? "")).join("\n");
  // 2026-10-06（松浦 麻夜 事例の監査で見つけた）: 建物名の鍵（propertyKeyOf の base）は長音・記号を外すので、お客様の文も同じ形に揃えて比べる
  //   （旧は文の側だけ「ー」を残していて「カーザSun I の保証会社」が「カザsuni」に当たらなかった）
  const turnFlat = nfkc(turnText).replace(/[・･、。,（）()「」『』\[\]【】\-−ー_/／\s　]/g, "").toLowerCase();
  const turnBrought = turn.some(brought);

  // こちらが送った物件（質問より前・新しい順）
  const staffAll = uniqByKey(list.flatMap((m, i) => (m.sender !== "customer" && i < ts ? staffLabelsOf(m.text) : [])).reverse());

  // ② お客様がその連投で名前を出した、こちらが送った物件
  const named = staffAll.filter((l) => {
    const { base } = propertyKeyOf(l);
    if (base.length < 3) return false;
    const at = turnFlat.indexOf(base);
    // 監査（2ae0d94e）: 「プレリス大阪今里サヴィアは候補から外れましたので…モラーダのみ」＝外した物件は数えない
    return at >= 0 && !NEGATED_AFTER_RE.test(turnFlat.slice(at + base.length));
  });
  // 名前を出した物件を全部外していた（「〇〇は候補から外れました」）→ 話しているのは名前の分からない別の物件（モラーダ）＝決めない
  if (!named.length && staffAll.some((l) => { const b = propertyKeyOf(l).base; return b.length >= 3 && turnFlat.includes(b); })) return null;
  if (named.length) {
    const roomHit = named.filter((l) => { const r = propertyKeyOf(l).room; return !!r && new RegExp(`(?<![0-9])0*${r}(?![0-9])`).test(nfkc(turnText)); });
    // 持ち込み（画像・URL）の連投で名前が出ただけ（同じ建物の別の部屋かもしれない）は号室が合う時だけ
    const pick = roomHit.length === 1 ? roomHit : turnBrought ? [] : named;
    if (pick.length === 1) return { name: pick[0], source: "customer_named", question };
    return null; // 同じ建物の別の部屋が複数・別の物件が複数・持ち込みで号室が合わない → 決めない
  }
  // ③ お客様がその連投で共有した物件（共有文に物件名がある時だけ・URL が2つ以上なら決めない）
  const urlCount = (turnText.match(URL_G_RE) ?? []).length;
  const shared = customerSharedPropertyNames(turn, { limit: 3 });
  if (shared.length === 1 && urlCount <= 1) return { name: shared[0].label || shared[0].name, source: "customer_shared", question };
  if (shared.length > 1 || urlCount > 1) return null;
  // ④ その質問に答えた直後のこちらの送付（次のお客様の発言まで）に物件が1件
  const after: string[] = [];
  for (let i = te + 1; i < list.length && list[i].sender !== "customer"; i++) after.push(...staffLabelsOf(list[i].text));
  const afterU = uniqByKey(after);
  if (afterU.length === 1) return { name: afterU[0], source: "answered_after_question", question };
  if (afterU.length > 1) return null;
  // ⑤ 質問の連投に名前の無い持ち込み（URL・画像）があれば、その部屋の名前は分からない → 決めない
  if (turnBrought) return null;
  // ⑥ 「この物件」等で指していて、質問の直前のこちらの1通に物件が1件だけ（その間にお客様の持ち込みがあれば決めない）
  if (!DEMONSTRATIVE_RE.test(turnText)) return null;
  for (let i = ts - 1; i >= 0; i--) {
    if (brought(list[i])) return null;
    if (list[i].sender === "customer") continue;
    const ls = uniqByKey(staffLabelsOf(list[i].text));
    if (!ls.length) continue;
    return ls.length === 1 ? { name: ls[0], source: "single_before_question", question } : null;
  }
  return null;
}

/** 生成文に、決めた物件ではない（こちらが送った）物件の名前が出ているか（記録用・本文は書き換えない） */
export function otherPropertyNamedInText(text: string, target: string, msgs: ReadonlyArray<TargetMsg>): string[] {
  const t = propertyKeyOf(target);
  const flat = nfkc(text).replace(/[\s　]+/g, "").toLowerCase();
  const all = uniqByKey(msgs.flatMap((m) => (m.sender !== "customer" ? staffLabelsOf(m.text) : [])));
  return all.filter((l) => {
    const k = propertyKeyOf(l);
    return k.base !== t.base && k.base.length >= 3 && flat.includes(k.base);
  });
}
