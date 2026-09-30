// scripts/audit-second-message-phrasing.ts — AIX の1通目（物件オススメ・物件ピックアップ）の直後に送った2通目の「言い回し」を実送信で数える（読むだけ）
//
// 2026-09-30 竹内（YUMA に届いた2通目「…かなり珍しい好条件です！！／…この208号室ならではの強みです😊！！」を見て）:
//   「言い回しが AI くさいから原因見つけて改善する。実際使っている言い回しが出るように。208号室など号室だけのところいれへんし、
//    強みですなどの言い回しもいれていない。実際の LINE や成約データ見て改善する。絵文字の使い方や、文の区切る部分とつなげる部分も。
//    複数のなかの物件のなかでオススメや、新着物件のなかでオススメ等 状況によって違うのと、退去予定の物件や空室の物件によって訴求方法も変わる」
//
// 組の作り方: こちらの AIX の1通目（is_aix_generated・本文あり・aix_usage_logs の property_recommendation / property_send に ±5分で当たる）
//   → 間にお客様の発言なしで 15分以内に続けて送った文の2通目（画像は飛ばす）。
//   YUMA は除く。申込以降（その会話で最初に AIX【申込へ】を押した時刻より後）は数えない。
// 場面: (a) 複数の中で1件を推す（比較の言い方） (b) 新着 (c) 1件だけ (d) 退去予定 / 空室
// 実行: npx tsx --env-file=.env.local scripts/audit-second-message-phrasing.ts [--days=365] [--show=12] [--scene=a|b|c|d|all] [--drafts]
import { createClient } from "@supabase/supabase-js";
import { AI_PHRASE_RULES, findAiPhrases, roomOnlyMentions, styleStatsOf, sceneOfSecond, ensureOneEmoji, fixMissingNi, type SecondScene } from "../app/lib/second-message-style";
import { leakedExampleFacts, unfoundedCostClaim, vacatingFromMaterial, SECOND_MESSAGE_EXAMPLES, type SecondMaterialRow } from "../app/lib/second-message-scene";
import { headOfFirstMessage, pickupForFirstMessage, hasClosingSentence, type PickupLookupRow } from "../app/lib/recommend-cta";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365")) || 365;
const SHOW = Number(arg("show", "12"));
const SCENE = arg("scene", "all");
const DRAFTS = args.includes("--drafts");
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const mask = (s: string) => s.replace(/[^\s、。！!\n]{1,10}(?:さん|様)/g, (m) => (/(お客|皆|奥|旦那|お子|息子|娘|大家|オーナー|担当)/.test(m) ? m : "〈名〉さん"));
const one = (s: string) => mask(s).replace(/\n\n/g, " ⏎⏎ ").replace(/\n/g, " ⏎ ");

type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type L = { conversation_id: string | null; aix_type: string | null; sent_at: string | null; created_at: string; picker_choices: Record<string, unknown> | null };

