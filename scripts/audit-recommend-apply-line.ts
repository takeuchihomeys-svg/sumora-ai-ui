// AIX【物件オススメ】で「申込の一文」を添える線を、状況で割って探す（読み取りのみ・DB は書かない）
//
// 2026-09-23 竹内「順に改善する 実際の成約データや直近のLINEを参考にずれをなくすように」
//   前段の監査（scripts/audit-brain-funnel.ts ④）: 物件オススメ 実送信4.8%／AI 17.1%・AI が書いた48件の73%を消す。
//   aix/action の buildMoveInDeadlineNote が「お申込みから審査・ご契約・入居まで通常2週間…添えること」と必須にしている。
//
// 【問い】どの状況なら過半数（＝必須にしてよい）、どの状況なら実送信ほぼ0（＝禁止にしてよい）か。
//   必須にしてよいのは過半数が守っている形だけ／禁止は実送信ほぼ0の形だけ／20%帯は率を渡して選ばせる。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-recommend-apply-line.ts [DAYS=365] [SHOW=6]
import { createClient } from "@supabase/supabase-js";
import { buildRecommendApplyLineNote, buildApplyLineStageRateNote, RECOMMEND_APPLY_LINE_STATS } from "../app/lib/apply-line-rates";
import { buildRecommendClosingNote } from "../app/lib/recommend-closing";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 365);
const SHOW = Number(process.env.SHOW ?? 6);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "  —  ");
/** 本名を出さない（〇〇さん／様 を伏せる） */
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,8}(?:さん|様|さま)/g, "〈お客様〉").replace(/\d{2,4}-\d{2,4}-\d{3,4}/g, "〈電話〉");

const WON_STATUSES = ["closed_won", "applying", "screening", "application", "contract", "approved"];
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|\[返信不要\])\s*$/;

/** 申込の語（前段の監査と同じ・広い） */
const APPLY_ANY = /お申込|申込/;
/** 申込の**誘導**（状況の報告「1番手でお申込みが入っている」は含めない） */
const APPLY_CTA = /お気に召され[^\n]{0,24}お?申込|お?申込(?:み)?(?:で|し|して)?[^\n]{0,12}(?:抑え|押さえ|確保)|お申込(?:み)?(?:是非|ぜひ|いかが|ご検討|も可能|でお部屋)|お申込(?:み)?から(?:審査|最短)|申込(?:後|から)最短|お申込(?:み)?手続き/;
/** buildMoveInDeadlineNote が「添えること」としている行 */
const TWO_WEEKS_LINE = /お申込(?:み)?から審査・ご契約/;
const TWO_WEEKS_ANY = /2週間|２週間|二週間/;

/** 状況の旗（本文・下書き・お客様の発言から読む） */
const SIT = {
  退去予定: /退去予定|解約予定|以降(?:に|で)?ご内覧可能|退去後/,
  申込あり2番手: /[1１]番手|[2２]番手|申込(?:み)?が入って|お申込あり|申込済/,
  即入居: /即入居|すぐ(?:に)?ご入居|空室のため/,
  見積書同封: /御見積書|見積書/,
  新着: /新着/,
  建築中: /建築中|竣工|新築未完成/,
};
/** お客様の入居希望日（〇月・上旬・末・即入居…）。buildMoveInDeadlineNote の extractMoveInWish と同じ狙い */
const WISH_RE = /(?:\d{1,2}\s*月\s*(?:\d{1,2}\s*日|上旬|中旬|下旬|末|頭|初旬)?|今月|来月|再来月)[^\n]{0,12}(?:入居|引越|引っ越|住み|移り)|(?:入居|引越|引っ越)[^\n]{0,12}(?:\d{1,2}\s*月|今月|来月)|即入居|すぐ(?:にでも)?(?:入居|引越)|早め(?:に|の)(?:入居|引越)/;

type Row = { id: string; conversation_id: string | null; aix_action: string | null; ai_draft: string | null; sent_reply: string | null; customer_message: string | null; created_at: string; sent_at: string | null; was_ai_modified: boolean | null; is_full_rewrite: boolean | null };

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

