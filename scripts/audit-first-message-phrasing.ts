// scripts/audit-first-message-phrasing.ts — AIX【物件オススメ】の1通目（🌟物件名 …）の「言い回し」を実送信で数える（読むだけ）
//
// 2026-10-01 竹内（YUMA に届いた1通目「…家具付き・角部屋・宅配BOX完備と使いやすい設備が揃っております！！…暮らしやすい作りとなっております！！」
//   「…かなり条件の良いお部屋で…」「…収納面もしっかり確保されております！！」「…室内も綺麗な22.56㎡のお部屋です。」を見て）:
//   2通目と同じやり方で1通目も直す。「実際使っている言い回しが出るように」「文の区切る部分とつなげる部分」「場面で訴求が変わる」
//
// ⚠ 1通目の「実送信」はほとんどが AI の下書きをそのまま送った物（aix_usage_logs.was_edited は末尾の空白でも true になる）。
//   実送信を数えるだけでは AI の言い回しを「実送信にある」と数えてしまうので、送った文を3つに分ける:
//     human   … スタッフが自分で書いた（AI の下書きが近くに無い・is_aix_generated=false）
//     edited  … AI の下書きをスタッフが直して送った（下書きと送った文を文単位で比べ、消した文・足した文を数える）
//     as_is   … AI の下書きをほぼそのまま送った（似ている度 0.97 以上）
//   線（出口に使ってよいか）は human と edited の「足した文」で引く。as_is は「AI が書いたのをスタッフが止めなかった」数としてだけ見る。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-first-message-phrasing.ts [--days=365] [--show=10] [--raw=human|edited|as_is] [--scene=all|new|compare|single|vacating]
import { createClient } from "@supabase/supabase-js";
import { styleStatsOf, splitSentences } from "../app/lib/second-message-style";
import { FIRST_PHRASE_RULES, findFirstAiPhrases, firstSceneOf, isFirstRecommendation, unifyBangEnding, isCleanFirstExample, type FirstScene } from "../app/lib/first-message-style";
import { isTestConversation } from "../app/lib/test-conversations";
import { hasClosingSentence, removeRecommendClosing } from "../app/lib/recommend-cta";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365")) || 365;
const SHOW = Number(arg("show", "10"));
const RAW = arg("raw", "");
const SCENE = arg("scene", "all");
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const mask = (s: string) => s.replace(/[^\s、。！!\n]{1,10}(?:さん|様)/g, (m) => (/(お客|皆|奥|旦那|お子|息子|娘|大家|オーナー|担当)/.test(m) ? m : "〈名〉さん"));
const one = (s: string) => mask(s).replace(/\n\n/g, " ⏎⏎ ").replace(/\n/g, " ⏎ ");

type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type D = { conversation_id: string; text: string; at: number };

async function all<T>(build: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, "").replace(/[😊😌]/g, "");
function dice(a: string, b: string): number {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(A), gb = grams(B);
  let inter = 0; for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (Math.max(1, A.length - 1) + Math.max(1, B.length - 1));
}


export type Row = { conv: string; at: string; text: string; origin: "human" | "edited" | "as_is"; draft: string | null; scene: FirstScene; vacating: boolean; follow: string | null };

