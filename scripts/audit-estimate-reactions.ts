// 見積書を送った後のお客様の反応（高い・内訳の質問・総額の確認・安すぎて不審・良い・内覧・申込・反応なし）を数える
// （読み取りのみ・LLM は呼ばない・本文はマスクして出す）
// 2026-09-26 竹内「送った見積書に対しての反応も分かるようにする。見積書の金額や割引金額、それに対してのお客さんの反応」
//
// 測ること（直近 DAYS 日・グループと YUMA を除く・messages は 2026-05-17 から）:
//   ① 見積書の出来事: AIX【見積書送る】（本文の【】ごと）／AIX【物件確認した】＋見積同封（prop_cost_notes）／手打ちの「初期費用：N円」
//   ② 物件ごとの 物件名・号室・割引・総額・節約・家賃（節約額から逆算: round(家賃×1.1)−仲介税込+割引）の埋まり具合・送り直し（版）
//   ③ 見積書の後 72h・TURNS ターンまで（次の見積書で打ち切り）のお客様の反応を決定論で分類（主: doubt>expensive>breakdown>total>apply>view>good>consider>ack）
//   ④ どの見積書（物件）への反応か（1件だけ・引用・物件名・金額・順番の言葉・決められない）
//   ⑤ 割引の帯・総額の帯・総額/家賃 × 反応、反応 × その後30日（申込へ AIX・待ち合わせ・止まった）
//   ⑥ 反応の直後の返信の下書き×実送信（そのまま送信率）／ブレインの最初の判断の外れ
//   OUT=<file> で出来事の一覧（マスク済み）・書き直し（.rewrites.txt）・ブレインの外れ（.brain.txt）を書き出す（目で読む用）
//
// 2026-09-26 の結論（設計知見「見積書への反応は『お金の話』が1割強しかなく…」）:
//   出来事 365（131会話）: AIX 見積書送る 234・物件確認＋同封 52・手打ち/旗なし 79（estimate_records は AIX 見積書送るだけ＝2割強が表に無い）。
//   物件の行 422: 物件名100%・号室80%・割引82%・総額85%・節約79%（家賃は節約から逆算 79%）。割引の中央値 44,000・割引/家賃 0.54ヶ月。
//   1ターン目の反応: なし22%・内覧12%・申込7%・お礼12%。お金の反応は目で読むと1割強（高い/値引き相談≈12・内訳/支払≈20・総額≈4・不審≈2・安くて良い≈6）。
//   分類の精度（目で読んだ）: expensive ≈67%・breakdown ≈57%（申込フォームや入居時期の質問が混ざる）。件数は目で読む前提の上限。
//   割引の帯・総額の帯で反応も『申込へ』（24〜32%）も平ら ＝ 割引額は反応を決めていない。
//   どの見積書か: 1通1物件 79%。複数物件の通は物件名で約2割、引用は見積の本文（全物件が1通）を指すので決まらない。
//   効果の上限: 見積書の後の下書きのそのまま送信 17%（156組）。書き直し130のうち見積書の中身を知らなかったのが原因は2〜3件。
//   ブレインの外れ65のうち見積書の中身・反応が原因は3〜4件（大半はスタッフが AIX を押さず手打ち）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-reactions.ts   （DAYS=180・TURNS=1・OUT=）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { parseEstimateItems, type EstimateItem } from "../app/lib/estimate-profit";
import { normalizeBuildingName } from "../app/lib/property-brain";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const OUT = process.env.OUT ?? "";
const TURNS = Number(process.env.TURNS ?? 1);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page(table: string, cols: string, s: string | null, tcol = "created_at", extra?: (q: any) => any): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (let p = 0; p < 400; p++) {
    let q = sb.from(table).select(cols).order(tcol).range(p * 1000, p * 1000 + 999);
    if (s) q = q.gte(tcol, s);
    if (extra) q = extra(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/https?:\/\/\S+/g, "[URL]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");
const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const qt = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };

// ── お客様の反応（見積書の後）
const R: Array<[string, RegExp]> = [
  ["doubt", /(なんで|なぜ|何で|どうして)[^。？?]{0,12}安|安すぎ|安い(理由|のは|んですか)|怪し|裏が|(本当|ほんと)に?(この|その)?(金額|値段|費用|初期費用|価格)|仲介手数料[^。]{0,8}(無|なし|0|ゼロ|かからない)[^。]{0,12}(大丈夫|ですか|？|\?|なんですか)|後(から|で)[^。]{0,8}(請求|追加|高く)/],
  ["expensive", /高い|高く(て|な)|高め|高すぎ|予算(オーバー|を?超|より)|(安く|下が|下げ|値引|値下|交渉|割引)[^。]{0,8}(なら|なり|られ|でき|れま|ない|ませ|て(もら|いただ|頂)|可能)|もう少し[^。]{0,8}(安|下|抑え|割引)|もっと[^。]{0,6}(安|抑え|割引)|(払え|はらえ)(ない|ません|な)/],
  ["breakdown", /含ま|(?<!申し|申)込(み|ん)|内訳|何(が|の)(費用|お金|料金)|別途|分割|カード(払い|で|決済)|クレジット|支払い?(方法|い方|時期|期限|はいつ|日)|振込|振り込|いつまでに|火災保険|保証(会社|料)|鍵(交換)?|日割|敷金|礼金|家賃だけ|前家賃|更新料|退去|クリーニング|消毒|抗菌|サポート|町内会|水道|初回/],
  ["total", /合計|総額|全部で|トータル|[0-9０-９]{2,3}[,，]?[0-9０-９]{3}\s*円?(に|で|って|くらい|ぐらい|程|ほど|です|ですか|？)|万円?(くらい|ぐらい|程|ほど|に|で)|になる(感じ|ってこと|んです|のか|ん)|で(大丈夫|間違い)(ない|ありま|です)|追加(で|の|費用|料金)|これ以上(かから|かかりま)|以外(に|で)(かから|かかり|必要)/],
  ["apply", /氏名[\s\S]*生年月日|申し?込|契約(したい|します|お願い|を?進め)|審査|(この|こちらの)(物件|お部屋|部屋)で(お願い|決め)|ここ(に|で)(します|決め)|決め(ました|たい|ます)/],
  ["view", /内覧|内見|見に行|見学|案内|実物|実際に(見|行)|見たい/],
  ["good", /安(い|く(て|なっ|なり))|お得|助か|ありがた(い|いで)|嬉し|うれし|すご|凄|いいですね|良いですね|いいな|素敵|最高|魅力|良さそう|よさそう|いい感じ|良い感じ|思ったより|想像より|予算内|予算(以内|の中)|おさま|収ま|大丈夫そう/],
  ["consider", /検討|考え(ます|させ|てみ)|相談(して|します|させ)|親|家族|彼氏|彼女|旦那|主人|妻|嫁|比べ|比較|他(の|社)|一旦|また連絡|連絡します|見てみます|確認します|拝見/],
  ["ack", /^(ありがとう|有難う|有り難う|ありがと|了解|承知|かしこまり|わかりました|分かりました|はい|OK|おけ|👍|🙏|よろしく|宜しく)/],
];
const MONEY_RE = /費用|金額|家賃|[0-9０-９]\s*円|万|予算|値段|礼金|敷金|安く|高/;
const PRI = ["doubt", "expensive", "breakdown", "total", "apply", "view", "good", "consider", "ack"];
function kinds(parts: string[]): string[] {
  const s = new Set<string>();
  for (const p0 of parts) {
    const p = p0.replace(/https?:\/\/\S+/g, "");
    for (const [k, re] of R) if (re.test(p)) s.add(k);
    // 「厳しい・きつい」は日程・審査の話にも出る（10月入居は厳しい・保証会社きつい）。お金の語が同じ発言にある時だけ「高い」と読む
    if (/厳し|きびし|きつい|キツ/.test(p) && MONEY_RE.test(p)) s.add("expensive");
  }
  return s.size ? [...s] : ["other"];
}
const primary = (ks: string[]) => PRI.find((k) => ks.includes(k)) ?? ks[0];
const ORD_RE = /([1-9１-９一二三①②③])(枚目|件目|番目|つ目|個目|番)|最初|一番上|上の|下の|最後|前者|後者|①|②|③/;

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; quoted_message_id: string | null; line_message_id: string | null; t: number };
type Ev = { conv: string; t: number; src: string; items: EstimateItem[]; savings: (number | null)[]; blockIds: Set<string>; blockImgs: string[]; resend: boolean; turns: Array<{ parts: string[]; t: number; quoted: Msg[] }>; staffAfter: string; out?: string; react?: string; reactKinds?: string[]; which?: string; mentionedYen: number[] };

