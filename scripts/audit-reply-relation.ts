// 返信生成が「こちらの発言同士の関係」を守れているか測る（読み取りのみ・LLM は呼ばない・本文はマスクして出す）
// 2026-09-26 竹内「こちらが言ったことの関係性を時刻や返信も踏まえて生成できているか。AIX からテンプレートの場合は挨拶入れない等の関係性も。そして前に送ったところ」
//
// 測ること（generate-reply の下書き × スタッフの実送信・ai_reply_examples entry_source=line_reply・audit-reply-timeline.ts と同じ突き合わせ）:
//   関係: A1 AIX直後への返答(≤60分) / A2 AIXへの返答(1〜24h) / A3a・A3b 手打ちへの返答 / A4 24h 以上空いた後のお客様 /
//         B こちらの連投の途中(直前こちら≤30分) / C こちらの続き / D 沈黙の後の追客 / E 初回 ＋ 前に送った物（14日の物件・見積書）
//   違反（決定論）: V1 当日続きの挨拶 / V2 24h 以内のこちらの約束と同じ種類の約束の言い直し / V3 直前 AIX の物件名 /
//         V4 見積送付済みなのに見積を送る / V5 送っていない物を送った / 見積の約束の混入 / 定型（内覧後のお礼・内覧当日）×直前の AIX
//   OUT=<file> で書き直しを関係ごとに PER 件（既定20）書き出す（目で読む用）。LIST=V2x 等で違反の実物を並べる
//
// 2026-09-26 の結論: 作らない（関係の表を別に渡す案）。実物144件を目で読み、関係が分かっていれば防げた書き直しは単独原因17件・他の原因と重なる13件。
//   母集団に戻すと そのまま送信の天井 ≈ +6.4pt（うち前日の「順序＝約束の言い直し」と重なる分 ≈ +2.8pt・新しい分 ≈ +3.6pt）。
//   関係の材料（こちらの発言・AIX のラベル）は既に履歴に載っており、足す材料ではなく読み方の問題。挨拶（AIX の後の続き）は G31/G32 で直っていた（直近17日で2件）。
//   出口で約束の言い直しを落とすのは不可: 下書きが24h以内の約束と同じ種類を書いた組は そのまま送信 40〜52%（スタッフが残す方が多い＝誤削除が出る）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-reply-relation.ts   （DAYS=60・OUT=・PER=20・ONLY=A1・LIST=V1x）
import { createClient } from "@supabase/supabase-js";
import { textSimilarity } from "../app/lib/knowledge-utils";
import { writeFileSync } from "fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type Msg = { conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; t: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page<T>(table: string, cols: string, since: string, extra?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 200; p++) {
    let q = sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (extra) q = extra(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const jstDate = (t: number) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1");
const GREET = /お世話になっております|お世話になります|はじめまして|初めまして|こんにちは|こんばんは|おはようございます/;
const PROMISE: Array<[string, RegExp]> = [
  ["確認", /確認(?:させて|して|致|いた)[^。！!\n]{0,6}(?:頂|いただ)?き?ます|確認(?:致|いた)します/],
  ["連絡", /(?:ご)?連絡(?:させて)?(?:頂|いただ)きます|ご連絡(?:致|いた)します/],
  ["送る", /お送り(?:させて)?(?:頂|いただ)きます|お送り(?:致|いた)します|送らせて(?:頂|いただ)きます/],
  ["探す", /ピックアップ(?:させて)?(?:頂|いただ)き|お探し(?:させて)?(?:頂|いただ)き|探させて(?:頂|いただ)き/],
  ["見積", /(?:見積|御見積)[^。！!\n]{0,12}(?:作成|お送り|送らせ)/],
];
const promiseKinds = (s: string) => new Set(PROMISE.filter(([, re]) => re.test(s)).map(([k]) => k));
const SENT_PAST = /(?:お送り|送付|送信|添付)(?:させて)?(?:頂|いただ)きました|お送り(?:致|いた)しました|お送りしました/;
const EST_PROMISE = /(?:見積|御見積)[^。！!\n]{0,12}(?:作成|お送り(?:させて)?(?:頂|いただ)きます|送らせて)/;
async function main() {
  const DAYS = Number(process.env.DAYS ?? 60);
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const since2 = new Date(Date.now() - (DAYS + 30) * 86400e3).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ex = await page<any>("ai_reply_examples", "id, conversation_id, sent_reply, ai_draft, was_ai_used, ai_similarity, entry_source, sent_at, created_at", since, (q) => q.not("ai_draft", "is", null));
  const msgs = (await page<Msg>("messages", "conversation_id, sender, text, image_url, created_at, is_aix_generated", since2)).map((m) => ({ ...m, t: Date.parse(m.created_at) }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aix = await page<any>("aix_usage_logs", "conversation_id, aix_type, created_at, sent_at, property_names, estimate_sent", since2);
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  type A = { type: string; t: number; props: string[] };
  const aixBy = new Map<string, A[]>();
  for (const a of aix) {
    if (!aixBy.has(a.conversation_id)) aixBy.set(a.conversation_id, []);
    const props: string[] = Array.isArray(a.property_names) ? a.property_names.map(String) : typeof a.property_names === "string" ? a.property_names.split(/[,、\n]/) : [];
    aixBy.get(a.conversation_id)!.push({ type: a.aix_type ?? "?", t: Date.parse(a.sent_at ?? a.created_at), props: props.map((p) => p.trim()).filter((p) => p.length >= 3) });
  }
  const rows = ex.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim() && r.conversation_id && r.entry_source === "line_reply");
  console.log(`直近${DAYS}日 line_reply 下書き＋実送信 ${rows.length}件`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type F = { r: any; sim: number; used: boolean; rel: string; sub: string; anchor: number; hist: Msg[]; prevAix?: A; minsSinceOurs?: number; propSent14: boolean; estSent14: boolean; v: Set<string>; aixRecent: A[] };
  const feats: F[] = [];
  for (const r of rows) {
    const list = byConv.get(r.conversation_id) ?? [];
    const sentT = Date.parse(r.sent_at ?? r.created_at);
    const head = String(r.sent_reply).replace(/\s+/g, "").slice(0, 12);
    let anchor = sentT;
    const hit = list.find((m) => m.sender !== "customer" && Math.abs(m.t - sentT) < 15 * 60e3 && (m.text ?? "").replace(/\s+/g, "").startsWith(head));
    if (hit) anchor = hit.t;
    const before = list.filter((m) => m.t < anchor - 1000);
    const sim = typeof r.ai_similarity === "number" ? r.ai_similarity : textSimilarity(String(r.ai_draft).trim(), String(r.sent_reply).trim());
    const aixs = (aixBy.get(r.conversation_id) ?? []).filter((a) => a.t < anchor - 1000);
    const aixRecent = aixs.filter((a) => anchor - a.t < 14 * 86400e3);
    const f: F = { r, sim, used: !!r.was_ai_used, rel: "", sub: "", anchor, hist: before.slice(-14), propSent14: aixRecent.some((a) => /property_(recommendation|send)/.test(a.type)), estSent14: aixRecent.some((a) => a.type === "estimate_sheet"), v: new Set(), aixRecent };
    const staffMsgs = before.filter((m) => m.sender !== "customer");
    const lastStaff = staffMsgs[staffMsgs.length - 1];
    f.minsSinceOurs = lastStaff ? (anchor - lastStaff.t) / 60e3 : undefined;
    if (!before.length) { f.rel = "Z 履歴なし"; feats.push(f); continue; }
    const last = before[before.length - 1];
    if (last.sender !== "customer") {
      const aixNear = aixs.filter((a) => a.t >= last.t - 5 * 60e3).pop();
      const mins = (anchor - last.t) / 60e3;
      const lastCust = [...before].reverse().find((m) => m.sender === "customer");
      const custGap = lastCust ? (anchor - lastCust.t) / 60e3 : Infinity;
      if (mins <= 30) { f.rel = "B こちらの連投の途中(直前こちら≤30分)"; f.sub = aixNear || last.is_aix_generated ? `直前=AIX:${aixNear?.type ?? "?"}` : "直前=手打ち"; f.prevAix = aixNear; }
      else if (custGap > 24 * 60) { f.rel = "D 沈黙の後の追客(お客様>24h無言)"; }
      else { f.rel = "C こちらの続き(直前こちら>30分・お客様24h内)"; }
      feats.push(f); continue;
    }
    let i = before.length - 1; while (i >= 0 && before[i].sender === "customer") i--;
    if (i < 0) { f.rel = "E 初回(こちらの発言なし)"; feats.push(f); continue; }
    const burstStart = before[i + 1];
    let j = i; while (j >= 0 && before[j].sender !== "customer") j--;
    const block = before.slice(j + 1, i + 1);
    const ls = block[block.length - 1];
    const gap = (burstStart.t - ls.t) / 60e3;
    const aHit = aixs.filter((a) => a.t >= block[0].t - 3 * 60e3 && a.t <= ls.t + 3 * 60e3).pop();
    const isAix = !!aHit || block.some((m) => m.is_aix_generated);
    f.prevAix = aHit;
    if (gap > 24 * 60) f.rel = "A4 お客様への返答(こちら→お客様 >24h)";
    else if (isAix) f.rel = gap <= 60 ? "A1 AIX直後への返答(≤60分)" : "A2 AIXへの返答(1〜24h)";
    else f.rel = gap <= 60 ? "A3a 手打ちへの返答(≤60分)" : "A3b 手打ちへの返答(1〜24h)";
    f.sub = aHit ? aHit.type : isAix ? "AIX:?" : "";
    feats.push(f);
  }
  for (const f of feats) {
    const d = String(f.r.ai_draft), s = String(f.r.sent_reply);
    const dHead = d.slice(0, 50), sHead = s.slice(0, 50);
    const sameDayOurs = f.hist.some((m) => m.sender !== "customer" && jstDate(m.t) === jstDate(f.anchor) && !/^\s*\[(画像|動画|スタンプ)\]\s*$/.test(m.text ?? "[画像]"));
    const within60 = (f.minsSinceOurs ?? Infinity) <= 60;
    if (GREET.test(dHead) && (sameDayOurs || within60)) { f.v.add("V1 当日続きなのに挨拶(下書き)"); if (!GREET.test(sHead)) f.v.add("V1x 続きの挨拶をスタッフが消した"); }
    if (!GREET.test(dHead) && GREET.test(sHead)) f.v.add(sameDayOurs || within60 ? "V1r 当日続きだがスタッフが挨拶を足した" : "V1n 当日初でスタッフが挨拶を足した");
    if (GREET.test(dHead) && !(sameDayOurs || within60) && !GREET.test(sHead)) f.v.add("V1m 当日初の挨拶をスタッフが消した");
    const ours24 = f.hist.filter((m) => m.sender !== "customer" && f.anchor - m.t < 24 * 3600e3).map((m) => m.text ?? "").join("\n");
    const pk = promiseKinds(ours24), dk = promiseKinds(d), sk = promiseKinds(s);
    for (const k of dk) if (pk.has(k)) { f.v.add(`V2 約束の言い直し(下書き:${k})`); if (!sk.has(k)) f.v.add(`V2x 言い直しをスタッフが消した(${k})`); }
    if (f.prevAix && f.prevAix.props.length) {
      const hitS = f.prevAix.props.some((p) => s.includes(p.slice(0, 5))), hitD = f.prevAix.props.some((p) => d.includes(p.slice(0, 5)));
      if (hitS && !hitD) f.v.add("V3 直前AIXの物件にスタッフだけ触れた");
      if (hitD && !hitS) f.v.add("V3r 直前AIXの物件に下書きだけ触れた");
    }
    if (f.estSent14 && EST_PROMISE.test(d)) { f.v.add("V4 見積送付済みなのに見積を送ると書いた"); if (!EST_PROMISE.test(s)) f.v.add("V4x 見積の言い直しをスタッフが消した"); }
    const sentSomething24 = f.hist.some((m) => m.sender !== "customer" && f.anchor - m.t < 24 * 3600e3 && (m.image_url || /\[画像\]|\[ファイル\]|https?:\/\//.test(m.text ?? "") || m.is_aix_generated)) || f.aixRecent.some((a) => f.anchor - a.t < 24 * 3600e3);
    if (SENT_PAST.test(d) && !sentSomething24) { f.v.add("V5 送っていない物を送ったと書いた"); if (!SENT_PAST.test(s)) f.v.add("V5x 送った言明をスタッフが消した"); }
  }
  const line = (label: string, xs: F[]) => {
    const u = xs.filter((x) => x.used).length; const mean = xs.reduce((a, b) => a + b.sim, 0) / (xs.length || 1);
    return `  ${label.padEnd(40)} ${String(xs.length).padStart(4)}件 そのまま ${pct(u, xs.length).padStart(6)} 似 ${mean.toFixed(3)} 大書直(<0.5) ${pct(xs.filter((x) => x.sim < 0.5).length, xs.length).padStart(6)}`;
  };
  console.log(line("全体", feats));
  const rels = [...new Set(feats.map((f) => f.rel))].sort();
  console.log("\n■ 関係ごと");
  for (const r of rels) console.log(line(r, feats.filter((f) => f.rel === r)));
  console.log("\n■ 直前AIXの種類（A1/A2/B）");
  const subs = new Map<string, F[]>(); for (const f of feats) if (/^A1|^A2|^B/.test(f.rel) && f.sub) { const k = `${f.rel.slice(0, 2)} ${f.sub}`; if (!subs.has(k)) subs.set(k, []); subs.get(k)!.push(f); }
  for (const [k, xs] of [...subs].sort((a, b) => b[1].length - a[1].length).slice(0, 16)) console.log(line(k, xs));
  console.log("\n■ 前に送った物（14日）");
  console.log(line("物件を送った後", feats.filter((f) => f.propSent14)));
  console.log(line("見積書を送った後", feats.filter((f) => f.estSent14)));
  console.log(line("どちらも無し", feats.filter((f) => !f.propSent14 && !f.estSent14)));
  console.log("\n■ 違反（決定論） 全体件数 / 書き直し / 当たった組のそのまま率 [関係]");
  const vs = new Map<string, F[]>(); for (const f of feats) for (const v of f.v) { if (!vs.has(v)) vs.set(v, []); vs.get(v)!.push(f); }
  for (const [k, xs] of [...vs].sort()) {
    const byRel = new Map<string, number>(); for (const x of xs) byRel.set(x.rel.split(" ")[0], (byRel.get(x.rel.split(" ")[0]) ?? 0) + 1);
    console.log(`  ${k.padEnd(34)} ${String(xs.length).padStart(4)}件 書直 ${String(xs.filter((x) => !x.used).length).padStart(3)} そのまま ${pct(xs.filter((x) => x.used).length, xs.length).padStart(6)}  [${[...byRel].map(([a, b]) => `${a}:${b}`).join(" ")}]`);
  }
  if (process.env.LIST) {
    for (const f of feats) {
      if (![...f.v].some((v) => v.startsWith(process.env.LIST!))) continue;
      console.log(`\n-- ${f.rel} ${f.sub} id=${String(f.r.id).slice(0, 8)} sim=${f.sim.toFixed(2)} used=${f.used} at=${String(f.r.sent_at ?? f.r.created_at).slice(0, 10)} ours前=${Math.round(f.minsSinceOurs ?? -1)}分 [${[...f.v].join(",")}]`);
      console.log(`   ▼${mask(String(f.r.ai_draft).replace(/\n+/g, " / ")).slice(0, 160)}`);
      console.log(`   ▲${mask(String(f.r.sent_reply).replace(/\n+/g, " / ")).slice(0, 160)}`);
    }
  }
  const EST_HABIT = /御?見積書?を?作成し?(?:て)?お送り/;
  const ASK_EST = /見積|いくら|初期費用(?!の限度額|ご予算|予算|】)|費用(?:は|を|が|って|教|知|わか|分か)/;
  const habit = feats.filter((f) => EST_HABIT.test(String(f.r.ai_draft)));
  const habitNoAsk = habit.filter((f) => !ASK_EST.test(f.hist.filter((m) => m.sender === "customer").slice(-4).map((m) => m.text ?? "").join(" ")));
  console.log(`\n■ 下書きに「見積書を作成しお送り」 ${habit.length}件（そのまま ${pct(habit.filter((x) => x.used).length, habit.length)}）／直近のお客様4通に見積・費用の語なし ${habitNoAsk.length}件（そのまま ${pct(habitNoAsk.filter((x) => x.used).length, habitNoAsk.length)}・実送信からも消えた ${habitNoAsk.filter((x) => !EST_HABIT.test(String(x.r.sent_reply))).length}）`);
  const byRelH = new Map<string, number>(); for (const x of habitNoAsk) byRelH.set(x.rel.split(" ")[0], (byRelH.get(x.rel.split(" ")[0]) ?? 0) + 1);
  console.log("   日付: " + habitNoAsk.map((x) => String(x.r.sent_at ?? x.r.created_at).slice(5, 10)).sort().join(" "));
  console.log("   " + [...byRelH].map(([a, b]) => `${a}:${b}`).join(" "));
  // 定型（内覧後のお礼・内覧当日の挨拶）と、その直前にこちらが送った物
  const TPL: Array<[string, RegExp]> = [["内覧後のお礼", /本日(?:は)?お時間頂きありがとうございました/], ["内覧当日の挨拶", /本日[^。！!\n]{0,12}お部屋ご案内させて頂きます/]];
  for (const [name, re] of TPL) {
    const xs = feats.filter((f) => re.test(String(f.r.ai_draft).slice(0, 80)));
    const prevKinds = (f: F) => {
      const w = f.aixRecent.filter((a) => f.anchor - a.t < 3 * 3600e3).map((a) => a.type);
      return w.length ? w.join("+") : "なし";
    };
    const g = new Map<string, F[]>(); for (const f of xs) { const k = prevKinds(f).split("+").pop()!; if (!g.has(k)) g.set(k, []); g.get(k)!.push(f); }
    console.log(`\n■ 定型「${name}」の下書き ${xs.length}件 そのまま ${pct(xs.filter((x) => x.used).length, xs.length)}  （直前3時間の最後のAIX別）`);
    for (const [k, ys] of [...g].sort((a, b) => b[1].length - a[1].length)) console.log(line("  " + k, ys));
  }
  const dump: string[] = [];
  const edited = feats.filter((f) => !f.used);
  const PER = Number(process.env.PER ?? 20);
  const ONLY = process.env.ONLY;
  for (const r of rels) {
    if (ONLY && !r.startsWith(ONLY)) continue;
    const xs = edited.filter((f) => f.rel === r);
    const step = Math.max(1, Math.floor(xs.length / PER));
    const pick = xs.filter((_, k) => k % step === Number(process.env.OFF ?? 0) % step).slice(0, PER);
    for (const f of pick) {
      dump.push(`\n######## ${r} ${f.sub} | id=${String(f.r.id).slice(0, 8)} conv=${f.r.conversation_id.slice(0, 8)} sim=${f.sim.toFixed(2)} 違反=[${[...f.v].join(",")}] 物件14d=${f.propSent14} 見積14d=${f.estSent14}`);
      for (const m of f.hist.slice(-8)) {
        const mins = Math.round((f.anchor - m.t) / 60e3);
        const a = (aixBy.get(f.r.conversation_id) ?? []).find((x) => Math.abs(x.t - m.t) < 3 * 60e3 && m.sender !== "customer");
        dump.push(`  [-${mins >= 1440 ? (mins / 1440).toFixed(1) + "日" : mins + "分"}] ${m.sender === "customer" ? "客" : "我"}${m.is_aix_generated || a ? `(AIX${a ? ":" + a.type : ""})` : ""}: ${mask((m.text ?? (m.image_url ? "[画像]" : "")).replace(/\n+/g, " / ")).slice(0, 200)}`);
      }
      dump.push(`  ▼下書き: ${mask(String(f.r.ai_draft).replace(/\n+/g, " / ")).slice(0, 400)}`);
      dump.push(`  ▲実送信: ${mask(String(f.r.sent_reply).replace(/\n+/g, " / ")).slice(0, 400)}`);
    }
  }
  if (process.env.OUT) { writeFileSync(process.env.OUT, dump.join("\n")); console.log(`\nダンプ ${dump.filter((l) => l.startsWith("\n####")).length}件 → OUT`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
