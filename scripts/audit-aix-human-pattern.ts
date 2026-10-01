// scripts/audit-aix-human-pattern.ts — AIX の種類ごとに「スタッフが書いた／直した／AI のまま」に分けて、人の書き方を読む（読むだけ）
//
// 2026-10-01 竹内「AIXテンプレートの部分、物件オススメのところが改善されたように、見積書や他のよく使うAIXテンプレートの部分も改善する」
//   物件オススメで学んだ型（設計知見「『実送信にある』は AI の下書きのまま送った通で数えない」）を他の AIX にも当てる:
//     1通目 … aix_usage_logs.generated_text（AI の下書き）と、送信の前後に届いたこちらの発言を似ている度（文字の2つ組 Dice）で結ぶ
//     2通目 … 1通目の後 15分以内・お客様の発言が挟まらない最初のこちらの文字の発言。
//              template_selection_logs.adapted_text（AIX テンプレートの ✨ 生成）と比べる
//     origin: as_is（0.97 以上）／ edited（0.45 以上）／ human（下書きが近くに無い・is_aix_generated=false）
//   ⚠ 見積書の「カバーレター」（aix/action が Haiku で作る coverLetter）は画面に出ず送られていない（学習の保存だけ）→ 2通目の下書きとして数えない
//
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-human-pattern.ts --type=estimate_sheet [--days=365] [--show=8] [--part=first|second] [--raw=human|edited|as_is]
import { createClient } from "@supabase/supabase-js";
import { styleStatsOf } from "../app/lib/second-message-style";
import { loadAixPairs, pageAll as all, type AixPair as Pair, type Origin } from "./aix-pairs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const TYPE = arg("type", "estimate_sheet");
const DAYS = Number(arg("days", "365")) || 365;
const SHOW = Number(arg("show", "8"));
const PART = arg("part", "second");
const RAW = arg("raw", "");
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const mask = (s: string) => s.replace(/[^\s、。！!\n「」]{1,10}(?:さん|様)/g, (m) => (/(お客|皆|奥|旦那|お子|息子|娘|大家|オーナー|担当)/.test(m) ? m : "〈名〉さん"));
const norm = (s: string) => s.replace(/\s+/g, "").replace(/\p{Extended_Pictographic}|️/gu, "");
type L = { conversation_id: string | null; aix_type: string | null; sent_at: string | null; created_at: string; generated_text: string | null };