function savingsOf(text: string): (number | null)[] {
  const t = text.replace(/[,，]/g, "");
  const blocks = t.split(/【[^】\n]{2,80}】/).slice(1);
  return blocks.map((b) => { const m = b.match(/(\d{4,7})\s*円\s*節約/); return m ? +m[1] : null; });
}
// 家賃の逆算（calcSavings: round(家賃×1.1) − (仲介+税) + 割引）。仲介はアカウント既定（スモラ 2,980+298・他 0）
function rentFrom(sav: number | null, disc: number | null, acct: string): number | null {
  if (sav == null) return null; const comm = /sumora|スモラ/.test(acct) ? 3278 : 0;
  const r = (sav - (disc ?? 0) + comm) / 1.1; return r >= 20000 && r <= 400000 ? Math.round(r / 100) * 100 : null;
}

async function main() {
  const convs = await page("conversations", "id, line_source_type, account", null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convOk = new Map<string, any>(); for (const c of convs) if (c.id !== YUMA && c.line_source_type !== "group") convOk.set(c.id, c);
  const msgs: Msg[] = (await page("messages", "id, conversation_id, sender, text, image_url, created_at, is_aix_generated, quoted_message_id, line_message_id", since)).filter((m) => convOk.has(m.conversation_id)).map((m) => ({ ...m, t: Date.parse(m.created_at) }));
  const msgSince = msgs.length ? msgs[0].created_at : since;
  const aix = (await page("aix_usage_logs", "id, conversation_id, aix_type, created_at, sent_at, generated_text, estimate_sent, prop_cost_notes, property_names, line_message_id", since)).filter((a) => a.sent_at && convOk.has(a.conversation_id)).map((a) => ({ ...a, t: Date.parse(a.sent_at) }));
  const byConv = new Map<string, Msg[]>(); for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const byLineId = new Map<string, Msg>(); for (const m of msgs) if (m.line_message_id) byLineId.set(m.line_message_id, m);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aixByConv = new Map<string, any[]>(); for (const a of aix) { const l = aixByConv.get(a.conversation_id) ?? []; l.push(a); aixByConv.set(a.conversation_id, l); }

  const evs: Ev[] = [];
  const src: Record<string, number> = {};
  let aixMsgMatch = 0, aixMsgTotal = 0;
  for (const a of aix) {
    if (Date.parse(a.sent_at) < Date.parse(msgSince)) continue;
    let items: EstimateItem[] = []; let sv: (number | null)[] = []; let s = "";
    if (a.aix_type === "estimate_sheet") { items = parseEstimateItems(a.generated_text); sv = savingsOf(a.generated_text ?? ""); s = "aix_estimate"; }
    else if (a.estimate_sent) {
      s = "aix_check+estimate";
      const notes: string[] = a.prop_cost_notes ?? [];
      items = notes.map((n, i) => { const x = n.replace(/,/g, ""); const nm = n.split(" / ")[0]; const rm = nm.match(/^(.+?)\s+(\d{2,4})号室?$/); return { index: i, propertyName: rm ? rm[1] : nm, roomNo: rm ? rm[2] : null, discountYen: +(x.match(/割引額:\s*(\d+)/)?.[1] ?? NaN) || null, initialCostYen: +(x.match(/初期費用合計:\s*(\d+)/)?.[1] ?? NaN) || null }; });
      if (!items.length) items = (a.property_names ?? []).map((n: string, i: number) => ({ index: i, propertyName: n, roomNo: null, discountYen: null, initialCostYen: null }));
      sv = notes.map((n) => +(n.replace(/,/g, "").match(/節約額）:\s*(\d+)/)?.[1] ?? NaN) || null);
    } else continue;
    src[s] = (src[s] ?? 0) + 1;
    const ms = byConv.get(a.conversation_id) ?? [];
    const blk = ms.filter((m) => m.sender !== "customer" && Math.abs(m.t - a.t) < 5 * 60e3);
    aixMsgTotal++; if (blk.length) aixMsgMatch++;
    evs.push({ conv: a.conversation_id, t: a.t, src: s, items, savings: sv, blockIds: new Set(blk.map((m) => m.line_message_id).filter(Boolean) as string[]), blockImgs: blk.filter((m) => m.image_url).map((m) => m.line_message_id ?? ""), resend: false, turns: [], staffAfter: "", mentionedYen: [] });
  }
  for (const m of msgs) {
    if (m.sender === "customer" || !m.text || !/初期費用\s*[:：]\s*[0-9０-９,，]+\s*円/.test(m.text)) continue;
    if (evs.some((e) => e.conv === m.conversation_id && Math.abs(e.t - m.t) < 10 * 60e3)) continue;
    const items = parseEstimateItems(m.text); if (!items.length) continue;
    const s = m.is_aix_generated ? "msg_aix_flag" : "hand_text";
    evs.push({ conv: m.conversation_id, t: m.t, src: s, items, savings: savingsOf(m.text), blockIds: new Set([m.line_message_id ?? ""]), blockImgs: [], resend: false, turns: [], staffAfter: "", mentionedYen: [] });
    src[s] = (src[s] ?? 0) + 1;
  }
  evs.sort((a, b) => a.t - b.t);
  console.log(`messages の最古 ${msgSince.slice(0, 10)}・見積書の出来事 ${evs.length}（会話 ${new Set(evs.map((e) => e.conv)).size}）`, src, `AIXログ↔messages ±5分 ${aixMsgMatch}/${aixMsgTotal}`);

  const allItems = evs.flatMap((e) => e.items.map((it, i) => ({ e, it, sav: e.savings[i] ?? null })));
  const nI = allItems.length;
  const acctOf = (e: Ev) => String(convOk.get(e.conv)?.account ?? "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = (p: (x: any) => boolean) => allItems.filter(p).length;
  console.log(`物件の行 ${nI}: 物件名 ${pct(f((x) => !!x.it.propertyName), nI)}・号室 ${pct(f((x) => !!x.it.roomNo), nI)}・割引 ${pct(f((x) => x.it.discountYen != null), nI)}・総額 ${pct(f((x) => x.it.initialCostYen != null), nI)}・節約 ${pct(f((x) => x.sav != null), nI)}・家賃の逆算 ${pct(f((x) => rentFrom(x.sav, x.it.discountYen, acctOf(x.e)) != null), nI)}`);
  const perEvItems: Record<string, number> = {}; for (const e of evs) { const k = e.items.length >= 3 ? "3+" : String(e.items.length); perEvItems[k] = (perEvItems[k] ?? 0) + 1; } console.log("1通の物件数", perEvItems);
  const seen = new Map<string, number>(); let resendItems = 0;
  for (const e of evs) {
    let any = false;
    for (const it of e.items) { const k = `${e.conv}|${normalizeBuildingName(it.propertyName)}|${it.roomNo ?? ""}`; const v = (seen.get(k) ?? 0) + 1; seen.set(k, v); if (v > 1) { any = true; resendItems++; } }
    e.resend = any;
  }
  const cc = new Map<string, number>(); for (const e of evs) cc.set(e.conv, (cc.get(e.conv) ?? 0) + 1);
  const perConv: Record<string, number> = {}; for (const v of cc.values()) { const k = v >= 4 ? "4+" : String(v); perConv[k] = (perConv[k] ?? 0) + 1; }
  const propsPerConv = new Map<string, Set<string>>(); for (const x of allItems) { const s = propsPerConv.get(x.e.conv) ?? new Set(); s.add(normalizeBuildingName(x.it.propertyName)); propsPerConv.set(x.e.conv, s); }
  console.log(`1会話の見積書の通数`, perConv, `1会話の見積した物件数 中央 ${med([...propsPerConv.values()].map((s) => s.size))}・同じ物件の送り直し（物件の行）${resendItems}・送り直しを含む通 ${evs.filter((e) => e.resend).length}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byKey = new Map<string, any[]>(); for (const x of allItems) { const k = `${x.e.conv}|${normalizeBuildingName(x.it.propertyName)}|${x.it.roomNo ?? ""}`; const a = byKey.get(k) ?? []; a.push(x); byKey.set(k, a); }
  const diffs: string[] = []; let sameAmt = 0, up = 0, down = 0;
  for (const [, a] of byKey) if (a.length > 1) for (let i = 1; i < a.length; i++) { const p = a[i - 1].it.initialCostYen, c = a[i].it.initialCostYen; if (p === c) sameAmt++; else if (p != null && c != null && c > p) up++; else down++; diffs.push(`総額 ${p}→${c}・割引 ${a[i - 1].it.discountYen}→${a[i].it.discountYen}・${((a[i].e.t - a[i - 1].e.t) / 3600e3).toFixed(0)}h後`); }
  console.log(` 送り直し ${diffs.length}: 同額 ${sameAmt}・上がった ${up}・下がった/不明 ${down}`, diffs.slice(0, 12));
  const discs = allItems.map((x) => x.it.discountYen).filter((v): v is number => v != null);
  const tots = allItems.map((x) => x.it.initialCostYen).filter((v): v is number => v != null);
  const rents = allItems.map((x) => rentFrom(x.sav, x.it.discountYen, acctOf(x.e))).filter((v): v is number => v != null);
  console.log(`割引: n=${discs.length} 無し ${nI - discs.length} Q1 ${qt(discs, .25)} 中央 ${med(discs)} Q3 ${qt(discs, .75)} 最大 ${Math.max(...discs)}`);
  const ratio = allItems.map((x) => { const r = rentFrom(x.sav, x.it.discountYen, acctOf(x.e)); return x.it.initialCostYen && r ? x.it.initialCostYen / r : null; }).filter((v): v is number => v != null);
  const dr = allItems.map((x) => { const r = rentFrom(x.sav, x.it.discountYen, acctOf(x.e)); return x.it.discountYen && r ? x.it.discountYen / r : null; }).filter((v): v is number => v != null);
  console.log(`総額: n=${tots.length} Q1 ${qt(tots, .25)} 中央 ${med(tots)} Q3 ${qt(tots, .75)}・家賃(逆算) n=${rents.length} 中央 ${med(rents)}・総額/家賃 中央 ${med(ratio).toFixed(2)}・割引/家賃 中央 ${med(dr).toFixed(2)}（Q1 ${qt(dr, .25)?.toFixed(2)} Q3 ${qt(dr, .75)?.toFixed(2)}）`);
  const acctD: Record<string, number[]> = {}; for (const x of allItems) if (x.it.discountYen) (acctD[acctOf(x.e) || "?"] ??= []).push(x.it.discountYen); for (const [k, v] of Object.entries(acctD)) console.log(`  アカウント ${k}: n=${v.length} 割引中央 ${med(v)}`);

  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]; const nextE = evs.slice(i + 1).find((x) => x.conv === e.conv);
    const lim = Math.min(e.t + 72 * 3600e3, nextE ? nextE.t : Infinity);
    const ms = (byConv.get(e.conv) ?? []).filter((m) => m.t > e.t + 60e3 && m.t < lim);
    let j = 0; let saw = false;
    while (j < ms.length && e.turns.length < TURNS) {
      if (ms[j].sender !== "customer") { if (e.turns.length && !saw) { e.staffAfter = ms.slice(j, j + 4).filter((m) => m.sender !== "customer").map((m) => m.text ?? "[画像]").join(" / ").slice(0, 300); saw = true; } j++; continue; }
      const tm: Msg[] = []; while (j < ms.length && ms[j].sender === "customer") tm.push(ms[j++]);
      if (!tm.some((m) => m.text)) continue;
      e.turns.push({ parts: tm.map((m) => m.text ?? "").filter(Boolean), t: tm[0].t, quoted: tm.map((m) => (m.quoted_message_id ? byLineId.get(m.quoted_message_id) : undefined)).filter(Boolean) as Msg[] });
    }
    const ks = new Set<string>(); for (const tu of e.turns) for (const k of kinds(tu.parts)) ks.add(k);
    e.reactKinds = e.turns.length ? [...ks] : ["none"];
    e.react = e.turns.length ? primary([...ks]) : "none";
    const txt = e.turns.map((t) => t.parts.join(" ")).join(" ");
    const qs = e.turns.flatMap((t) => t.quoted);
    const inBlk = qs.filter((m) => m.line_message_id && e.blockIds.has(m.line_message_id));
    const nt = normalizeBuildingName(txt);
    const nameHit = e.items.filter((it) => { const b = normalizeBuildingName(it.propertyName); return b.length >= 3 && nt.includes(b.slice(0, Math.min(4, b.length))); });
    const yen = [...txt.replace(/[,，]/g, "").matchAll(/(\d{4,7})\s*円/g)].map((m) => +m[1]); e.mentionedYen = yen;
    const yenHit = e.items.filter((it) => yen.some((y) => y === it.initialCostYen || y === it.discountYen));
    const quoteKind = () => { const m = inBlk[0]; if (m.text) { const it = parseEstimateItems(m.text); return it.length === 1 ? "引用(本文1件)" : "引用(束)"; } const idx = e.blockImgs.indexOf(m.line_message_id ?? ""); return idx >= 0 && e.blockImgs.length === e.items.length ? "引用(画像の順)" : "引用(画像・順不明)"; };
    e.which = e.turns.length === 0 ? "-" : e.items.length === 1 ? "1件だけ" : inBlk.length ? quoteKind() : nameHit.length === 1 ? "物件名" : yenHit.length === 1 ? "金額" : ORD_RE.test(txt) ? "順番の言葉" : e.items.length === 0 ? "物件不明" : "決められない";
    const later = (aixByConv.get(e.conv) ?? []).filter((a) => a.t > e.t && a.t < e.t + 30 * 86400e3).map((a) => a.aix_type);
    const custLater = (byConv.get(e.conv) ?? []).filter((m) => m.sender === "customer" && m.t > e.t && m.t < e.t + 30 * 86400e3);
    const applyTxt = custLater.some((m) => /申し?込(み|ませ|みた|みま|む)|審査/.test(m.text ?? ""));
    e.out = later.includes("application_push") ? "申込(AIX申込へ)" : applyTxt ? "申込の語だけ" : later.includes("meeting_place") ? "内覧決定" : later.includes("viewing_invite") ? "内覧の誘い" : later.includes("estimate_sheet") ? "別の見積" : custLater.length === 0 ? "止まった(返事なし)" : custLater.every((m) => m.t < e.t + 72 * 3600e3) ? "止まった(3日以降なし)" : "続いた(その他)";
  }
  const rc: Record<string, number> = {}; for (const e of evs) rc[e.react!] = (rc[e.react!] ?? 0) + 1;
  console.log(`\n■ 反応（主・doubt>expensive>breakdown>total>apply>view>good>consider>ack）`, rc);
  const rk: Record<string, number> = {}; for (const e of evs) for (const k of e.reactKinds!) rk[k] = (rk[k] ?? 0) + 1; console.log("  反応（重なり）", rk);
  const withT = evs.filter((e) => e.turns.length);
  const wc: Record<string, number> = {}; for (const e of withT) wc[e.which!] = (wc[e.which!] ?? 0) + 1; console.log(`  どの見積書か（反応あり ${withT.length}）`, wc);
  const wcM: Record<string, number> = {}; for (const e of withT.filter((e) => e.items.length > 1)) wcM[e.which!] = (wcM[e.which!] ?? 0) + 1; console.log(`   うち複数物件の通`, wcM);
  const wcMR: Record<string, number> = {}; for (const e of withT.filter((e) => e.items.length > 1 && ["good", "apply", "view", "expensive", "doubt", "breakdown", "total"].includes(e.react!))) wcMR[e.which!] = (wcMR[e.which!] ?? 0) + 1; console.log(`   複数物件で中身のある反応`, wcMR);
  const band = (d: number | null) => d == null ? "0割引なし" : d < 20000 ? "1<2万" : d < 40000 ? "22-4万" : d < 70000 ? "34-7万" : "47万+";
  const tband = (d: number | null) => d == null ? "?" : d < 120000 ? "1<12万" : d < 170000 ? "212-17万" : d < 250000 ? "317-25万" : "425万+";
  const RS = ["none", "good", "apply", "view", "expensive", "doubt", "breakdown", "total", "consider", "ack", "other"];
  const cross = (keyf: (e: Ev) => string, title: string) => {
    const tab: Record<string, Record<string, number>> = {};
    for (const e of evs) { if (e.items.length !== 1) continue; const k = keyf(e); (tab[k] ??= {})[e.react!] = (tab[k][e.react!] ?? 0) + 1; }
    console.log(`\n■ ${title}（1物件の通だけ）`);
    for (const [k, m] of Object.entries(tab).sort()) { const n = Object.values(m).reduce((a, b) => a + b, 0); console.log(`  ${k} n=${n}: ` + RS.map((r) => `${r} ${pct(m[r] ?? 0, n)}`).join("・")); }
  };
  cross((e) => band(e.items[0].discountYen), "割引額の帯×反応");
  cross((e) => tband(e.items[0].initialCostYen), "総額の帯×反応");
  cross((e) => { const r = rentFrom(e.savings[0] ?? null, e.items[0].discountYen, acctOf(e)); const x = r && e.items[0].initialCostYen ? e.items[0].initialCostYen / r : null; return x == null ? "?" : x < 1.6 ? "1<1.6ヶ月" : x < 2.2 ? "21.6-2.2" : x < 3 ? "32.2-3" : "43ヶ月+"; }, "総額/家賃×反応");
  const oc: Record<string, Record<string, number>> = {};
  for (const e of evs) (oc[e.react!] ??= {})[e.out!] = (oc[e.react!][e.out!] ?? 0) + 1;
  console.log(`\n■ 反応×その後30日`); for (const [k, m] of Object.entries(oc)) { const n = Object.values(m).reduce((a, b) => a + b, 0); console.log(`  ${k} n=${n}:`, Object.entries(m).sort((a, b) => b[1] - a[1]).map(([x, v]) => `${x} ${v}(${pct(v, n)})`).join("・")); }
  const ob: Record<string, Record<string, number>> = {};
  for (const e of evs) { if (e.items.length !== 1) continue; const k = band(e.items[0].discountYen); (ob[k] ??= {})[e.out!] = (ob[k][e.out!] ?? 0) + 1; }
  console.log(`■ 割引の帯×その後（1物件）`); for (const [k, m] of Object.entries(ob).sort()) { const n = Object.values(m).reduce((a, b) => a + b, 0); console.log(`  ${k} n=${n}: 申込へ ${pct(m["申込(AIX申込へ)"] ?? 0, n)}・申込の語 ${pct(m["申込の語だけ"] ?? 0, n)}・内覧決定 ${pct(m["内覧決定"] ?? 0, n)}・止まった ${pct((m["止まった(返事なし)"] ?? 0) + (m["止まった(3日以降なし)"] ?? 0), n)}`); }
  const rs: Record<string, number> = {}; for (const e of evs.filter((e) => e.resend)) rs[e.react!] = (rs[e.react!] ?? 0) + 1; console.log("送り直しの通の反応", rs);
  const pre: Record<string, number> = {}; for (let i = 0; i < evs.length; i++) { const e = evs[i]; if (!e.resend) continue; const prev = evs.slice(0, i).reverse().find((x) => x.conv === e.conv); if (prev) for (const k of prev.reactKinds!) pre[k] = (pre[k] ?? 0) + 1; } console.log("送り直しの直前の通への反応（重なり）", pre);

  const ex = (await page("ai_reply_examples", "conversation_id, sent_reply, ai_draft, entry_source, sent_at, created_at", since)).filter((r) => r.entry_source === "line_reply" && String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim() && convOk.has(r.conversation_id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exact = (r: any) => String(r.ai_draft).replace(/\s/g, "") === String(r.sent_reply).replace(/\s/g, "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exBy = new Map<string, any[]>(); for (const r of ex) { const a = exBy.get(r.conversation_id) ?? []; a.push(r); exBy.set(r.conversation_id, a); }
  let n = 0, asIs = 0; const rew: string[] = []; let amtMiss = 0, amtWrong = 0;
  const byR: Record<string, { n: number; a: number }> = {};
  const AMT_RE = /(\d{1,3}[,，]\d{3}|\d{4,7})\s*円|割引|内訳|含ま|込み|別途|敷金|礼金|火災保険|保証|鍵|日割|仲介手数料|総額|合計/;
  for (const e of evs) {
    if (!e.turns.length) continue;
    const r = (exBy.get(e.conv) ?? []).find((x) => { const s = Date.parse(x.sent_at ?? x.created_at); return s > e.turns[0].t && s < e.t + 72 * 3600e3; });
    if (!r) continue; n++; const ok = exact(r); if (ok) asIs++;
    const b = (byR[e.react!] ??= { n: 0, a: 0 }); b.n++; if (ok) b.a++;
    if (!ok) {
      const d = String(r.ai_draft), s = String(r.sent_reply);
      const dAmt = [...d.replace(/[,，]/g, "").matchAll(/(\d{4,7})\s*円/g)].map((m) => +m[1]);
      const known = new Set(e.items.flatMap((it) => [it.initialCostYen, it.discountYen]).filter(Boolean) as number[]);
      const miss = AMT_RE.test(s) && !AMT_RE.test(d); if (miss) amtMiss++;
      const wrong = dAmt.some((y) => !known.has(y) && !e.mentionedYen.includes(y)); if (wrong) amtWrong++;
      rew.push(`${e.conv.slice(0, 8)} [${e.react}${miss ? "・実だけ費用語" : ""}${wrong ? "・下書きに見積に無い金額" : ""}] 見積:${e.items.map((it) => `${it.propertyName.slice(0, 10)} 総${it.initialCostYen} 割${it.discountYen}`).join("｜")}\n   客:${mask(e.turns[0].parts.join(" / ")).slice(0, 160)}\n   ▼AI:${mask(d).slice(0, 240)}\n   ▲実:${mask(s).slice(0, 240)}`);
    }
  }
  console.log(`\n■ 見積書の後の返信（下書きあり）${n}・そのまま送信 ${pct(asIs, n)}（全体 ${pct(ex.filter(exact).length, ex.length)}・${ex.length}組）`, Object.fromEntries(Object.entries(byR).map(([k, v]) => [k, `${v.a}/${v.n}`])));
  console.log(`  書き直し ${n - asIs}: 実送信だけに費用・見積の語 ${amtMiss}・下書きに見積書に無い金額 ${amtWrong}`);

  const bl = (await page("brain_decision_logs", "conversation_id, created_at, suggested_action, actual_aix_type, matched", since)).filter((r) => convOk.has(r.conversation_id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blBy = new Map<string, any[]>(); for (const r of bl) { const a = blBy.get(r.conversation_id) ?? []; a.push(r); blBy.set(r.conversation_id, a); }
  const mis: Record<string, number> = {}; const misEx: string[] = []; let bn = 0, bm = 0;
  for (const e of evs) {
    if (!e.turns.length) continue;
    const rows = (blBy.get(e.conv) ?? []).filter((r) => { const t = Date.parse(r.created_at); return t >= e.turns[0].t - 60e3 && t < e.t + 72 * 3600e3 && r.matched != null; });
    const r = rows[0]; if (!r) continue; bn++; if (r.matched) { bm++; continue; }
    const k = `${r.suggested_action ?? "なし"}→${r.actual_aix_type ?? "なし"}`; mis[k] = (mis[k] ?? 0) + 1;
    misEx.push(`${e.conv.slice(0, 8)} [${e.react}] ${k} 見積:${e.items.map((it) => `総${it.initialCostYen} 割${it.discountYen}`).join("｜")} 客:${mask(e.turns[0].parts.join(" / ")).slice(0, 140)} => ${mask(e.staffAfter).slice(0, 120)}`);
  }
  console.log(`\n■ ブレイン（見積書の後の最初の判断・matched 記録あり）${bn}・一致 ${pct(bm, bn)}・外れ ${bn - bm}`, Object.entries(mis).sort((a, b) => b[1] - a[1]));
  if (OUT) {
    const lines: string[] = [];
    for (const e of evs) lines.push(`${e.conv.slice(0, 8)}\t${new Date(e.t).toISOString().slice(0, 16)}\t${e.src}\t${e.resend ? "再" : ""}\t${e.items.map((it) => `${it.propertyName.slice(0, 12)}${it.roomNo ?? ""} 総${it.initialCostYen} 割${it.discountYen}`).join("｜")}\t${e.react}\t[${e.reactKinds!.join(",")}]\t${e.which}\t${e.out}\t${e.turns.map((t) => mask(t.parts.join(" / "))).join(" ‖ ").slice(0, 300)}\t=> ${mask(e.staffAfter).slice(0, 200)}`);
    writeFileSync(OUT, lines.join("\n"));
    writeFileSync(OUT + ".rewrites.txt", rew.join("\n"));
    writeFileSync(OUT + ".brain.txt", misEx.join("\n"));
  }
}
main();