/** 申込を含む文（句点・！・改行で切る）を抜き出して、形ごとに数える */
function applySentences(t: string): string[] {
  return t.split(/(?<=[。！!\n])/).map((s) => s.trim()).filter((s) => s && APPLY_ANY.test(s));
}
function normalizeSentence(s: string): string {
  return mask(s).replace(/[😊😌🙇‍♀️！!。]+/g, "").replace(/\s+/g, "").replace(/〈お客様〉/g, "").slice(0, 60);
}

async function main() {
  console.log(`=== AIX【物件オススメ】で申込の一文を添える線（${DAYS}日・読み取りのみ）===\n`);

  const rows = (await all<Row>((a, b) => sb.from("ai_reply_examples")
    .select("id, conversation_id, aix_action, ai_draft, sent_reply, customer_message, created_at, sent_at, was_ai_modified, is_full_rewrite")
    .like("aix_action", "property_recommendation%").gte("created_at", since).order("created_at", { ascending: false }).range(a, b)))
    .filter((r) => (r.ai_draft ?? "").trim() && (r.sent_reply ?? "").trim() && !MARK.test(r.ai_draft ?? ""));
  console.log(`対象: ai_draft と sent_reply が両方ある ${rows.length}件`);

  // 成約側
  const convIds = [...new Set(rows.map((r) => r.conversation_id).filter((x): x is string => !!x))];
  const statusOf = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, status").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; status: string | null }>) statusOf.set(c.id, c.status ?? "");
  }
  // お客様の入居希望日: 送信より前のお客様の発言（直近40通）から読む
  const wishOf = new Map<string, boolean>();
  for (const r of rows) {
    if (!r.conversation_id) continue;
    const at = r.sent_at ?? r.created_at;
    const { data } = await sb.from("messages").select("text").eq("conversation_id", r.conversation_id).eq("sender", "customer")
      .lt("created_at", at).order("created_at", { ascending: false }).limit(40);
    const txt = ((data ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n") + "\n" + (r.customer_message ?? "");
    wishOf.set(r.id, WISH_RE.test(txt));
  }

  type Flags = Record<string, boolean>;
  const flagsOf = (r: Row): Flags => {
    const both = `${r.ai_draft}\n${r.sent_reply}`;
    const f: Flags = {};
    for (const [k, re] of Object.entries(SIT)) f[k] = re.test(both);
    f["入居希望日あり"] = wishOf.get(r.id) ?? false;
    f["成約側"] = WON_STATUSES.includes(statusOf.get(r.conversation_id ?? "") ?? "");
    f["AI下書きに2週間の行"] = TWO_WEEKS_LINE.test(r.ai_draft ?? "");
    return f;
  };
  const flagged = rows.map((r) => ({ r, f: flagsOf(r) }));

  // ── ① 全体: 広い語／誘導の形／2週間の行 ─────────────────────────
  const line = (label: string, list: typeof flagged, re: RegExp) => {
    const sent = list.filter((x) => re.test(x.r.sent_reply ?? "")).length;
    const ai = list.filter((x) => re.test(x.r.ai_draft ?? "")).length;
    const aiRemoved = list.filter((x) => re.test(x.r.ai_draft ?? "") && !re.test(x.r.sent_reply ?? "")).length;
    const aiKept = ai - aiRemoved;
    const noAi = list.filter((x) => !re.test(x.r.ai_draft ?? ""));
    const staffAdded = noAi.filter((x) => re.test(x.r.sent_reply ?? "")).length;
    console.log(`   ${label.padEnd(20)} n=${String(list.length).padStart(4)}  実送信 ${pct(sent, list.length).padStart(6)} ／ AI ${pct(ai, list.length).padStart(6)}  ｜ AIが書いた${String(ai).padStart(3)}件→残${String(aiKept).padStart(3)}・消${String(aiRemoved).padStart(3)}（消 ${pct(aiRemoved, ai)}）｜ AIが書かず${String(noAi.length).padStart(4)}件→スタッフが足した${String(staffAdded).padStart(3)}（${pct(staffAdded, noAi.length)}）`);
  };
  console.log(`\n=== ① 全体 ===`);
  line("申込の語（広い）", flagged, APPLY_ANY);
  line("申込の誘導（CTA）", flagged, APPLY_CTA);
  line("「審査・ご契約」2週間行", flagged, TWO_WEEKS_LINE);
  line("2週間（どの言い方でも）", flagged, TWO_WEEKS_ANY);

  // ── ② 状況で割る ─────────────────────────────────────────────
  const keys = ["退去予定", "申込あり2番手", "即入居", "入居希望日あり", "見積書同封", "新着", "建築中", "成約側", "AI下書きに2週間の行"];
  for (const [title, re] of [["申込の語（広い）", APPLY_ANY], ["申込の誘導（CTA）", APPLY_CTA]] as const) {
    console.log(`\n=== ② 状況で割る — ${title} ===`);
    for (const k of keys) {
      line(`${k}=あり`, flagged.filter((x) => x.f[k]), re);
      line(`${k}=なし`, flagged.filter((x) => !x.f[k]), re);
    }
    // 組み合わせ（線になりそうな所）
    console.log(`   --- 組み合わせ ---`);
    line("退去予定 かつ 成約側", flagged.filter((x) => x.f["退去予定"] && x.f["成約側"]), re);
    line("退去予定 かつ 入居希望日", flagged.filter((x) => x.f["退去予定"] && x.f["入居希望日あり"]), re);
    line("退去予定 or 申込あり", flagged.filter((x) => x.f["退去予定"] || x.f["申込あり2番手"]), re);
    line("空室（退去予定なし・申込なし）", flagged.filter((x) => !x.f["退去予定"] && !x.f["申込あり2番手"] && !x.f["建築中"]), re);
    line("空室 かつ 入居希望日あり", flagged.filter((x) => !x.f["退去予定"] && !x.f["申込あり2番手"] && x.f["入居希望日あり"]), re);
    line("空室 かつ 入居希望日なし", flagged.filter((x) => !x.f["退去予定"] && !x.f["申込あり2番手"] && !x.f["入居希望日あり"]), re);
    line("空室 かつ 成約側", flagged.filter((x) => !x.f["退去予定"] && !x.f["申込あり2番手"] && x.f["成約側"]), re);
  }

  // ── ③ 月別（2026-09-18 の fixRecommendClosing 以後に変わっていないか） ──
  console.log(`\n=== ③ 月別（申込の語・広い） ===`);
  const byMonth = new Map<string, typeof flagged>();
  for (const x of flagged) { const m = x.r.created_at.slice(0, 7); const a = byMonth.get(m) ?? []; a.push(x); byMonth.set(m, a); }
  for (const [m, list] of [...byMonth].sort()) line(m, list, APPLY_ANY);

  // ── ④ 実送信で使われている申込の文の形（上位） ─────────────────
  console.log(`\n=== ④ 実送信（物件オススメ）にある申込の文の形（上位）===`);
  const cnt = new Map<string, number>();
  for (const x of flagged) for (const s of applySentences(x.r.sent_reply ?? "")) { const k = normalizeSentence(s); cnt.set(k, (cnt.get(k) ?? 0) + 1); }
  for (const [k, n] of [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${String(n).padStart(3)}  ${k}`);
  console.log(`\n=== ④' AI の下書き（物件オススメ）にある申込の文の形（上位）===`);
  const cntAi = new Map<string, number>();
  for (const x of flagged) for (const s of applySentences(x.r.ai_draft ?? "")) { const k = normalizeSentence(s); cntAi.set(k, (cntAi.get(k) ?? 0) + 1); }
  for (const [k, n] of [...cntAi].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${String(n).padStart(3)}  ${k}`);

  // ── ⑤ 実物（目で読む）: AI が書いて消された／AI が書かずスタッフが足した ──
  console.log(`\n=== ⑤ 実物: AI が申込を書いてスタッフが消した（${SHOW}件）===`);
  for (const x of flagged.filter((y) => APPLY_ANY.test(y.r.ai_draft ?? "") && !APPLY_ANY.test(y.r.sent_reply ?? "")).slice(0, SHOW)) {
    const on = Object.entries(x.f).filter(([, v]) => v).map(([k]) => k).join("・") || "旗なし";
    console.log(`\n--- ${x.r.created_at.slice(0, 10)} [${on}]`);
    console.log(`  AI : ${mask(applySentences(x.r.ai_draft ?? "").join(" / "))}`);
    console.log(`  送信: ${mask((x.r.sent_reply ?? "").split("\n").filter((l) => l.trim()).slice(-2).join(" / ")).slice(0, 160)}`);
  }
  console.log(`\n=== ⑤' 実物: AI は書かず、スタッフが申込の一文を足した（${SHOW}件）===`);
  for (const x of flagged.filter((y) => !APPLY_ANY.test(y.r.ai_draft ?? "") && APPLY_ANY.test(y.r.sent_reply ?? "")).slice(0, SHOW)) {
    const on = Object.entries(x.f).filter(([, v]) => v).map(([k]) => k).join("・") || "旗なし";
    console.log(`\n--- ${x.r.created_at.slice(0, 10)} [${on}]`);
    console.log(`  送信の申込文: ${mask(applySentences(x.r.sent_reply ?? "").join(" / "))}`);
    console.log(`  AIの締め   : ${mask((x.r.ai_draft ?? "").split("\n").filter((l) => l.trim()).slice(-2).join(" / ")).slice(0, 160)}`);
  }
  console.log(`\n=== ⑤'' 実物: AI が申込を書いてスタッフも残した（${SHOW}件）===`);
  for (const x of flagged.filter((y) => APPLY_ANY.test(y.r.ai_draft ?? "") && APPLY_ANY.test(y.r.sent_reply ?? "")).slice(0, SHOW)) {
    const on = Object.entries(x.f).filter(([, v]) => v).map(([k]) => k).join("・") || "旗なし";
    console.log(`\n--- ${x.r.created_at.slice(0, 10)} [${on}]`);
    console.log(`  AI : ${mask(applySentences(x.r.ai_draft ?? "").join(" / "))}`);
    console.log(`  送信: ${mask(applySentences(x.r.sent_reply ?? "").join(" / "))}`);
  }

  // ── ⑥ 「お申込みから審査・ご契約・入居まで通常2週間」の行は実送信全体で何通か ──
  console.log(`\n=== ⑥ 「お申込みから審査・ご契約」の行 — 実送信全体（messages・スタッフ送信・${DAYS}日）===`);
  const staffLine = await all<{ conversation_id: string; text: string; created_at: string; is_aix_generated: boolean | null }>((a, b) => sb.from("messages")
    .select("conversation_id, text, created_at, is_aix_generated").eq("sender", "staff").gte("created_at", since).ilike("text", "%審査・ご契約%").range(a, b));
  const staffTwoWeeks = await all<{ conversation_id: string; text: string; created_at: string; is_aix_generated: boolean | null }>((a, b) => sb.from("messages")
    .select("conversation_id, text, created_at, is_aix_generated").eq("sender", "staff").gte("created_at", since).or("text.ilike.%2週間%,text.ilike.%２週間%").range(a, b));
  console.log(`   「審査・ご契約」を含むスタッフ送信: ${staffLine.length}通（うち AIX 印 ${staffLine.filter((m) => m.is_aix_generated).length}通）`);
  console.log(`   「2週間」を含むスタッフ送信       : ${staffTwoWeeks.length}通`);
  const twCnt = new Map<string, number>();
  for (const m of staffTwoWeeks) for (const s of m.text.split(/(?<=[。！!\n])/)) if (TWO_WEEKS_ANY.test(s)) { const k = normalizeSentence(s); twCnt.set(k, (twCnt.get(k) ?? 0) + 1); }
  console.log(`   2週間を含む文の形（上位）:`);
  for (const [k, n] of [...twCnt].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`     ${String(n).padStart(3)}  ${k}`);
  // ai_reply_examples 側（全 AIX・通常返信）でも
  const exAll = (await all<{ aix_action: string | null; ai_draft: string | null; sent_reply: string | null }>((a, b) => sb.from("ai_reply_examples")
    .select("aix_action, ai_draft, sent_reply").gte("created_at", since).or("ai_draft.ilike.%審査・ご契約%,sent_reply.ilike.%審査・ご契約%").range(a, b)));
  const byKind = new Map<string, { ai: number; sent: number; removed: number }>();
  for (const e of exAll) {
    const k = e.aix_action ? e.aix_action.split("_").slice(0, 2).join("_") : "通常返信";
    const v = byKind.get(k) ?? { ai: 0, sent: 0, removed: 0 };
    const a = TWO_WEEKS_LINE.test(e.ai_draft ?? ""), s = TWO_WEEKS_LINE.test(e.sent_reply ?? "");
    if (a) v.ai++; if (s) v.sent++; if (a && !s) v.removed++;
    byKind.set(k, v);
  }
  console.log(`   ai_reply_examples（種類別）: AI が書いた／実送信に残った／消された`);
  for (const [k, v] of [...byKind].sort((a, b) => b[1].ai - a[1].ai)) console.log(`     ${k.padEnd(26)} AI ${String(v.ai).padStart(3)} ／ 実送信 ${String(v.sent).padStart(3)} ／ 消 ${String(v.removed).padStart(3)}`);

  // ── ⑦ 出所を追う ─────────────────────────────────────────────
  console.log(`\n=== ⑦ 出所を追う ===`);
  const actions = new Map<string, number>();
  for (const r of rows) actions.set(r.aix_action ?? "", (actions.get(r.aix_action ?? "") ?? 0) + 1);
  console.log(`   aix_action の内訳: ${[...actions].map(([k, n]) => `${k}=${n}`).join(" ／ ")}`);

  // 締めの形（退去予定の通・空室の通で、実送信は何で締めているか）
  const VIEW_CTA = /お気に召され[^\n]{0,24}ご案内|ご都合よろしいお日にち|ご内覧(?:させて|いただ|頂)/;
  const SHUUSHU = /ご査収/;
  const closingKind = (t: string) => APPLY_CTA.test(t) ? "申込誘導" : VIEW_CTA.test(t) ? "内覧誘導" : SHUUSHU.test(t) ? "ご査収のみ" : "誘導なし";
  for (const [label, list] of [["退去予定=あり", flagged.filter((x) => x.f["退去予定"])], ["空室（退去予定なし）", flagged.filter((x) => !x.f["退去予定"] && !x.f["建築中"])]] as const) {
    const cs = new Map<string, number>(), ca = new Map<string, number>();
    for (const x of list) { const s = closingKind(x.r.sent_reply ?? ""), a = closingKind(x.r.ai_draft ?? ""); cs.set(s, (cs.get(s) ?? 0) + 1); ca.set(a, (ca.get(a) ?? 0) + 1); }
    console.log(`   ${label}（n=${list.length}）締めの形:`);
    for (const k of ["申込誘導", "内覧誘導", "ご査収のみ", "誘導なし"]) console.log(`      ${k.padEnd(8)} 実送信 ${pct(cs.get(k) ?? 0, list.length).padStart(6)} ／ AI ${pct(ca.get(k) ?? 0, list.length).padStart(6)}`);
  }

  // 入居時期への言及（MOVE_IN_TIMING_RULE「ご希望の〇月入居に対応可能」の形）
  const MOVEIN_OK = /ご入居にも?(?:しっかり)?対応(?:可能|頂け|いただけ)|入居に(?:も)?対応可能|入居(?:にも)?しっかり対応/;
  const MOVEIN_ANY = /入居可能時期|ご入居可能|入居可能日|即入居|ご入居(?:頂け|いただけ)|入居(?:時期|日)/;
  line("「〇月入居に対応可能」型", flagged, MOVEIN_OK);
  line("入居時期への言及（何でも）", flagged, MOVEIN_ANY);
  line("〃 入居希望日あり", flagged.filter((x) => x.f["入居希望日あり"]), MOVEIN_OK);

  // 出口 fixRecommendClosing の固定文（APPLY_CLOSING_LINE）そのものが下書きにある数
  const EXIT_LINE = /お気に召されましたらお申込しお部屋抑えさせて頂きます/;
  console.log(`   出口の固定文「お気に召されましたらお申込しお部屋抑えさせて頂きます」: AI ${flagged.filter((x) => EXIT_LINE.test(x.r.ai_draft ?? "")).length}件 ／ 実送信 ${flagged.filter((x) => EXIT_LINE.test(x.r.sent_reply ?? "")).length}件`);

  // aix_generate_log と突き合わせ（AIX ボタン本体の生成か・条件に入居希望が入っていたか）
  const aiApply = flagged.filter((x) => APPLY_CTA.test(x.r.ai_draft ?? ""));
  let matched = 0, matchedRemoved = 0, unmatchedRemoved = 0, condWish = 0, condNone = 0, sc = new Map<string, number>();
  const byPath = new Map<string, Map<string, number>>(); // 経路 → 申込文の形 → 件数
  for (const x of aiApply) {
    if (!x.r.conversation_id) continue;
    const removed = !APPLY_CTA.test(x.r.sent_reply ?? "");
    const head = (x.r.ai_draft ?? "").replace(/\s+/g, " ").slice(0, 30);
    const { data } = await sb.from("aix_generate_log").select("generated_text, conditions_snapshot, generated_at, status").eq("conversation_id", x.r.conversation_id)
      .eq("action_type", "property_recommendation").order("generated_at", { ascending: false }).limit(30);
    const hit = ((data ?? []) as Array<{ generated_text: string | null; conditions_snapshot: Record<string, unknown> | null; status: string | null }>).find((g) => (g.generated_text ?? "").replace(/\s+/g, " ").slice(0, 30) === head);
    // テンプレート経路（aix-template-generate）は 2026-09-18 から status='generated'・conditions_snapshot に scenario/state を残す
    const path = !hit ? "不明（ログなし）" : hit.status === "generated" && hit.conditions_snapshot && "state" in hit.conditions_snapshot ? "テンプレート経路" : "AIXボタン本体";
    const m = byPath.get(path) ?? new Map<string, number>();
    for (const s of applySentences(x.r.ai_draft ?? "").filter((s) => APPLY_CTA.test(s))) { const k = TWO_WEEKS_LINE.test(s) ? "2週間の行" : /抑え|押さえ|確保/.test(s) ? "お申込みしお部屋抑え" : "その他"; m.set(k, (m.get(k) ?? 0) + 1); }
    byPath.set(path, m);
    if (!hit) { if (removed) unmatchedRemoved++; continue; }
    matched++; if (removed) matchedRemoved++;
    const cond = String(hit.conditions_snapshot?.customer_conditions ?? "");
    if (WISH_RE.test(cond) || /入居/.test(cond)) condWish++; else condNone++;
    const s = String(hit.conditions_snapshot?.scenario ?? "なし"); sc.set(s, (sc.get(s) ?? 0) + 1);
  }
  console.log(`   AI が申込誘導を書いた ${aiApply.length}件のうち aix_generate_log に同じ生成がある ${matched}件（消された ${matchedRemoved}）／ ログなし ${aiApply.length - matched}件（消された ${unmatchedRemoved}）`);
  console.log(`      ログありのうち conditions_snapshot の希望条件に入居の記載あり ${condWish}件 ／ なし ${condNone}件 ／ scenario: ${[...sc].map(([k, n]) => `${k}=${n}`).join(" ／ ") || "—"}`);
  for (const [p, m] of byPath) console.log(`      経路=${p}: ${[...m].map(([k, n]) => `${k}=${n}`).join(" ／ ")}`);

  // ── ⑧ 直す前後の指示文（目で読む） ─────────────────────────────
  printBeforeAfter();
}

/** 2026-09-23 に直した入口の指示文を、直す前と並べて出す（DB を読まない・目で読む用） */
function printBeforeAfter() {
  console.log(`\n=== ⑧ 直す前後の指示文（入口）— 定数の計測日 ${RECOMMEND_APPLY_LINE_STATS.measuredAt}・n=${RECOMMEND_APPLY_LINE_STATS.n} ===`);
  console.log(`\n--- 直す前（aix/action buildMoveInDeadlineNote・入居希望日に余裕がある時の末尾2行・必須の形）---`);
  console.log(`  ・審査・契約・入金の最短期間は2週間。差し引き23日の余裕があるため入居時期に言及してよい。`);
  console.log(`  ・言及するときは「お申込みから審査・ご契約・入居まで通常2週間程度で対応できますので、11月入居希望のご入居にもしっかり対応可能です！！」のように審査期間を根拠として自然に添えること。`);
  console.log(`  ・言及する場合の日付は「11月入居希望」の表現に沿わせ、勝手に別の日付へ書き換えないこと。`);
  console.log(`\n--- 直した後（同じ場面: 空室・入居希望日「11月入居希望」・余裕23日）---`);
  console.log(`  ・審査・契約・入金の最短期間は2週間。差し引き23日の余裕があるため、入居時期に触れても事実と食い違わない。`);
  console.log(`  ・触れる場合の日付は「11月入居希望」の表現に沿わせ、勝手に別の日付へ書き換えないこと。触れるかどうか・申込の一文を添えるかは下の【申込の一文と入居時期 — 実送信の率】に従う。`);
  const base = { notViewable: false, viewableFrom: null, hasEstimate: false, immediateMoveIn: false, moveInWish: null as string | null, marginDays: null as number | null };
  const cases: Array<[string, Parameters<typeof buildRecommendApplyLineNote>[0]]> = [
    ["空室・入居希望日「11月入居希望」・余裕23日", { ...base, moveInWish: "11月入居希望", marginDays: 23 }],
    ["見積書同封の通", { ...base, hasEstimate: true }],
    ["退去予定（10月1日以降にご内覧可能）", { ...base, notViewable: true, viewableFrom: "10月1日" }],
    ["即入居希望", { ...base, immediateMoveIn: true }],
  ];
  for (const [label, o] of cases) {
    console.log(`\n--- 直した後・動的ノート【${label}】---`);
    for (const l of buildRecommendApplyLineNote(o).split("\n")) console.log(`  ${l}`);
  }
  console.log(`\n--- テンプレート経路（aix-template-generate）buildRecommendClosingNote ---`);
  console.log(`  直す前（退去予定）: ・…→ 締めは内覧の誘導ではなく**申込の誘導**「お気に召されましたらお申込しお部屋抑えさせて頂きます😊！！」（実データ: 退去予定の締めは申込34件 vs 内覧9件）`);
  console.log(`  直す前（空室）    : ・このお部屋は今ご内覧頂ける → 締めは内覧の誘導（…）でよい`);
  for (const [label, o] of [["退去予定・1件", { sentPropertyCount: 1, notViewable: true, viewableFrom: "10月1日" }], ["空室・3件", { sentPropertyCount: 3, notViewable: false }]] as const) {
    console.log(`  直した後【${label}】:`);
    for (const l of buildRecommendClosingNote(o).split("\n")) console.log(`    ${l}`);
  }
  console.log(`\n--- 見積書・物件確認した に渡せる率だけのノート（今回は呼んでいない・必須にしない）---`);
  console.log(`  ${buildApplyLineStageRateNote("estimate_sheet")}`);
  console.log(`  ${buildApplyLineStageRateNote("property_check_result")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
