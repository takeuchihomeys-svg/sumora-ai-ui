// 状況が切り替わる場面（1つの物件にとらわれていないか）を実データで測る（読み取りのみ・LLM は呼ばない・本文はマスクして出す）
// 2026-09-26 竹内「内覧終了して別の物件に切り替える／申込して押さえながら他も探す／見積書→申込誘導／別の物件なら切り替える
//   など判断の切り替え部分があるか。いつまでも1つの物件にとらわれないようになっているか」
//
// 測ること（直近 DAYS 日・グループと YUMA を除く）:
//   ① 場面をお客様の1ターン（連投をまとめた単位）ごとに決定論で拾う（SCENES の順・1ターンに複数付くこともある）
//   ② その後 48 時間のスタッフの動き（最初の AIX の種類・手打ちの中身の種類・何分後）
//   ③ そのターンのブレインの判断（brain_decision_logs・analyzed_msg_ts がターンの最後の発言と一致する最後の行）と突き合わせ
//      - 一致: ブレインの aix とスタッフの最初の AIX が同じ（両方なし＝手打ちだけ も一致）
//      - とらわれ: 切り替えの場面で、ブレインの prop（話題の中心の物件）か方向が前の物件（焦点）のまま、または
//        前の物件向けの AIX（申込へ・見積・待ち合わせ・内覧のご案内）を出したのに、スタッフは探す・新しい物件の確認に動いた
//   OUT=<file> で場面ごとの実物（マスク済み）を書き出す（目で読む用）。PER=件数（既定 12）
//
// 2026-09-26 の結論（設計知見「1つの物件へのとらわれは…1手しか出せない・お部屋ごとの状態が無い」）:
//   ★とらわれ の決定論の候補は目で読むと大半が誤検出（15件中 本物3件）。ブレインは切り替えている。
//   弱い所は ①二本立て（探す＋申込/見積/確認）をスタッフは 18〜35% でするがブレインは片方だけ ②お部屋ごとの状態が構造化されていない
//   ③guard:viewing（退去予定の補正）が物件をまたいで効く。P（番手）は「1番手でお部屋抑え」も拾う広い場面なので件数は参考
//
// 実行: npx tsx --env-file=.env.local scripts/audit-switch-scenes.ts   （DAYS=180・OUT=・PER=12）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const PER = Number(process.env.PER ?? 12);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page<T>(table: string, cols: string, since: string | null, extra?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) {
    let q = sb.from(table).select(cols).order("created_at").range(p * 1000, p * 1000 + 999);
    if (since) q = q.gte("created_at", since);
    if (extra) q = extra(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");
const mask = (s: string) => s
  .replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]")
  .replace(/〒?\d{3}-?\d{4}/g, "[郵便]")
  .replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1")
  .replace(/https?:\/\/\S+/g, "[URL]")
  .replace(/\s+/g, " ");