async function main() {
  const { pairs, sends, noFirst } = await loadAixPairs(sb, TYPE, since);
  const logs = { length: sends };
  console.log(`== ${TYPE}: ${DAYS}日・送信 ${logs.length}回（1通目が見つからない ${noFirst}）`);
  const cnt = (xs: Array<Origin | null>) => `human ${xs.filter((x) => x === "human").length} ／ edited ${xs.filter((x) => x === "edited").length} ／ as_is ${xs.filter((x) => x === "as_is").length}`;
  console.log(`   1通目: ${cnt(pairs.map((p) => p.firstOrigin))}`);
  console.log(`   2通目が続いた ${pairs.filter((p) => p.second).length}/${pairs.length}（${pct(pairs.filter((p) => p.second).length, pairs.length)}）: ${cnt(pairs.map((p) => p.secondOrigin))}`);

  const style = (label: string, texts: string[]) => {
    if (!texts.length) { console.log(`━━ ${label}: 0`); return; }
    const st = texts.map((t) => styleStatsOf(t));
    const emN = st.map((s) => s.emojis.length);
    const em = new Map<string, number>(); for (const s of st) for (const e of s.emojis) em.set(e, (em.get(e) ?? 0) + 1);
    const has = (re: RegExp) => pct(texts.filter((t) => re.test(t)).length, texts.length);
    console.log(`━━ ${label}: ${texts.length}通 長さ中央値 ${med(st.map((s) => s.len))}字・文 ${med(st.map((s) => s.sentences))}・段落 ${med(st.map((s) => s.paragraphs))}`);
    console.log(`   絵文字 無し ${pct(emN.filter((n) => n === 0).length, texts.length)}・1個 ${pct(emN.filter((n) => n === 1).length, texts.length)}・2個以上 ${pct(emN.filter((n) => n >= 2).length, texts.length)} ／ ${[...em].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([e, n]) => `${e}${n}`).join(" ")}`);
    console.log(`   冒頭: 名前さん ${has(/^[^\n]{1,12}さん/)}・お世話に ${has(/お世話になって/)}・お待たせ ${has(/お待たせ/)}・かしこまりました ${has(/かしこまりました/)}`);
    console.log(`   語: 最大限割引 ${has(/最大限割引/)}・御見積書/お見積書 ${has(/[御お]見積/)}・物件名(号室) ${has(/[0-9０-９]{2,4}号室/)}・金額(円) ${has(/[0-9,，]{3,}円/)}・退去予定 ${has(/退去予定/)}・募集中 ${has(/募集中/)}`);
    console.log(`   締め: ご案内(内覧) ${has(/ご案内させて|ご都合(?:よろしい|の良い)お日にち|ご内覧/)}・申込 ${has(/お申込|お申し込|お部屋抑え|お部屋を抑え/)}・ご査収 ${has(/ご査収/)}・ご確認 ${has(/ご確認(?:ください|の程|よろしく)/)}・お気軽に ${has(/お気軽に/)}・他のお部屋 ${has(/他[のに]?(?:も)?(?:お気に召|気になる)/)}`);
  };
  const xs = PART === "first" ? pairs.map((p) => ({ t: p.first, o: p.firstOrigin, d: p.firstOrigin === "edited" ? p.firstDraft : null, p }))
    : pairs.filter((p) => p.second).map((p) => ({ t: p.second!, o: p.secondOrigin, d: p.secondDraft, p }));
  for (const o of ["human", "edited", "as_is"] as Origin[]) style(`${PART === "first" ? "1通目" : "2通目"} ${o}`, xs.filter((x) => x.o === o).map((x) => x.t));
  const nine = Date.parse("2026-09-01T00:00:00+09:00");
  style(`${PART === "first" ? "1通目" : "2通目"} human（9月以降）`, xs.filter((x) => x.o === "human" && Date.parse(x.p.at) >= nine).map((x) => x.t));

  // --lines=正規表現||正規表現… : 下書きにあった時にスタッフが残した／消した、下書きに無いのに足した、スタッフが書いた通で使った数
  const LINES = arg("lines", "");
  if (LINES) {
    const withDraft = xs.filter((x) => x.o && x.p.firstDraft && PART === "first");
    for (const src of LINES.split("||")) {
      const re = new RegExp(src);
      const inD = withDraft.filter((x) => re.test(x.p.firstDraft));
      const kept = inD.filter((x) => re.test(x.t));
      const added = withDraft.filter((x) => !re.test(x.p.firstDraft) && re.test(x.t));
      const hum = xs.filter((x) => x.o === "human");
      console.log(`\n━━ /${src}/: 下書きにあった ${inD.length} → 残した ${kept.length}・消した ${inD.length - kept.length}（${pct(inD.length - kept.length, inD.length)}）／ 下書きに無く足した ${added.length} ／ スタッフが書いた通 ${hum.filter((x) => re.test(x.t)).length}/${hum.length}`);
    }
  }
  // --endings: 送った文の最後の行（数字・名前は伏せる）
  if (args.includes("--endings")) {
    const lastLine = (t: string) => { const ls = t.split("\n").map((x) => x.trim()).filter(Boolean); return mask(ls[ls.length - 1] ?? "").replace(/[0-9０-９,，]+/g, "#").replace(/\p{Extended_Pictographic}|️/gu, "").slice(0, 50); };
    for (const o of ["human", "edited", "as_is"] as Origin[]) {
      const tab = new Map<string, number>();
      const ys = xs.filter((x) => x.o === o);
      for (const x of ys) tab.set(lastLine(x.t), (tab.get(lastLine(x.t)) ?? 0) + 1);
      console.log(`\n━━ 最後の行（${o} ${ys.length}）`);
      for (const [k, n] of [...tab].sort((a, b) => b[1] - a[1]).slice(0, SHOW)) console.log(`   ${String(n).padStart(3)} ${k}`);
    }
  }

  if (args.includes("--diff")) {
    // スタッフが直した通: 下書きから消した文・足した文（文単位・名前は伏せる）を多い順に
    const { splitSentences } = await import("../app/lib/second-message-style");
    const key = (s: string) => mask(s).replace(/[0-9０-９,，]+/g, "#").replace(/\p{Extended_Pictographic}|️/gu, "").replace(/\s+/g, "").slice(0, 70);
    const rm = new Map<string, number>(), ad = new Map<string, number>();
    const E = xs.filter((x) => x.o === "edited" && x.d);
    for (const x of E) {
      const d = splitSentences(x.d!), s = splitSentences(x.t);
      const dn = new Set(d.map(norm)), sn = new Set(s.map(norm));
      for (const y of d) if (!sn.has(norm(y))) rm.set(key(y), (rm.get(key(y)) ?? 0) + 1);
      for (const y of s) if (!dn.has(norm(y))) ad.set(key(y), (ad.get(key(y)) ?? 0) + 1);
    }
    console.log(`\n━━ edited ${E.length}通: スタッフが消した文（多い順）`);
    for (const [k, n] of [...rm].sort((a, b) => b[1] - a[1]).slice(0, SHOW * 4)) console.log(`   −${String(n).padStart(3)} ${k}`);
    console.log(`━━ スタッフが足した文（多い順）`);
    for (const [k, n] of [...ad].sort((a, b) => b[1] - a[1]).slice(0, SHOW * 4)) console.log(`   ＋${String(n).padStart(3)} ${k}`);
  }

  // --prior=meeting_place : その AIX より前に同じ会話でこの種類の AIX を送っていたか（内覧の段階など）で分けて締めを数える
  const PRIOR = arg("prior", "");
  if (PRIOR) {
    const pl = (await all<L>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, created_at, generated_text").in("aix_type", PRIOR.split(",")).not("sent_at", "is", null).gte("created_at", since).order("created_at").range(a, b)));
    const priorAt = new Map<string, number>();
    for (const l of pl) { const c = l.conversation_id ?? ""; const t = Date.parse(l.sent_at!); if (!priorAt.has(c) || priorAt.get(c)! > t) priorAt.set(c, t); }
    const has = (x: { p: Pair }) => priorAt.has(x.p.conv) && priorAt.get(x.p.conv)! < Date.parse(x.p.at);
    for (const o of ["human", "edited"] as Origin[]) {
      style(`${o}・${PRIOR} の後`, xs.filter((x) => x.o === o && has(x)).map((x) => x.t));
      style(`${o}・${PRIOR} の前`, xs.filter((x) => x.o === o && !has(x)).map((x) => x.t));
    }
  }

  if (RAW) {
    const pick = xs.filter((x) => x.o === RAW).sort((a, b) => (a.p.at < b.p.at ? 1 : -1)).slice(0, SHOW);
    for (const x of pick) {
      console.log(`\n=== [${x.p.at.slice(0, 16)} ${x.o}] ${x.p.conv.slice(0, 8)} (${x.t.length}字)`);
      if (PART !== "first") console.log(`--- 1通目（${x.p.firstOrigin}）: ${mask(x.p.first).replace(/\n+/g, " ⏎ ").slice(0, 160)}`);
      console.log(mask(x.t));
      if (x.d) console.log(`--- 直す前（AI）\n${mask(x.d)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