async function main() {
  const rows = await all<M>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("conversation_id").order("created_at").range(a, b));
  const logs = await all<{ conversation_id: string | null; aix_type: string | null; sent_at: string | null; created_at: string; generated_text: string | null; picker_choices: Record<string, unknown> | null }>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, created_at, generated_text, picker_choices").gte("created_at", since).order("created_at").range(a, b));
  const gen = await all<{ conversation_id: string | null; generated_text: string | null; created_at: string }>((a, b) => sb.from("aix_generate_log").select("conversation_id, generated_text, created_at").eq("action_type", "property_recommendation").gte("created_at", since).order("created_at").range(a, b));
  const ex = await all<{ conversation_id: string | null; ai_draft: string | null; created_at: string; sent_at: string | null }>((a, b) => sb.from("ai_reply_examples").select("conversation_id, ai_draft, created_at, sent_at").eq("aix_action", "property_recommendation").not("ai_draft", "is", null).gte("created_at", since).order("created_at").range(a, b));

  const applyAt = new Map<string, number>();
  const drafts = new Map<string, D[]>();
  const newPickerAt = new Map<string, number[]>();
  const addDraft = (c: string | null, t: string | null, at: string) => { if (!c || !t) return; if (!drafts.has(c)) drafts.set(c, []); drafts.get(c)!.push({ conversation_id: c, text: t, at: Date.parse(at) }); };
  for (const l of logs) {
    const c = l.conversation_id ?? ""; if (!c) continue;
    const t = Date.parse(l.sent_at ?? l.created_at);
    if ((l.aix_type ?? "").startsWith("application_push") && !(applyAt.get(c)! <= t)) applyAt.set(c, t);
    if ((l.aix_type ?? "") === "property_recommendation") {
      addDraft(c, l.generated_text, l.sent_at ?? l.created_at);
      const pc = (l.picker_choices ?? {}) as { is_new_arrival?: boolean; pickup_type?: string | null };
      if (pc.is_new_arrival || /新着/.test(String(pc.pickup_type ?? ""))) { if (!newPickerAt.has(c)) newPickerAt.set(c, []); newPickerAt.get(c)!.push(t); }
    }
  }
  for (const g of gen) addDraft(g.conversation_id, g.generated_text, g.created_at);
  for (const e of ex) addDraft(e.conversation_id, e.ai_draft, e.sent_at ?? e.created_at);

  const out: Row[] = [];
  let unknown = 0;
  const byConv = new Map<string, M[]>();
  for (const r of rows) { if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []); byConv.get(r.conversation_id)!.push(r); }
  for (const [conv, ms] of byConv) {
    if (isTestConversation(conv)) continue;
    for (let i = 0; i < ms.length; i++) {
      const a = ms[i];
      if (a.sender !== "staff" || !a.text || !isFirstRecommendation(a.text)) continue;
      const at = Date.parse(a.created_at);
      if (applyAt.has(conv) && at >= applyAt.get(conv)!) continue;
      const near = (drafts.get(conv) ?? []).filter((d) => Math.abs(d.at - at) <= 40 * 60_000);
      let best: D | null = null, bs = 0;
      for (const d of near) { const s = dice(d.text, a.text); if (s > bs) { bs = s; best = d; } }
      // is_aix_generated は 2026-07-02 から付いている。AIX の物件オススメは 2026-06-06 から使われている（ai_reply_examples）ので、
      //   その間（6/06〜7/01）の is_aix_generated=false は AI の下書きかもしれない → 下書きが見つからなくても human に入れない（数えない）
      const flagKnown = at >= Date.parse("2026-07-02T00:00:00+09:00") || at < Date.parse("2026-06-06T00:00:00+09:00");
      const origin: Row["origin"] | null = best && bs >= 0.97 ? "as_is" : best && bs >= 0.45 ? "edited" : a.is_aix_generated ? "as_is" : flagKnown ? "human" : null;
      if (!origin) { unknown++; continue; }
      // 直前 72時間のこちらの送付（別の 🌟 物件・ピックアップ）
      const prior = ms.slice(0, i).filter((m) => m.sender === "staff" && at - Date.parse(m.created_at) <= 72 * 3600_000 && at - Date.parse(m.created_at) > 0).map((m) => m.text ?? "");
      const newPicker = (newPickerAt.get(conv) ?? []).some((t) => Math.abs(t - at) <= 5 * 60_000);
      // 続けて送った2通目（画像は飛ばす・お客様の発言が挟まれば無し・15分以内）
      let follow: string | null = null;
      for (let j = i + 1; j < ms.length; j++) {
        const n = ms[j];
        if (n.sender !== "staff" || Date.parse(n.created_at) - at > 15 * 60_000) break;
        if (!n.text || /^\[(画像|動画|スタンプ|ファイル)/.test(n.text)) continue;
        if (isFirstRecommendation(n.text)) break; // 次の物件の1通目
        follow = n.text; break;
      }
      out.push({ conv, at: a.created_at, text: a.text, origin, draft: origin === "edited" ? best!.text : null, follow,
        scene: firstSceneOf({ text: a.text, priorStaffTexts: prior, newPicker }), vacating: /退去|居住中|入居中/.test(a.text) });
    }
  }
  const set = out.filter((r) => SCENE === "all" || (SCENE === "vacating" ? r.vacating : r.scene === SCENE));
  const H = set.filter((r) => r.origin === "human"), E = set.filter((r) => r.origin === "edited"), A = set.filter((r) => r.origin === "as_is");
  console.log(`直近${DAYS}日（YUMA・申込以降を除く）: 物件オススメの1通目（🌟）${set.length}通 ＝ スタッフが書いた ${H.length} ／ AI の下書きを直した ${E.length} ／ ほぼそのまま ${A.length}（6/06〜7/01 の印なしで出所が分からない ${unknown}通は数えない）\n`);

  const style = (label: string, xs: Row[]) => {
    if (!xs.length) { console.log(`━━ ${label}: 0通`); return; }
    const st = xs.map((r) => styleStatsOf(r.text));
    const sents = st.reduce((n, s) => n + s.sentences, 0);
    console.log(`━━ ${label}: ${xs.length}通（新着 ${xs.filter((r) => r.scene === "new").length}・送った中から ${xs.filter((r) => r.scene === "compare").length}・1件だけ ${xs.filter((r) => r.scene === "single").length}・退去予定 ${xs.filter((r) => r.vacating).length}）`);
    console.log(`   長さ 中央値 ${med(st.map((s) => s.len))}字・段落 ${med(st.map((s) => s.paragraphs))}・文 ${med(st.map((s) => s.sentences))}・1文 中央値 ${med(st.flatMap((s) => s.sentenceLens))}字`);
    console.log(`   「！！」で終わる文 ${pct(st.reduce((n, s) => n + s.bangEnd, 0), sents)}・「。」で終わる文 ${pct(st.reduce((n, s) => n + s.maruEnd, 0), sents)}・「。」と「！！」が同じ通に混ざる ${pct(st.filter((s) => s.maruEnd > 0 && s.bangEnd > 0).length, xs.length)}`);
    const em = new Map<string, number>(); for (const s of st) for (const e of s.emojis.filter((x) => x !== "🌟")) em.set(e, (em.get(e) ?? 0) + 1);
    const emN = st.map((s) => s.emojis.filter((x) => x !== "🌟").length);
    console.log(`   絵文字（🌟を除く）: 無し ${pct(emN.filter((n) => n === 0).length, xs.length)}・1個 ${pct(emN.filter((n) => n === 1).length, xs.length)}・2個以上 ${pct(emN.filter((n) => n >= 2).length, xs.length)} ／ 種類 ${[...em].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([e, n]) => `${e}${n}`).join(" ")}`);
    console.log(`   （オススメポイント）の箇条書き ${pct(xs.filter((r) => /（オススメポイント）|\(オススメポイント\)/.test(r.text)).length, xs.length)}・「・」始まりの行2行以上 ${pct(st.filter((s) => s.bullets >= 2).length, xs.length)}・（設備）欄 ${pct(xs.filter((r) => /（設備）/.test(r.text)).length, xs.length)}`);
    console.log(`   冒頭「〜、{名}さんにかなりオススメ出来るお部屋となります！！」 ${pct(xs.filter((r) => /さんに(?:かなり|特に)?オススメ(?:出来|でき)る(?:お部屋|物件)/.test(r.text.split("\n").slice(0, 5).join("\n"))).length, xs.length)}・締め: ご案内 ${pct(xs.filter((r) => /ご都合(?:よろしい|の良い)お日にち|ご案内させて頂/.test(r.text)).length, xs.length)}・申込 ${pct(xs.filter((r) => /お申込み?しお部屋|お部屋抑え/.test(r.text)).length, xs.length)}・ご査収 ${pct(xs.filter((r) => /ご査収/.test(r.text)).length, xs.length)}・締め無し ${pct(xs.filter((r) => !/ご都合|ご案内|お部屋抑え|ご査収|ご確認ください/.test(r.text)).length, xs.length)}`);
    // 本文（🌟の行・冒頭のオススメの文・箇条書き・締めを除いた「描写」）の1文に設備をいくつ並べるか
    const body = xs.map((r) => splitSentences(r.text).filter((s) => !/^🌟|オススメ(?:出来|でき)るお部屋|ご都合|お部屋抑え|ご査収|^[・･]|（/.test(s)));
    const eqPer = body.flat().map((s) => (s.match(/[・、や]/g) ?? []).length);
    console.log(`   描写の文 ${body.flat().length}文: 1文の区切り（・、や）中央値 ${med(eqPer)}・4つ以上 ${pct(eqPer.filter((n) => n >= 4).length, eqPer.length)}`);
  };
  style("スタッフが書いた（human）", H);
  style("AI の下書きを直して送った（edited・送った文）", E);
  style("AI の下書き（edited の直す前）", E.map((r) => ({ ...r, text: r.draft ?? "" })));
  style("AI の下書きをほぼそのまま（as_is）", A);

  console.log(`\n━━ 言い回し（検査の候補）: human ${H.length} ／ edited の下書きにあってスタッフが消した・残した ／ edited でスタッフが足した ／ as_is ${A.length}`);
  for (const r of FIRST_PHRASE_RULES) {
    const h = H.filter((x) => r.re.test(x.text));
    const inDraft = E.filter((x) => r.re.test(x.draft ?? ""));
    const removed = inDraft.filter((x) => !r.re.test(x.text));
    const added = E.filter((x) => !r.re.test(x.draft ?? "") && r.re.test(x.text));
    const a = A.filter((x) => r.re.test(x.text));
    console.log(`   ${r.exit ? "【出口】" : "（数える）"} ${r.key.padEnd(18)} human ${String(h.length).padStart(3)}  下書き ${String(inDraft.length).padStart(3)}→消 ${String(removed.length).padStart(3)}・残 ${String(inDraft.length - removed.length).padStart(3)}  足した ${String(added.length).padStart(3)}  as_is ${String(a.length).padStart(3)}`);
    for (const x of h.slice(0, 3)) console.log(`        human: …${one(x.text.match(new RegExp(`[^\\n]{0,40}${r.re.source}[^\\n]{0,30}`))?.[0] ?? "").slice(0, 150)}`);
    for (const x of added.slice(0, 2)) console.log(`        足した: …${one(x.text.match(new RegExp(`[^\\n]{0,40}${r.re.source}[^\\n]{0,30}`))?.[0] ?? "").slice(0, 150)}`);
  }
  const hitH = H.filter((x) => findFirstAiPhrases(x.text).length > 0);
  const hitAdded = E.filter((x) => findFirstAiPhrases(x.text).some((h) => !findFirstAiPhrases(x.draft ?? "").some((d) => d.key === h.key)));
  console.log(`\n   出口の検査に当たる: スタッフが書いた ${hitH.length}/${H.length} ／ スタッフが直した時に自分で足した ${hitAdded.length}/${E.length} ／ as_is ${A.filter((x) => findFirstAiPhrases(x.text).length > 0).length}/${A.length}`);
  for (const x of hitH) console.log(`     human ${findFirstAiPhrases(x.text).map((h) => h.key).join(",")} … ${one(x.text).slice(0, 220)}`);
  for (const x of hitAdded) console.log(`     足した ${findFirstAiPhrases(x.text).map((h) => h.key).join(",")} … ${one(x.text).slice(0, 220)}`);

  if (args.includes("--follow")) {
    // 2026-10-01 竹内「物件オススメ締めの部分 状況的に2通目だけでも大丈夫 内覧の締めの部分は。構成として」:
    //   1通目の後に2通目が続いた割合（場面別）と、2通目が続いた時・続かなかった時の1通目の締め・最後の行
    const kind = (t: string) => { const k = [hasClosingSentence(t, "apply") ? "申込" : "", hasClosingSentence(t, "viewing") ? "内覧" : "", hasClosingSentence(t, "receipt") ? "ご査収" : ""].filter(Boolean); return k.length ? k.join("+") : "なし"; };
    const lastLine = (t: string) => { const ls = t.split("\n").map((x) => x.trim()).filter(Boolean); return ls[ls.length - 1] ?? ""; };
    const since9 = Date.parse("2026-09-01T00:00:00+09:00");
    for (const [label, xs] of [["全部", set], ["スタッフが書いた", H], ["AI（直した＋そのまま）", [...E, ...A]], ["9月以降（全部）", set.filter((r) => Date.parse(r.at) >= since9)]] as Array<[string, Row[]]>) {
      const fol = xs.filter((r) => r.follow);
      console.log(`
━━ 2通目が続いた: ${label} ${fol.length}/${xs.length}（${pct(fol.length, xs.length)}）`);
      for (const [sl, f] of [["新着", (r: Row) => r.scene === "new"], ["送った中から", (r: Row) => r.scene === "compare"], ["1件だけ", (r: Row) => r.scene === "single"], ["退去予定", (r: Row) => r.vacating]] as Array<[string, (r: Row) => boolean]>) {
        const ys = xs.filter(f); console.log(`   ${sl}: ${ys.filter((r) => r.follow).length}/${ys.length}（${pct(ys.filter((r) => r.follow).length, ys.length)}）`);
      }
      for (const [fl, ys] of [["続いた", fol], ["続かなかった", xs.filter((r) => !r.follow)]] as Array<[string, Row[]]>) {
        const tab = new Map<string, number>(); for (const r of ys) tab.set(kind(r.text), (tab.get(kind(r.text)) ?? 0) + 1);
        console.log(`   1通目の締め（${fl} ${ys.length}）: ${[...tab].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}（${pct(n, ys.length)}）`).join("・")}`);
      }
      const tab2 = new Map<string, number>(); for (const r of fol) { const k = `${kind(r.text)} → ${kind(r.follow!)}`; tab2.set(k, (tab2.get(k) ?? 0) + 1); }
      console.log(`   1通目の締め → 2通目の締め: ${[...tab2].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join("・")}`);
    }
    // 2通目が続いた組の1通目の最後の行（締めが無い時の終わり方）
    const endings = new Map<string, number>();
    const endKind = (l: string) => /退去|入居可能|ご内覧可能/.test(l) ? "退去予定・入居時期の行" : /即入居|空室/.test(l) ? "空室・即入居の行" : /敷金|礼金|初期費用/.test(l) ? "敷金礼金・初期費用の行" : /インターネット|Wi-?Fi|通信費/.test(l) ? "ネット無料の行" : /徒歩|駅|立地|アクセス/.test(l) ? "駅・立地の行" : /^[・･]/.test(l) ? "箇条書きの行" : /（設備）/.test(l) ? "（設備）欄" : /見積/.test(l) ? "見積書同封の行" : /オススメ(?:出来|でき)る/.test(l) ? "かなりオススメ出来るお部屋の文" : "その他（設備・間取りの文）";
    const folNo = set.filter((r) => r.follow && kind(r.text) === "なし");
    for (const r of folNo) endings.set(endKind(lastLine(r.text)), (endings.get(endKind(lastLine(r.text))) ?? 0) + 1);
    console.log(`
━━ 2通目が続き1通目に締めが無い ${folNo.length}組: 1通目の最後の行 ${[...endings].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}（${pct(n, folNo.length)}）`).join("・")}`);
    const hFol = H.filter((r) => r.follow);
    for (const r of hFol.slice(0, SHOW)) console.log(`     [${r.at.slice(0, 10)} human] 1通目末: …${one(r.text).slice(-90)}
        → 2通目: ${one(r.follow!).slice(0, 160)}`);
    for (const r of folNo.filter((x) => x.origin !== "human").slice(-SHOW)) console.log(`     [${r.at.slice(0, 10)} ${r.origin}] 1通目末: …${one(r.text).slice(-80)}
        → 2通目: ${one(r.follow!).slice(0, 140)}`);
  }

  // 出口: 1通目の締めの文を落とす（removeRecommendClosing）を実送信の1通目に当てる。落ちた文を全部数えて目で読む（事実の文が落ちていないか）
  {
    const all = [...H, ...E, ...A];
    const rm = all.map((r) => ({ r, x: removeRecommendClosing(r.text) })).filter((y) => y.x.removed.length > 0);
    const kinds = new Map<string, number>();
    for (const y of rm) for (const s of y.x.removed) { const k = s.replace(/[^\s、。！!\n]{1,10}さん/g, "〈名〉さん").replace(/[😊😌☺️✨]/gu, "").slice(0, 60); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
    console.log(`\n━━ 1通目の締めの文を落とす: 掛かる通 ${rm.length}/${all.length}（スタッフが書いた ${rm.filter((y) => y.r.origin === "human").length}/${H.length}）・落ちた文 ${[...kinds.values()].reduce((a, b) => a + b, 0)}（種類 ${kinds.size}）`);
    for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(3)}  ${k}`);
    const left = all.filter((r) => { const t = removeRecommendClosing(r.text).text; return /お気に召|ご査収/.test(t); });
    console.log(`   落とした後もどこかに締めの語が残る通 ${left.length}（文の途中から誘導に続く文・見積書の行など＝触らない）`);
    for (const r of left.slice(0, 6)) console.log(`     …${one(removeRecommendClosing(r.text).text).slice(-120)}`);
  }

  // 出口: 文末の「。」→「！！」（混ざる通だけ）を実送信に当てる（変換の前後を目で読む）
  for (const [label, xs] of [["スタッフが書いた", H], ["直して送った", E], ["ほぼそのまま", A]] as Array<[string, Row[]]>) {
    const ch = xs.map((r) => ({ r, u: unifyBangEnding(r.text) })).filter((x) => x.u.changed > 0);
    console.log(`
━━ 文末の「。」→「！！」が掛かる: ${label} ${ch.length}/${xs.length}`);
    for (const x of ch.slice(0, 4)) console.log(`     前: ${one(x.r.text).slice(0, 200)}
     後: ${one(x.u.text).slice(0, 200)}`);
  }
  console.log(`
━━ 入口: 手本に見せない（isCleanFirstExample=false）: スタッフが書いた ${H.filter((r) => !isCleanFirstExample(r.text)).length}/${H.length} ／ ほぼそのまま ${A.filter((r) => !isCleanFirstExample(r.text)).length}/${A.length}`);
  for (const r of H.filter((x) => !isCleanFirstExample(x.text))) console.log(`     human: ${one(r.text).slice(0, 200)}`);

  // スタッフが直した時に消した文・足した文（文単位）
  const removedS = new Map<string, number>(), addedS = new Map<string, number>();
  for (const r of E) {
    const d = new Set(splitSentences(r.draft ?? "").map(norm)), s = new Set(splitSentences(r.text).map(norm));
    for (const x of splitSentences(r.draft ?? "")) if (!s.has(norm(x))) removedS.set(mask(x), (removedS.get(mask(x)) ?? 0) + 1);
    for (const x of splitSentences(r.text)) if (!d.has(norm(x))) addedS.set(mask(x), (addedS.get(mask(x)) ?? 0) + 1);
  }
  console.log(`\n━━ スタッフが直した ${E.length}通で 消した文（例）`);
  for (const [s] of [...removedS].slice(0, SHOW * 3)) console.log(`   − ${s.slice(0, 140)}`);
  console.log(`━━ 足した文（例）`);
  for (const [s] of [...addedS].slice(0, SHOW * 3)) console.log(`   ＋ ${s.slice(0, 140)}`);

  if (RAW) {
    const pick = set.filter((r) => r.origin === RAW).sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, SHOW);
    for (const r of pick) console.log(`\n=== [${r.at.slice(0, 10)} ${r.origin} ${r.scene}${r.vacating ? "・退去予定" : ""}] (${r.text.length}字)\n${mask(r.text)}${r.draft ? `\n--- 直す前\n${mask(r.draft)}` : ""}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