// ── 語彙 ─────────────────────────────────────────────
const URL_RE = /https?:\/\/\S*(suumo|homes|athome|chintai|canary|door|smocca|mansion-review|goodrooms|able|apamanshop|minimini|eheya|ielove|realpro|itandi)/i;
const OTHER_PROP_RE = /(別の|他の|ほかの|違う|もう一(つ|件)の)(物件|お部屋|部屋|マンション)|こちら(の物件|のお部屋)?(も|は)(空|募集|どう|見|内覧|内見)|この(物件|お部屋|部屋)(も|は|って|ですが)|(他|ほか)(にも|も)(ある|あり|見|探|気にな)/;
const KEEP_SEARCH_RE = /(他|ほか)(の(物件|お部屋))?(も|にも)[^。\n]{0,8}(探|見|検討|紹介|送)|引き続き(探|お探し|物件|お部屋)|並行して/;
const APPLY_INTENT_RE = /申し?込(み|む|みたい|みます|ませ|んで|もう|ませて|みを)|ここに(します|決め)|こちら(で|に)(お願い|決め)|決め(ました|たい|ます)|契約(したい|します|させて)|抑え(て|たい)|押さえ(て|たい)/;
const APPLY_NEG_RE = /申し?込(み)?(前|まで|の前|をする前|方法|って|とは|の流れ|はまだ)|まだ決め|決めかね|決め(られ|切れ)/;
const EST_REQ_RE = /見積|初期費用[^。\n]{0,10}(教え|知り|いくら|出して|頂け|いただけ|お願い|ください|送)/;
const CANCEL_RE = /キャンセル|辞退|取り?(消|下)げ|やめ(ます|とき|ておき|たい|ようかな)|見送(り|ら|ります)|今回は(なし|無し|大丈夫)/;
const COND_RE = /(予算|家賃|上限)[^。\n]{0,12}(上げ|下げ|まで(なら|で)|変更|でも(大丈夫|いい|良い|可)|増や|広げ)|エリア[^。\n]{0,10}(広げ|変|追加|も(大丈夫|可|OK))|(間取り|1LDK|2LDK|2DK|1DK|1K|ワンルーム)[^。\n]{0,8}(でも(大丈夫|いい|良い|可)|に変|も可|も(大丈夫|OK))|入居(時期|日|希望)[^。\n]{0,12}(変|早|遅|延|ずれ|前倒|伸び)|条件[^。\n]{0,4}(変|追加|緩|広げ|見直)|やっぱり[^。\n]{0,20}(駅|エリア|区|線|間取|家賃|予算|広)/;
const VIEW_WORD = /内覧|内見|見学|見に行/;
const RESCHED_RE = /キャンセル|延期|日程(を)?変更|変更(して|でき|可能)|行けな|行け(ません|なく)|難しく|別の日|リスケ|ずらし|また今度|改めて/;
const FAMILY_RE = /(親|母|父|両親|家族|旦那|主人|夫|妻|嫁|彼氏|彼女|パートナー|相方|同居人|息子|娘|婚約者)[^。\n]{0,14}(相談|意見|反対|確認|話し合|と決め|が言|が気に|がダメ|次第|に聞)/;
const OTHER_CO_RE = /他社|他の(不動産|業者|会社|ところ)|別の(不動産|業者|会社|ところ)|ほかの(不動産|業者)|他で(決|見つ|契約)|別(で|の所で)決/;
const COMPARE_RE = /迷って|悩んで|迷い|悩み中|どっちが|どちらが|どちらか|比較|比べ/;
// スタッフの語
const SCREEN_FAIL_RE = /否決|審査[^。\n]{0,6}(通ら|落ち|通過(出来|でき)ませ|厳しい結果|NG)|審査結果[^。\n]{0,10}(厳し|残念|通ら)/;
const SCREEN_FAIL_EXCL = /否決・キャンセルの場合|否決の場合|否決(され)?た?場合|1番手|繰り上/;
const TAKEN_RE = /募集終了|申込(み)?(が)?(入って|入り|ございま|有り|あり)|タッチの差|埋まって|成約済|先に(申込|お申込)/;
const NOT_OURS_RE = /専任|弊社(で|では)(は)?ご?紹介(出来|でき)ない|ご紹介(出来|でき)ないお部屋|業者(様)?(へ|に)(は)?(紹介|公開)(されて)?(い)?ない/;
const RANK_RE = /[2-9２-９二三]番手|番手(で|と|に)|繰り上が/;
const MOVEIN_MISMATCH_RE = /(ご)?入居[^。\n]{0,12}(難し|出来かね|できかね|間に合わ|合わな)|退去予定[^。\n]{0,24}(ご入居|入居可能|内覧(出来|でき|不可))|(最長|最大)[^。\n]{0,12}(ご入居|入居)[^。\n]{0,8}(待|お待ち)/;
const VIEW_THANKS_RE = /(本日|先程|昨日|先日)[^。\n]{0,8}(お時間|ご内覧|ご内見|内覧|内見)[^。\n]{0,12}(ありがとうございま|頂き|いただき)|ご?内覧(頂き|いただき|して頂き)ありがとう|内見ありがとう|内覧お疲れ/;
const CUST_VIEW_DONE_RE = /(内覧|内見|案内)[^。\n]{0,8}(ありがとうございま|有難う|ありがとう)|本日(は)?ありがとうございました|今日(は)?ありがとうございました/;

type Kind = "SEARCH" | "APPLY" | "EST" | "CHECK" | "VIEW" | "OTHER";
function staffTextKind(t: string): Kind[] {
  const k: Kind[] = [];
  if (/ピックアップ|お探し|新着|オススメ出来るお部屋|ご条件に合(った|う)お部屋|お部屋(を)?(お送り|送らせ)|引き続き[^。\n]{0,10}(お部屋|物件)/.test(t)) k.push("SEARCH");
  if (/お申し?込|申込フォーム|お部屋抑え|お部屋を抑え|押さえ/.test(t)) k.push("APPLY");
  if (/御見積|見積書/.test(t)) k.push("EST");
  if (/募集状況|募集して(おり|ます)|募集終了|空き状況|確認させて(頂|いただ)/.test(t)) k.push("CHECK");
  if (/ご内覧|ご案内|内見|現地|お待ち合わせ/.test(t)) k.push("VIEW");
  if (!k.length) k.push("OTHER");
  return k;
}
// AIX の種類を「動きの類」に
const AIX_CLASS: Record<string, string> = {
  property_send: "探す", property_recommendation: "探す", condition_hearing: "探す", property_search: "探す",
  property_check_result: "確認", acknowledge_check: "確認",
  estimate_sheet: "見積", cost_explain: "見積", cost_breakdown: "見積",
  viewing_invite: "内覧", meeting_place: "内覧", greeting_viewing: "内覧",
  application_push: "申込", guarantor_info: "申込",
};
const cls = (a: string | null | undefined) => (a ? AIX_CLASS[a] ?? "他" : "なし");
const FOCUS_AIX = new Set(["estimate_sheet", "application_push", "meeting_place", "viewing_invite", "property_check_result"]);