async function all<T>(build: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

export type Pair = { conv: string; aix: string; first: string; second: string; at: string; scene: SecondScene; vacating: boolean; won: boolean; newPicker: boolean };

async function main() {
  const rows = await all<M>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("conversation_id").order("created_at").range(a, b));
  const logs = await all<L>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, created_at, picker_choices").gte("created_at", since).order("created_at").range(a, b));
  const applyAt = new Map<string, number>();
  const logsByConv = new Map<string, L[]>();
  for (const l of logs) {
    const c = l.conversation_id ?? ""; if (!c) continue;
    const t = Date.parse(l.sent_at ?? l.created_at);
    if ((l.aix_type ?? "").startsWith("application_push") && !(applyAt.get(c)! <= t)) applyAt.set(c, t);
    if (!logsByConv.has(c)) logsByConv.set(c, []);
    logsByConv.get(c)!.push(l);
  }
  const { data: wonRows } = await sb.from("conversations").select("id, status").in("status", ["closed_won", "applying", "screening", "application", "contract", "approved"]).limit(5000);
  const won = new Set(((wonRows ?? []) as Array<{ id: string }>).map((r) => r.id));

  const pairs: Pair[] = [];
  let staffTexts = 0;
  const staffAll: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (isTestConversation(a.conversation_id) || a.sender !== "staff" || !a.text || /^\[(画像|動画|スタンプ|ファイル)/.test(a.text)) continue;
    const at = Date.parse(a.created_at);
    if (applyAt.has(a.conversation_id) && at >= applyAt.get(a.conversation_id)!) continue;
    staffTexts++; staffAll.push(a.text);
    if (!a.is_aix_generated) continue;
    const log = (logsByConv.get(a.conversation_id) ?? []).find((l) => Math.abs(Date.parse(l.sent_at ?? l.created_at) - at) <= 5 * 60_000 && /^property_(recommendation|send)/.test(l.aix_type ?? ""));
    if (!log) continue;
    // 続けて送った次の文（画像は飛ばす・お客様の発言が挟まれば組にしない）
    let b: M | null = null;
    for (let j = i + 1; j < rows.length; j++) {
      const n = rows[j];
      if (n.conversation_id !== a.conversation_id || n.sender !== "staff") break;
      if (Date.parse(n.created_at) - at > 15 * 60_000) break;
      if (!n.text || /^\[(画像|動画|スタンプ|ファイル)/.test(n.text)) continue;
      b = n; break;
    }
    if (!b || b.is_aix_generated) continue;
    const pc = (log.picker_choices ?? {}) as { pickup_type?: string | null; is_new_arrival?: boolean };
    const newPicker = !!pc.is_new_arrival || /新着/.test(String(pc.pickup_type ?? ""));
    const aix = (log.aix_type ?? "").startsWith("property_send") ? "property_send" : "property_recommendation";
    pairs.push({
      conv: a.conversation_id, aix, first: a.text, second: b.text!, at: b.created_at,
      scene: sceneOfSecond({ second: b.text!, first: a.text, aix, newPicker }),
      vacating: /退去予定|退去の為|退去のため|退去後/.test(`${a.text}\n${b.text}`),
      won: won.has(a.conversation_id), newPicker,
    });
  }
  console.log(`直近${DAYS}日（YUMA 除く・申込以降を除く）: スタッフの文 ${staffTexts}通 ／ AIX 物件オススメ・物件ピックアップの1通目 → 続けて送った2通目 ${pairs.length}組（成約側の会話 ${pairs.filter((p) => p.won).length}組）\n`);

  const SCENES: Array<[string, string, (p: Pair) => boolean]> = [
    ["a", "(a) 複数の中で1件を推す（比較の言い方）", (p) => p.scene === "compare"],
    ["b", "(b) 新着", (p) => p.scene === "new_listing"],
    ["c", "(c) 1件だけのオススメの後（比較・新着の言い方なし・物件オススメ）", (p) => p.scene === "single"],
    ["e", "(e) 物件ピックアップの後（1件を推していない）", (p) => p.scene === "after_pickup"],
    ["d1", "(d) 退去予定", (p) => p.vacating],
    ["d2", "(d) 退去予定でない（空室）", (p) => !p.vacating && p.scene !== "after_pickup"],
    ["won", "成約側の会話（申込より前）", (p) => p.won],
    ["all", "全部", () => true],
  ];
  for (const [key, label, f] of SCENES) {
    const set = pairs.filter(f);
    if (set.length === 0) { console.log(`━━ ${label}: 0組`); continue; }
    const st = set.map((p) => styleStatsOf(p.second));
    console.log(`━━ ${label}: ${set.length}組`);
    console.log(`   長さ 中央値 ${med(st.map((s) => s.len))}字・${med(st.map((s) => s.lines))}行・段落 ${med(st.map((s) => s.paragraphs))}・文 ${med(st.map((s) => s.sentences))}・1文の長さ 中央値 ${med(st.flatMap((s) => s.sentenceLens))}字`);
    console.log(`   絵文字: 無し ${pct(st.filter((s) => s.emoji === 0).length, set.length)}・1個 ${pct(st.filter((s) => s.emoji === 1).length, set.length)}・2個 ${pct(st.filter((s) => s.emoji === 2).length, set.length)}・3個以上 ${pct(st.filter((s) => s.emoji >= 3).length, set.length)} ／ 絵文字の位置: 文末（！！の直前） ${pct(st.reduce((n, s) => n + s.emojiBeforeBang, 0), st.reduce((n, s) => n + s.emoji, 0))}`);
    const em = new Map<string, number>(); for (const s of st) for (const e of s.emojis) em.set(e, (em.get(e) ?? 0) + 1);
    console.log(`   絵文字の種類: ${[...em].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([e, n]) => `${e}${n}`).join(" ")}`);
    console.log(`   「！！」で終わる文 ${pct(st.reduce((n, s) => n + s.bangEnd, 0), st.reduce((n, s) => n + s.sentences, 0))}・「。」で終わる文 ${pct(st.reduce((n, s) => n + s.maruEnd, 0), st.reduce((n, s) => n + s.sentences, 0))}・最後の文に絵文字 ${pct(st.filter((s) => s.lastHasEmoji).length, set.length)}`);
    console.log(`   物件の呼び方: 建物名＋号室 ${pct(st.filter((s) => s.nameRoom).length, set.length)}・号室だけ（この◯◯◯号室 等） ${pct(set.filter((p) => roomOnlyMentions(p.second).length > 0).length, set.length)}・こちらのお部屋 ${pct(st.filter((s) => s.kochira).length, set.length)}・名前呼びかけ ${pct(st.filter((s) => s.addressesName).length, set.length)}`);
    console.log(`   文中の「・」で3つ以上並べる ${pct(st.filter((s) => s.nakaguroList).length, set.length)}・箇条書きの行 ${pct(st.filter((s) => s.bullets >= 2).length, set.length)}・「〜で、」「〜となり、」でつなぐ文 ${pct(st.filter((s) => s.joins > 0).length, set.length)}`);
    console.log(`   定番: かなりオススメ出来るお部屋 ${pct(set.filter((p) => /かなりオススメ(?:出来|でき)るお部屋/.test(p.second)).length, set.length)}・お気に召されましたら ${pct(set.filter((p) => /お気に召され/.test(p.second)).length, set.length)}・ご査収 ${pct(set.filter((p) => /ご査収/.test(p.second)).length, set.length)}・費用を抑える事 ${pct(set.filter((p) => /費用[^\n]{0,8}抑え/.test(p.second)).length, set.length)}・お気軽にご連絡 ${pct(set.filter((p) => /お気軽に/.test(p.second)).length, set.length)}`);
    if (SCENE === key || (SCENE === "all" && key !== "all" && key !== "d2")) {
      for (const p of [...set].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, SHOW)) console.log(`     [${p.at.slice(0, 10)} ${p.aix === "property_send" ? "PU" : "OS"}${p.won ? "・成約側" : ""}${p.vacating ? "・退去予定" : ""}] ${one(p.second).slice(0, 400)}`);
    }
    console.log("");
  }

  // AI の言い回しが実送信に何通あるか（2通目 ／ スタッフの文全体）
  console.log(`━━ AI の言い回し（検査の語）が実送信に何通あるか — 2通目 ${pairs.length}組 ／ スタッフの文全体 ${staffAll.length}通`);
  for (const r of AI_PHRASE_RULES) {
    const in2 = pairs.filter((p) => r.re.test(p.second));
    const inAll = staffAll.filter((t) => r.re.test(t));
    console.log(`   ${r.exit ? "【出口】" : "（数えるだけ）"} ${r.key.padEnd(22)} 2通目 ${String(in2.length).padStart(3)}  全体 ${String(inAll.length).padStart(4)}`);
    for (const p of in2.slice(0, 4)) console.log(`        2通目: ${one(p.second).slice(0, 200)}`);
    if (in2.length === 0) for (const t of inAll.slice(0, 3)) console.log(`        全体: ${one(t).slice(0, 200)}`);
  }
  const ro = pairs.filter((p) => roomOnlyMentions(p.second).length > 0);
  const roAll = staffAll.filter((t) => roomOnlyMentions(t).length > 0);
  console.log(`   【出口】号室だけで呼ぶ        2通目 ${ro.length}  全体 ${roAll.length}`);
  for (const p of ro.slice(0, 10)) console.log(`        2通目: ${one(p.second).slice(0, 220)}`);
  for (const t of roAll.slice(0, 10)) console.log(`        全体: ${roomOnlyMentions(t).join(",")} … ${one(t).slice(0, 200)}`);
  const hitAny = pairs.filter((p) => findAiPhrases(p.second).length > 0);
  console.log(`\n   出口の検査に当たる実送信の2通目（＝誤って作り直しになる数）: ${hitAny.length}/${pairs.length}`);
  for (const p of hitAny) console.log(`     ${findAiPhrases(p.second).map((h) => h.key).join(",")} … ${one(p.second).slice(0, 240)}`);

  // 出口の残り2つを実送信に当てる（変換の前後を目で読む）
  {
    // 手本の語の持ち込み: 1通目を「今回の事実」として渡す。手本そのものの通（同じ物件の実送信）は当たって当然なので分けて数える
    const exHeads = Object.values(SECOND_MESSAGE_EXAMPLES).flat().map((e) => e.text.replace(/{{NAME}}/g, "").slice(0, 24));
    const leak = pairs.map((p) => ({ p, hit: leakedExampleFacts(p.second, p.first) })).filter((x) => x.hit.length > 0);
    const leakOther = leak.filter((x) => !exHeads.some((h) => x.p.second.replace(/[^s]{1,10}さん/g, "").includes(h.slice(0, 12))));
    console.log(`
━━ 手本の語（物件名・駅・金額・日付）が入っている実送信の2通目: ${leak.length}/${pairs.length}（うち手本にした通そのもの以外 ${leakOther.length}）`);
    for (const x of leakOther.slice(0, 12)) console.log(`     ${x.hit.join(",")} … ${one(x.p.second).slice(0, 200)}`);
    const ni = pairs.filter((p) => fixMissingNi(p.second).fixed > 0);
    console.log(`\n━━ 「さんかなりオススメ」→「さんにかなりオススメ」に直る実送信の2通目: ${ni.length}/${pairs.length}`);
    for (const x of ni.slice(0, 5)) console.log(`     ${one(x.second).slice(0, 160)}`);
    const em = pairs.map((p) => ({ p, r: ensureOneEmoji(p.second) })).filter((x) => x.r.added);
    console.log(`
━━ 絵文字を足す事になる実送信の2通目（絵文字なし・「！！」終わり）: ${em.length}/${pairs.length}（${pct(em.length, pairs.length)}）`);
    for (const x of em.slice(0, 6)) console.log(`     前: ${one(x.p.second).slice(-60)}
     後: ${one(x.r.text).slice(-60)}`);
  }

  // 資料（売上サポの行）が当たる実送信で: 費用の検査（礼金ありなのに「費用を抑える事」）と、資料の退去予定を2通目が伝えているか
  {
    const convs = [...new Set(pairs.map((p) => p.conv))];
    const pk: Array<PickupLookupRow & SecondMaterialRow & { conversation_id: string }> = [];
    for (let k = 0; k < convs.length; k += 50) {
      const { data } = await sb.from("property_pickups").select("conversation_id, property_name, room_no, created_at, terms").in("conversation_id", convs.slice(k, k + 50)).limit(5000);
      pk.push(...((data ?? []) as typeof pk));
    }
    let matched = 0, cost = 0, vac = 0, vacTold = 0;
    const costShow: string[] = [], vacShow: string[] = [];
    for (const p of pairs) {
      const head = headOfFirstMessage(p.first);
      const row = pickupForFirstMessage(pk.filter((r) => r.conversation_id === p.conv), head) as (SecondMaterialRow | null);
      if (!row) continue;
      matched++;
      const c = unfoundedCostClaim(p.second, row, p.first);
      if (c) { cost++; costShow.push(`     「${c}」 資料: 敷${row.terms?.deposit}/礼${row.terms?.keyMoney} … ${one(p.second).slice(0, 200)}`); }
      if (vacatingFromMaterial(row) === true) {
        vac++;
        const told = /退去|入居中|居住中/.test(`${p.first}
${p.second}`);
        if (told) vacTold++; else vacShow.push(`     資料: ${row.terms?.evidence?.moveIn ?? "?"} … 1通目: ${one(p.first).slice(0, 60)} → 2通目: ${one(p.second).slice(0, 140)}`);
      }
    }
    console.log(`
━━ 資料の行が当たる実送信 ${matched}組: 費用の検査に当たる ${cost} ／ 資料が退去予定・居住中 ${vac}組のうち、1通目か2通目で退去予定を伝えている ${vacTold}`);
    for (const x of costShow.slice(0, 10)) console.log(x);
    for (const x of vacShow.slice(0, 10)) console.log(x);
  }

  if (args.includes("--raw")) {
    // 手本を選ぶ時用: 場面ごとに名前を伏せない実物（画面に出すだけ・保存しない）
    const want = arg("raw-scene", "compare");
    const set = pairs.filter((p) => (want === "vacating" ? p.vacating : p.scene === want && !p.vacating)).sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, SHOW);
    for (const p of set) console.log(`\n=== [${p.at.slice(0, 10)} ${p.aix}${p.won ? "・成約側" : ""}] (${p.second.length}字)\n${p.second}`);
    return;
  }

  if (args.includes("--first-star")) {
    // 1通目が既に「🌟建物 号室／…かなりオススメ出来るお部屋となります」の形（今の AIX 物件オススメの1通目）の時、2通目に何を書いているか
    const fs = pairs.filter((p) => /^\s*🌟/.test(p.first) && /オススメ(?:出来|でき)るお部屋/.test(p.first));
    const dup = fs.filter((p) => /オススメ(?:出来|でき)るお部屋/.test(p.second));
    console.log(`\n━━ 1通目が「🌟…かなりオススメ出来るお部屋となります」の形 ${fs.length}組 ／ 2通目でも「オススメ出来るお部屋」を重ねる ${dup.length}（${pct(dup.length, fs.length)}）・物件名＋号室を書く ${pct(fs.filter((p) => styleStatsOf(p.second).nameRoom).length, fs.length)}・お気に召されましたら ${pct(fs.filter((p) => /お気に召され/.test(p.second)).length, fs.length)}・ご査収 ${pct(fs.filter((p) => /ご査収/.test(p.second)).length, fs.length)}・見積書 ${pct(fs.filter((p) => /見積/.test(p.second)).length, fs.length)}・退去予定 ${pct(fs.filter((p) => /退去/.test(p.second)).length, fs.length)}`);
    console.log(`   長さ 中央値 ${med(fs.map((p) => p.second.length))}字`);
    for (const p of [...fs].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, SHOW)) console.log(`     [${p.at.slice(0, 10)}${p.won ? "・成約側" : ""}] 1通目: ${one(p.first).slice(0, 110)}\n        → 2通目: ${one(p.second).slice(0, 360)}`);
  }

  if (args.includes("--closing-pairs")) {
    // 2026-10-01 竹内さん了承「実送信の形に合わせる」(a): 1通目の締め × 2通目の締め（同じ締めを2通で重ねるのが実送信の形か）
    //   (b): 物件ピックアップ（複数）の後の2通目の形（どの物件を推すか・言い回し）
    const kindOf = (t: string): string => {
      const k = [hasClosingSentence(t, "apply") ? "申込" : "", hasClosingSentence(t, "viewing") ? "内覧" : "", hasClosingSentence(t, "receipt") ? "ご査収" : ""].filter(Boolean);
      return k.length ? k.join("+") : "なし";
    };
    for (const [label, f] of [
      ["物件オススメ（1通目が🌟の形）", (p: Pair) => p.aix === "property_recommendation" && /^\s*🌟/.test(p.first)],
      ["物件オススメ（全部）", (p: Pair) => p.aix === "property_recommendation"],
      ["物件ピックアップ（複数）の後", (p: Pair) => p.aix === "property_send"],
    ] as Array<[string, (p: Pair) => boolean]>) {
      const set = pairs.filter(f);
      const tab = new Map<string, number>();
      for (const p of set) { const k = `${kindOf(p.first)} → ${kindOf(p.second)}`; tab.set(k, (tab.get(k) ?? 0) + 1); }
      console.log(`\n━━ ${label}: ${set.length}組 ／ 1通目の締め → 2通目の締め`);
      for (const [k, n] of [...tab].sort((x, y) => y[1] - x[1])) console.log(`   ${k.padEnd(22)} ${String(n).padStart(4)}（${pct(n, set.length)}）`);
      const same = set.filter((p) => { const a = kindOf(p.first), b = kindOf(p.second); return a !== "なし" && b !== "なし" && a.split("+").some((x) => b.split("+").includes(x)); });
      console.log(`   1通目に締めがある ${set.filter((p) => kindOf(p.first) !== "なし").length}組のうち2通目で同じ締めを重ねる ${same.length}`);
      for (const p of same.slice(0, Math.min(SHOW, 6))) console.log(`     1通目末: …${one(p.first).slice(-70)}\n       2通目: ${one(p.second).slice(0, 220)}`);
    }
    // (b) 物件ピックアップの後の2通目の形
    const pu = pairs.filter((p) => p.aix === "property_send");
    const st = pu.map((p) => styleStatsOf(p.second));
    console.log(`\n━━ 物件ピックアップ（複数）の後の2通目 ${pu.length}組: 中でも特に ${pct(pu.filter((p) => /中でも特に/.test(p.second)).length, pu.length)}・かなりオススメ出来るお部屋 ${pct(pu.filter((p) => /かなりオススメ(?:出来|でき)るお部屋/.test(p.second)).length, pu.length)}・建物名＋号室 ${pct(st.filter((s) => s.nameRoom).length, pu.length)}・お気に召されましたら ${pct(pu.filter((p) => /お気に召され/.test(p.second)).length, pu.length)}・ご査収 ${pct(pu.filter((p) => /ご査収/.test(p.second)).length, pu.length)}・長さ 中央値 ${med(pu.map((p) => p.second.length))}字`);
    for (const p of [...pu].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, SHOW)) console.log(`     [${p.at.slice(0, 10)}${p.won ? "・成約側" : ""}] 1通目: ${one(p.first).slice(0, 90)}\n        → 2通目: ${one(p.second).slice(0, 300)}`);
  }

  if (DRAFTS) {
    // AI の下書き（aix_generate_log の aix-template-generate）に当てる
    const gl = await all<{ generated_text: string | null; action_type: string | null; created_at: string; conditions_snapshot: Record<string, unknown> | null }>((a, b) =>
      sb.from("aix_generate_log").select("generated_text, action_type, created_at, conditions_snapshot").gte("created_at", since).in("action_type", ["property_recommendation", "property_send"]).order("created_at", { ascending: false }).range(a, b));
    const tg = gl.filter((g) => (g.conditions_snapshot as { source?: string } | null)?.source === "aix-template-generate" && (g.generated_text ?? "").trim());
    const hit = tg.filter((g) => findAiPhrases(g.generated_text!).length > 0);
    console.log(`\n━━ AI の2通目の下書き（aix_generate_log・テンプレート生成）${tg.length}件のうち検査に当たる ${hit.length}件（${pct(hit.length, tg.length)}）`);
    const byKey = new Map<string, number>();
    for (const g of hit) for (const h of findAiPhrases(g.generated_text!)) byKey.set(h.key, (byKey.get(h.key) ?? 0) + 1);
    console.log("   " + [...byKey].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(" ／ "));
    for (const g of hit.slice(0, SHOW)) console.log(`     [${g.created_at.slice(0, 10)}] ${findAiPhrases(g.generated_text!).map((h) => h.key).join(",")} … ${one(g.generated_text!).slice(0, 260)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