// 物件名の正規化（号室・階・空白を落として先頭の語）
function normProp(s: string): string {
  return s.replace(/[\s　]/g, "").replace(/(\d+階)?\d*号室?$/, "").replace(/\d+階$/, "").replace(/[()（）【】「」]/g, "").toLowerCase();
}
function sameProp(a: string, b: string): boolean {
  const x = normProp(a), y = normProp(b);
  if (x.length < 3 || y.length < 3) return false;
  const k = Math.min(5, x.length, y.length);
  return x.includes(y.slice(0, k)) || y.includes(x.slice(0, k));
}

type Msg = { conversation_id: string; sender: string; text: string | null; image_url: string | null; image_type: string | null; created_at: string; is_aix_generated: boolean | null; t: number };
type Aix = { type: string; t: number; props: string[] };
type Brain = { t: number; ats: number; aix: string | null; prop: string | null; dir: string | null; shift: string | null; src: string | null };
type Turn = { conv: string; t0: number; t1: number; text: string; hasImg: boolean; hasUrl: boolean; idx: number };

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const since2 = new Date(Date.now() - (DAYS + 30) * 86400e3).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convs = await page<any>("conversations", "id, status, line_source_type, created_at, customer_name", null);
  const convOk = new Map<string, string>();
  for (const c of convs) if (c.id !== YUMA && c.line_source_type !== "group") convOk.set(c.id, c.status ?? "?");
  const convName = new Map<string, string>();
  for (const c of convs) if (typeof c.customer_name === "string" && c.customer_name.trim().length >= 2) convName.set(c.id, c.customer_name.trim());
  const msgs = (await page<Msg>("messages", "conversation_id, sender, text, image_url, image_type, created_at, is_aix_generated", since2))
    .filter((m) => convOk.has(m.conversation_id)).map((m) => ({ ...m, t: Date.parse(m.created_at) }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aixRows = await page<any>("aix_usage_logs", "conversation_id, aix_type, created_at, sent_at, property_names", since2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brainRows = await page<any>("brain_decision_logs", "conversation_id, created_at, suggested_action, analyzed_msg_ts, decision_source, digest", null);
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const aixBy = new Map<string, Aix[]>();
  for (const a of aixRows) {
    if (!convOk.has(a.conversation_id)) continue;
    const props: string[] = Array.isArray(a.property_names) ? a.property_names.map(String) : [];
    if (!aixBy.has(a.conversation_id)) aixBy.set(a.conversation_id, []);
    aixBy.get(a.conversation_id)!.push({ type: a.aix_type ?? "?", t: Date.parse(a.sent_at ?? a.created_at), props: props.map((p) => p.trim()).filter((p) => p.length >= 3) });
  }
  for (const l of aixBy.values()) l.sort((x, y) => x.t - y.t);
  const brainBy = new Map<string, Brain[]>();
  for (const b of brainRows) {
    if (!convOk.has(b.conversation_id)) continue;
    const d = b.digest ?? {};
    if (!brainBy.has(b.conversation_id)) brainBy.set(b.conversation_id, []);
    brainBy.get(b.conversation_id)!.push({ t: Date.parse(b.created_at), ats: b.analyzed_msg_ts ? Date.parse(b.analyzed_msg_ts) : NaN, aix: b.suggested_action ?? d.aix ?? null, prop: d.prop ?? null, dir: d.dir ?? null, shift: d.shift ?? null, src: b.decision_source ?? null });
  }
  const brainSince = Math.min(...brainRows.map((b) => Date.parse(b.created_at)));
  const sinceMs = Date.parse(since);
  console.log(`直近${DAYS}日・会話 ${new Set(msgs.map((m) => m.conversation_id)).size}・メッセージ ${msgs.length}・AIX ${aixRows.length}・ブレインの判断ログ ${brainRows.length}（${new Date(brainSince).toISOString().slice(0, 10)}〜）`);

  // ── お客様のターン ─────────────────────────
  const turns: Turn[] = [];
  for (const [conv, list] of byConv) {
    list.sort((a, b) => a.t - b.t);
    let cur: Turn | null = null;
    list.forEach((m, i) => {
      if (m.sender === "customer") {
        if (!cur) cur = { conv, t0: m.t, t1: m.t, text: "", hasImg: false, hasUrl: false, idx: i };
        cur.t1 = m.t; cur.text += (cur.text ? " ／ " : "") + (m.text ?? "");
        if (m.image_url && (m.image_type == null || m.image_type === "property_photo" || m.image_type === "floor_plan")) cur.hasImg = true;
        if (URL_RE.test(m.text ?? "")) cur.hasUrl = true;
      } else if (cur) { if (cur.t0 >= sinceMs) turns.push(cur); cur = null; }
    });
    if (cur && (cur as Turn).t0 >= sinceMs) turns.push(cur);
  }

  type Ev = {
    scene: string; conv: string; staffMove: string; newSig: boolean; tracks: string[]; t0: number; t1: number; text: string; status: string;
    focus: string[]; nextAix: Aix | null; aix48: string[]; staffKinds: Kind[]; staffText: string; mins: number | null;
    brain: Brain | null; match: boolean | null; stuck: string | null; newProps: string[];
  };
  const evs: Ev[] = [];

  for (const tu of turns) {
    const list = byConv.get(tu.conv)!;
    const aixs = aixBy.get(tu.conv) ?? [];
    const before = list.filter((m) => m.t < tu.t0);
    const staffBefore = before.filter((m) => m.sender !== "customer");
    const aixBefore = aixs.filter((a) => a.t < tu.t0);
    const lastAny = before.length ? before[before.length - 1].t : null;
    // 焦点の物件: 直近14日の見積・申込へ・待ち合わせ・内覧のご案内・物件確認した の物件（新しい順・最大3）
    const focus: string[] = [];
    for (const a of [...aixBefore].reverse()) {
      if (tu.t0 - a.t > 14 * 86400e3) break;
      if (!FOCUS_AIX.has(a.type)) continue;
      for (const p of a.props) if (!focus.some((f) => sameProp(f, p))) focus.push(p);
      if (focus.length >= 3) break;
    }
    const hasFocusAix = (types: string[], days: number) => aixBefore.some((a) => types.includes(a.type) && tu.t0 - a.t < days * 86400e3);
    // 内覧が済んだ（72時間以内）: スタッフの内覧お礼 or お客様の内覧お礼（待ち合わせの後）
    const viewedAt = [...before].reverse().find((m) => tu.t0 - m.t < 72 * 3600e3 && ((m.sender !== "customer" && VIEW_THANKS_RE.test(m.text ?? "")) || (m.sender === "customer" && CUST_VIEW_DONE_RE.test(m.text ?? "") && hasFocusAix(["meeting_place", "viewing_invite"], 10))));
    const viewDoneInTurn = CUST_VIEW_DONE_RE.test(tu.text) && hasFocusAix(["meeting_place", "viewing_invite"], 10);
    const afterViewing = !!viewedAt || viewDoneInTurn;
    // 申込済み（30日以内）: 申込へ押下 or 申込書の記入・本人確認書類の受信
    const appliedAt = [...aixBefore].reverse().find((a) => a.type === "application_push" && tu.t0 - a.t < 30 * 86400e3)?.t
      ?? [...before].reverse().find((m) => tu.t0 - m.t < 30 * 86400e3 && m.sender === "customer" && (/【お申込者様記入欄】|お申込者様/.test(m.text ?? "") || m.image_type === "id_document"))?.t ?? null;
    const t = tu.text;
    const newPropSignal = tu.hasImg || tu.hasUrl || OTHER_PROP_RE.test(t);
    const scenes: string[] = [];
    if (afterViewing) {
      if (APPLY_INTENT_RE.test(t) && !APPLY_NEG_RE.test(t)) scenes.push("A2 内覧後にその物件で進む");
      else if (newPropSignal || KEEP_SEARCH_RE.test(t) || COND_RE.test(t) || CANCEL_RE.test(t)) scenes.push("A1 内覧後に別の物件へ・条件の見直し");
      else scenes.push("A0 内覧後の反応（保留・お礼）");
    }
    if (appliedAt && (newPropSignal || KEEP_SEARCH_RE.test(t))) scenes.push("B 申込後に他の物件も見る");
    if (appliedAt && CANCEL_RE.test(t) && !VIEW_WORD.test(t)) scenes.push("F 申込後のキャンセル・辞退");
    if (EST_REQ_RE.test(t)) scenes.push(focus.length ? "C1 見積の依頼（焦点の物件あり）" : "C0 見積の依頼（焦点なし）");
    if (!afterViewing && !appliedAt && focus.length && newPropSignal) scenes.push("D 焦点がある時に別の物件の話");
    if (COND_RE.test(t)) scenes.push("G 条件が変わった");
    if (VIEW_WORD.test(t) && RESCHED_RE.test(t)) scenes.push("I 内覧の日程が流れた・変更");
    if (lastAny != null && tu.t0 - lastAny > 7 * 86400e3) scenes.push("J 7日以上の沈黙の後に戻った");
    if (FAMILY_RE.test(t)) scenes.push("K 家族・同居人の意見");
    if (OTHER_CO_RE.test(t)) scenes.push("L 他社・他で決まりそう");
    if (COMPARE_RE.test(t) && (focus.length >= 2 || /どちら|どっち|比較|比べ/.test(t))) scenes.push("M 複数の候補を比べる・迷う");
    if (!appliedAt && !afterViewing && APPLY_INTENT_RE.test(t) && !APPLY_NEG_RE.test(t) && focus.length) scenes.push("N 内覧なしで申込の意思");
    // スタッフ起点の場面（直前のこちらの発言が否決・焦点の物件の募集終了）はこのターンの直前に付ける
    const lastStaff = staffBefore.length ? staffBefore[staffBefore.length - 1] : null;
    // 直前のこちらの発言（前のお客様のターンより後）だけを見る＝否決・埋まったの後の最初のターン
    const prevCustT = [...before].reverse().find((m) => m.sender === "customer")?.t ?? 0;
    const staffRecent = staffBefore.filter((m) => m.t > prevCustT && tu.t0 - m.t < 72 * 3600e3);
    if (staffRecent.some((m) => NOT_OURS_RE.test(m.text ?? ""))) scenes.push("O 紹介できない物件（専任・業者非公開）の後");
    if (staffRecent.some((m) => RANK_RE.test(m.text ?? ""))) scenes.push("P 番手（2番手・繰り上がり待ち）の後");
    if (staffRecent.some((m) => MOVEIN_MISMATCH_RE.test(m.text ?? ""))) scenes.push("Q 入居時期が合わない物件の後");
    if (staffRecent.some((m) => SCREEN_FAIL_RE.test(m.text ?? "") && !SCREEN_FAIL_EXCL.test(m.text ?? ""))) scenes.push("E 審査否決の後");
    if (staffRecent.some((m) => TAKEN_RE.test(m.text ?? "") && focus.some((f) => (m.text ?? "").replace(/\s/g, "").includes(normProp(f).slice(0, 4)))) && hasFocusAix(["estimate_sheet", "application_push", "meeting_place", "viewing_invite"], 14)) scenes.push("H 気に入った物件が埋まった");
    void lastStaff;
    if (!scenes.length) continue;

    // スタッフのその後（48h）
    const after = list.filter((m) => m.t > tu.t1 && m.t - tu.t1 < 48 * 3600e3);
    const firstStaff = after.find((m) => m.sender !== "customer");
    const nextCust = after.find((m) => m.sender === "customer" && firstStaff && m.t > firstStaff.t);
    const aixAfter = aixs.filter((a) => a.t > tu.t1 && a.t - tu.t1 < 48 * 3600e3);
    // 次のお客様のターンまでに押された AIX を「このターンへの動き」とする
    const horizon = nextCust ? nextCust.t : tu.t1 + 48 * 3600e3;
    const aixTurn = aixAfter.filter((a) => a.t <= horizon + 60e3);
    const staffTurnTexts = after.filter((m) => m.sender !== "customer" && m.t <= horizon && !m.is_aix_generated && m.text).map((m) => m.text!);
    const staffKinds = Array.from(new Set(staffTurnTexts.flatMap(staffTextKind)));
    const nextAix = aixTurn[0] ?? null;
    // このターンへのスタッフの動きの「線」（AIX の類＋手打ちの中身）。探す＋申込 のような二本立てを数える
    const KMAP: Record<string, string> = { SEARCH: "探す", APPLY: "申込", EST: "見積", CHECK: "確認", VIEW: "内覧" };
    const tracks = Array.from(new Set([...aixTurn.map((a) => cls(a.type)).filter((c) => c !== "他"), ...staffKinds.map((k) => KMAP[k]).filter(Boolean)]));
    const mins = firstStaff ? Math.round((firstStaff.t - tu.t1) / 60e3) : null;
    const newProps = aixTurn.flatMap((a) => a.props).filter((p) => !focus.some((f) => sameProp(f, p)));
    // ブレイン（このターンの最後の発言を分析した最後の行）
    const bl = (brainBy.get(tu.conv) ?? []).filter((b) => (Number.isFinite(b.ats) ? Math.abs(b.ats - tu.t1) < 5000 : (b.t >= tu.t1 && b.t - tu.t1 < 20 * 60e3)) && (!firstStaff || b.t <= firstStaff.t));
    const brain = bl.length ? bl[bl.length - 1] : null;
    let match: boolean | null = null, stuck: string | null = null;
    const textMove = staffKinds.includes("APPLY") ? "申込" : staffKinds.includes("SEARCH") ? "探す" : staffKinds.includes("EST") ? "見積" : staffKinds.includes("CHECK") ? "確認" : staffKinds.includes("VIEW") ? "内覧" : "なし";
    const staffMove = nextAix ? cls(nextAix.type) : textMove;
    if (brain) {
      const bc = cls(brain.aix);
      match = bc === staffMove || (bc === "なし" && textMove === "なし") || (!nextAix && bc === textMove);
      const staffMovedAway = staffMove === "探す" || (staffMove === "確認" && (newProps.length > 0 || newPropSignal));
      const brainOnOld = focus.length > 0 && (
        (brain.prop && focus.some((f) => sameProp(f, brain.prop!))) ||
        (brain.dir && focus.some((f) => brain.dir!.replace(/\s/g, "").includes(normProp(f).slice(0, 4)))));
      const brainOldAix = brain.aix && ["application_push", "estimate_sheet", "meeting_place", "viewing_invite"].includes(brain.aix);
      if (staffMovedAway && (brainOnOld || brainOldAix) && cls(brain.aix) !== "探す") stuck = brainOnOld ? (brainOldAix ? "物件も AIX も前のまま" : "話題の物件が前のまま") : "前の物件向けの AIX";
    }
    for (const sc of scenes) evs.push({ scene: sc, conv: tu.conv, staffMove, newSig: newPropSignal, tracks, t0: tu.t0, t1: tu.t1, text: t, status: convOk.get(tu.conv)!, focus, nextAix, aix48: aixAfter.map((a) => a.type), staffKinds, staffText: staffTurnTexts.join(" ／ "), mins, brain, match, stuck, newProps });
  }

  // ── 集計 ─────────────────────────────
  const scenesOrder = Array.from(new Set(evs.map((e) => e.scene))).sort();
  const won = (s: string) => s === "closed_won";
  const applied = (s: string) => s === "applying" || s === "screening";
  console.log("\n場面 | ターン | 会話 | 成約会話 | 申込中 | スタッフ返信率 | 中央分 | スタッフの最初の AIX（類） | 手打ちの中身 | ブレインあり | 一致 | とらわれ");
  const lines: string[] = [];
  for (const sc of scenesOrder) {
    const es = evs.filter((e) => e.scene === sc);
    const convsS = new Set(es.map((e) => e.conv));
    const wonC = new Set(es.filter((e) => won(e.status)).map((e) => e.conv)).size;
    const appC = new Set(es.filter((e) => applied(e.status)).map((e) => e.conv)).size;
    const replied = es.filter((e) => e.mins != null);
    const ms = replied.map((e) => e.mins!).sort((a, b) => a - b);
    const med = ms.length ? ms[Math.floor(ms.length / 2)] : null;
    const aixC: Record<string, number> = {};
    for (const e of es) { const k = e.nextAix ? `${cls(e.nextAix.type)}:${e.nextAix.type}` : "AIXなし"; aixC[k] = (aixC[k] ?? 0) + 1; }
    const kindC: Record<string, number> = {};
    for (const e of es) for (const k of e.staffKinds) kindC[k] = (kindC[k] ?? 0) + 1;
    const withBrain = es.filter((e) => e.brain);
    const m = withBrain.filter((e) => e.match).length;
    const st = withBrain.filter((e) => e.stuck).length;
    const top = Object.entries(aixC).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}(${pct(v, es.length)})`).join("・");
    const kinds = Object.entries(kindC).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${pct(v, es.length)}`).join("・");
    const line = `${sc} | ${es.length} | ${convsS.size} | ${wonC} | ${appC} | ${pct(replied.length, es.length)} | ${med ?? "—"} | ${top} | ${kinds} | ${withBrain.length} | ${pct(m, withBrain.length)} | ${st}`;
    console.log(line); lines.push(line);
  }
  console.log("\n二本立て（このターンにスタッフが 探す と 申込/見積/内覧/確認 を両方した）");
  for (const sc of scenesOrder) {
    const es = evs.filter((e) => e.scene === sc && e.tracks.length);
    const two = es.filter((e) => e.tracks.includes("探す") && e.tracks.some((t) => t !== "探す"));
    const brainTwo = two.filter((e) => e.brain);
    console.log(`${sc}: ${two.length}/${es.length}（${pct(two.length, es.length)}）・うちブレインあり ${brainTwo.length}（ブレインが探す ${brainTwo.filter((e) => cls(e.brain!.aix) === "探す").length}・他の線 ${brainTwo.filter((e) => cls(e.brain!.aix) !== "探す").length}）`);
  }
  // 成約した会話だけのスタッフの動き（過半数の形を見る）
  console.log("\n【成約した会話だけ】場面 | ターン | 最初の AIX の類");
  for (const sc of scenesOrder) {
    const es = evs.filter((e) => e.scene === sc && won(e.status));
    if (!es.length) continue;
    const c: Record<string, number> = {};
    for (const e of es) { const k = e.nextAix ? cls(e.nextAix.type) : (e.staffKinds.includes("SEARCH") ? "手打ち:探す" : e.staffKinds.includes("APPLY") ? "手打ち:申込" : "手打ち:他"); c[k] = (c[k] ?? 0) + 1; }
    console.log(`${sc} | ${es.length} | ${Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  // とらわれの内訳
  const stuckEvs = evs.filter((e) => e.stuck);
  console.log(`\nとらわれ（ブレインあり ${evs.filter((e) => e.brain).length} 件中 ${stuckEvs.length}）`);
  const sk: Record<string, number> = {};
  for (const e of stuckEvs) sk[e.stuck!] = (sk[e.stuck!] ?? 0) + 1;
  console.log(sk);
  // ブレインの外れ方（切り替えの場面で）ブレイン類×スタッフ類
  console.log("\nブレインの類 → スタッフの類（ブレインあり・場面ごと）");
  for (const sc of scenesOrder) {
    const es = evs.filter((e) => e.scene === sc && e.brain);
    if (!es.length) continue;
    const c: Record<string, number> = {};
    for (const e of es) { const k = `${cls(e.brain!.aix)}→${e.staffMove}`; c[k] = (c[k] ?? 0) + 1; }
    console.log(`${sc}: ${Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }

  console.log("\n不一致の出所（decision_source・ブレインあり・場面ごと）");
  for (const sc of scenesOrder) {
    const es = evs.filter((e) => e.scene === sc && e.brain && !e.match);
    if (!es.length) continue;
    const c: Record<string, number> = {};
    for (const e of es) { const k = String(e.brain!.src ?? "llm/なし").replace(/:.*/, ":*"); c[k] = (c[k] ?? 0) + 1; }
    console.log(`${sc}: ${Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  // 2026-09-26 段3: YUMA で前後を比べる実物を書き出す（REPLAY_OUT=<file>）。場面ごとに「スタッフが両方した回」2件＋「片方だけ」1件（直近 REPLAY_DAYS 日・会話は重複させない）。
  //   本文は伏せる（名前→YUMA・電話・URL はポータルの形に）。時刻は場面の最後からの分で、間は最大3時間に縮める（YUMA の既存の発言と混ざらないように）。
  //   scripts/yuma-switch-scenes-test.ts が読んで YUMA に入れ、ブレインの前（HEAD）・後（作業コピー）を取る
  if (process.env.REPLAY_OUT) {
    const REPLAY_SCENES = ["A0 内覧後の反応（保留・お礼）", "A1 内覧後に別の物件へ・条件の見直し", "B 申込後に他の物件も見る", "P 番手（2番手・繰り上がり待ち）の後"];
    const rdays = Number(process.env.REPLAY_DAYS ?? 60);
    // 個人情報を YUMA の会話に入れない: 申込のフォーム（氏名・生年月日・住所）は中身ごと伏せる／表示名・行頭の「〇〇さん」／電話・メール・郵便番号・生年月日・住所の行
    const callNameCache = new Map<string, string[]>();
    const callNames = (conv: string): string[] => {
      if (callNameCache.has(conv)) return callNameCache.get(conv)!;
      const c = new Map<string, number>();
      for (const m of byConv.get(conv) ?? []) {
        if (m.sender === "customer") continue;
        for (const x of (m.text ?? "").matchAll(/(?:^|\n)([^\s、。！!？?「」（）()\n:：]{1,8})(?:さん|様)/g)) if (!/YUMA|お客|皆|担当|オーナー/.test(x[1])) c.set(x[1], (c.get(x[1]) ?? 0) + 1);
      }
      const names = [...c.entries()].filter(([, n]) => n >= 1).map(([k]) => k).sort((a, b) => b.length - a.length);
      callNameCache.set(conv, names);
      return names;
    };
    const maskReplay = (s: string, conv: string, sender: string) => {
      if (/記入欄】|氏名|生年月日|フリガナ/.test(s)) return sender === "customer" ? "【お申込者様記入欄】（ご記入済み・内容は伏せた）" : ["【お申込者様記入欄】", "・入居希望日", "・氏名、フリガナ", "・現住所", "・携帯番号", "（申込時フォーマット・項目の一覧）"].join("\n");
      let t = s;
      const nm = convName.get(conv);
      if (nm) t = t.split(nm).join("YUMA");
      // スタッフが行頭で呼んでいる名前（「あやさん\n」「〇〇さんお世話に」）をこの会話の中で全部伏せる
      for (const n of callNames(conv)) t = t.split(n).join("YUMA");
      return t
        .split("\n").filter((l) => !/〒|住所|現住所|生年月日|@|メール/.test(l)).join("\n")
        .replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "")
        .replace(/\d{4}年\d{1,2}月\d{1,2}日/g, "")
        .replace(/(^|\n)[^\s、。！!？?「」（）()\n:：]{1,10}(さん|様)/g, "$1YUMA$2")
        .replace(/(で|、|。|！|!|\s)(?!YUMA)([A-Za-zぁ-んァ-ヶ一-龯]{1,6})(さん|様)(?=[にのがはをもへとご達、！!])/g, "$1YUMA$3")
        .replace(/https?:\/\/\S+/g, (u) => (URL_RE.test(u) ? "https://suumo.jp/chintai/jnc_000000000000/" : "https://example.com/"));
    };
    const used = new Set<string>();
    const out: unknown[] = [];
    // REPLAY_PICK="7beca4f5@2026-07-29,..." で特定のターンを選ぶ（会話の先頭8桁@JST の日付・場面は問わない）。REPLAY_MSGS=通数（既定12）・REPLAY_GAP=間の上限の分（既定180）
    const pickSpec = (process.env.REPLAY_PICK ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [c, d] = x.split("@"); return { c, d }; });
    const jstDate = (t: number) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
    const nMsgs = Number(process.env.REPLAY_MSGS ?? 12);
    const gapCap = Number(process.env.REPLAY_GAP ?? 180);
    const sceneList = pickSpec.length ? ["(指定)"] : REPLAY_SCENES;
    for (const sc of sceneList) {
      let pick: typeof evs = [];
      if (pickSpec.length) {
        for (const ps of pickSpec) { const e = evs.find((x) => x.conv.startsWith(ps.c) && jstDate(x.t1) === ps.d && !pick.some((y) => y.conv === x.conv && y.t1 === x.t1)); if (e) pick.push(e); else console.log(`（指定のターンが場面に無い: ${ps.c}@${ps.d}）`); }
      } else {
        const es = evs.filter((e) => e.scene === sc && Date.now() - e.t1 < rdays * 86400e3 && e.tracks.length).sort((a, b) => b.t1 - a.t1);
        const two = es.filter((e) => e.tracks.includes("探す") && e.tracks.some((t) => t !== "探す"));
        const one = es.filter((e) => !two.includes(e));
        for (const e of two) { if (pick.length >= 2) break; if (!used.has(e.conv)) { pick.push(e); used.add(e.conv); } }
        for (const e of one) { if (pick.length >= 3) break; if (!used.has(e.conv)) { pick.push(e); used.add(e.conv); } }
      }
      for (const e of pick) {
        const list = byConv.get(e.conv)!;
        const upto = list.filter((m) => m.t <= e.t1).slice(-nMsgs);
        const aixs = aixBy.get(e.conv) ?? [];
        // 時刻: 場面の最後からの分。間は最大180分に縮める
        const mins: number[] = new Array(upto.length).fill(1);
        let acc = 1;
        for (let i = upto.length - 1; i >= 0; i--) {
          mins[i] = acc;
          if (i > 0) acc += Math.max(1, Math.min(gapCap, Math.round((upto[i].t - upto[i - 1].t) / 60e3)));
        }
        out.push({
          id: `${(pickSpec.length ? e.scene : sc).slice(0, 2).trim()}-${e.conv.slice(0, 8)}`, scene: pickSpec.length ? e.scene : sc, conv8: e.conv.slice(0, 8), status: e.status,
          staffMove: e.staffMove, tracks: e.tracks, twoTracks: e.tracks.includes("探す") && e.tracks.some((t) => t !== "探す"),
          staffAix: e.nextAix?.type ?? null, staffText: maskReplay(e.staffText, e.conv, "staff").slice(0, 400),
          loggedBrainAix: e.brain?.aix ?? null,
          msgs: upto.map((m, i) => {
            const a = m.is_aix_generated ? aixs.find((x) => Math.abs(x.t - m.t) < 3 * 60e3) : undefined;
            return { s: m.sender === "customer" ? "customer" : "staff", text: maskReplay(m.text ?? (m.image_url ? "[画像]" : ""), e.conv, m.sender), min: mins[i], aix: a ? { type: a.type, property_names: a.props } : undefined };
          }).filter((m) => m.text.trim()),
        });
      }
    }
    writeFileSync(process.env.REPLAY_OUT, JSON.stringify(out, null, 2));
    console.log(`\nYUMA で比べる実物 ${out.length}件を ${process.env.REPLAY_OUT} に書き出した`);
  }
  if (process.env.OUT) {
    const out: string[] = [];
    for (const sc of scenesOrder) {
      out.push(`\n==================== ${sc}`);
      const es = evs.filter((e) => e.scene === sc);
      const pick = [...es.filter((e) => e.stuck), ...es.filter((e) => !e.stuck && e.brain && !e.match), ...es.filter((e) => !e.brain)].slice(0, PER);
      for (const e of pick) {
        out.push(`--- ${e.conv.slice(0, 8)} ${new Date(e.t1 + 9 * 3600e3).toISOString().slice(0, 16)} status=${e.status} focus=[${e.focus.map(normProp).join(",")}]`);
        out.push(`  客: ${mask(e.text).slice(0, 220)}`);
        out.push(`  スタッフ(${e.mins ?? "—"}分): 動き=${e.staffMove} AIX=${e.nextAix?.type ?? "なし"} new=[${e.newProps.map(normProp).join(",")}] 48h=${e.aix48.join(",")} 文=${mask(e.staffText).slice(0, 200)}`);
        if (e.brain) out.push(`  ブレイン: aix=${e.brain.aix} prop=${e.brain.prop ? normProp(e.brain.prop) : "-"} src=${e.brain.src} dir=${mask(e.brain.dir ?? "").slice(0, 80)} ${e.stuck ? "★とらわれ:" + e.stuck : e.match ? "一致" : "不一致"}`);
      }
    }
    writeFileSync(process.env.OUT, out.join("\n"));
    console.log(`\n実物を ${process.env.OUT} に書き出した`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
