// scripts/audit-conductor-routing.ts — 統括のブレインの振り分けの表の土台（読むだけ・LLM なし・作業員5 10/28）
//   見張りの番（line_watch_turns）ごとに、お客様の発言を場面のパターンに分け、スタッフ（竹内さんを別に）がその番で動かした物
//   （返信・AIX の種類・物件検索・見積・電話・待つ）を数える。深さの目安＝その場面の下書きの外れの割合・自信の低い番・材料が届いていない外れ。
// 2版（10/28）:
//   ① 場面: 語の網で決まらない番は、ブレインの記録の場面の札（brain_decision_logs.scene_key）→ 見張りの返信の場面の札（line_watch_turns.scene_key の「返信:…」）で付け直す
//   ② 竹内さんの番: 手打ちの通に加えて、その番に送った AIX の通（messages.is_aix_generated の staff_writer）でも竹内さんかを決める
//   ③ その後: 成約データ（deal_outcomes）で、その番の後 30日以内に内覧・申込・成約に進んだ割合を、場面×一番の動きで出す
//   ④ 振り分けの試験の正解の候補: brain-exam の問題（scripts/brain-exam/problems.json）を番に結び、場面ごとに竹内さんの一番の動きが6割以上なら「動かす物」の案
// 実行: npx tsx --env-file=.env.local scripts/audit-conductor-routing.ts [--days=60] --out=<md> [--json=<json>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60"));

export const SCENES: Array<{ k: string; re: RegExp }> = [
  { k: "申込の意思", re: /申し?込(?:み)?(?:し(?:たい|ます)|お願い|でお願い|させて|進め)|(?:部屋|ここ|こちら)[をはも]?(?:抑え|押さえ|おさえ)|に(?:決め|します)|契約したい/ },
  { k: "審査の相談", re: /審査|保証会社|保証人|ブラック|延滞|滞納|無職|夜職|収入|勤続|転職/ },
  { k: "内覧の段取り", re: /内覧|内見|見学|見に行|見たい|何時|日程|待ち合わせ|現地|案内/ },
  { k: "費用の質問", re: /初期費用|費用|いくら|見積|割引|安く|スモ割|家賃.{0,6}(?:下が|交渉)|仲介手数料|敷金|礼金/ },
  { k: "物件を送ってきた", re: /https?:\/\/|^\s*\[画像\]|【物件の画面|by SUUMO|LIFULL|アットホーム/m },
  { k: "条件の言い直し", re: /(?:エリア|家賃|予算|間取り|駅|徒歩|条件|広さ|築).{0,15}(?:変え|変更|広げ|上げ|下げ|追加|でも大丈夫|でもいい|以内|以上)|やっぱり|条件(?:を|は)/ },
  { k: "出し切り（他の物件は）", re: /他に(?:は)?(?:あり|ない|も)|もう少し探|もっと探|別の(?:物件|部屋)|他の(?:物件|部屋)|新しいの/ },
  { k: "保留・検討", re: /検討|考え(?:ます|させ|てみ)|また連絡|一旦|少し待|保留|見送/ },
];
const THANKS_RE = /ありがと|了解|わかりました|分かりました|承知|よろしく|お願いします|はい|スタンプ|助かり|嬉しい/;
/** ブレインの記録の場面の札 → 表の場面 */
const BRAIN_SCENE: Record<string, string> = { ack: "お礼・了承だけ", property_share: "物件を送ってきた", conditions: "条件の言い直し", cost: "費用の質問", viewing: "内覧の段取り", apply: "申込の意思", considering: "保留・検討", question: "一般の質問" };
/** 見張りの返信の場面の札 → 表の場面（AIX:… はブレインの選んだ道なので使わない） */
const WATCH_SCENE: Array<[RegExp, string]> = [
  [/短い了承・お礼/, "お礼・了承だけ"], [/条件提示/, "条件の言い直し"], [/検討中・一時保留/, "保留・検討"], [/断り・キャンセル|意図:negative/, "断り・不満"],
  [/返信:質問|意図:question/, "一般の質問"], [/意図:decision/, "申込の意思"], [/意図:consultation/, "審査の相談"], [/意図:desire/, "ご要望・依頼"],
  [/意図:positive/, "前向きな反応"], [/意図:chat/, "雑談・近況"],
];

type Turn = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; staff_texts: Array<{ at: string; text: string }> | null; staff_aix: Array<{ at: string; aix_type: string }> | null; verdict: string | null; verdict_detail: Record<string, unknown> | null; scene_key: string | null };
type Msg = { sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
type Deal = { conversation_id: string; viewing_at: string | null; viewing_held_at: string | null; applied_at: string | null; won_at: string | null };
type Agg = { n: number; tk: number; acts: Record<string, number>; tkActs: Record<string, number>; tkPrimary: Record<string, number>; judged: number; miss: number; uncertain: number; shallow: number; reasons: Record<string, number>; after: Record<string, { n: number; view: number; apply: number; won: number }> };

(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const turns: Turn[] = [];
  for (let f = 0; ; f += 1000) {
    const r = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, staff_texts, staff_aix, verdict, verdict_detail, scene_key").gte("customer_turn_at", since).order("id").range(f, f + 999);
    if (r.error) throw new Error(r.error.message);
    turns.push(...((r.data ?? []) as Turn[]));
    if ((r.data ?? []).length < 1000) break;
  }
  const convIds = [...new Set(turns.map((t) => t.conversation_id))];
  const msgs = new Map<string, Msg[]>();
  for (const c of convIds) {
    const all: Msg[] = [];
    for (let f = 0; ; f += 1000) {
      const { data } = await sb.from("messages").select("sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", c).order("created_at").range(f, f + 999);
      all.push(...((data ?? []) as Msg[]));
      if ((data ?? []).length < 1000) break;
    }
    msgs.set(c, all);
  }
  const pickups = new Map<string, number[]>();
  const brainScenes = new Map<string, Array<{ at: number; k: string }>>();
  const deals = new Map<string, Deal[]>();
  for (let i = 0; i < convIds.length; i += 100) {
    const ids = convIds.slice(i, i + 100);
    const [{ data: pk }, { data: bd }, { data: dl }] = await Promise.all([
      sb.from("property_pickups").select("conversation_id, created_at").in("conversation_id", ids).gte("created_at", since),
      sb.from("brain_decision_logs").select("conversation_id, created_at, scene_key").in("conversation_id", ids).gte("created_at", since).not("scene_key", "is", null),
      sb.from("deal_outcomes").select("conversation_id, viewing_at, viewing_held_at, applied_at, won_at").in("conversation_id", ids),
    ]);
    for (const r of (pk ?? []) as Array<{ conversation_id: string; created_at: string }>) { const a = pickups.get(r.conversation_id) ?? []; a.push(Date.parse(r.created_at)); pickups.set(r.conversation_id, a); }
    for (const r of (bd ?? []) as Array<{ conversation_id: string; created_at: string; scene_key: string }>) { const a = brainScenes.get(r.conversation_id) ?? []; a.push({ at: Date.parse(r.created_at), k: r.scene_key }); brainScenes.set(r.conversation_id, a); }
    for (const r of (dl ?? []) as Deal[]) { const a = deals.get(r.conversation_id) ?? []; a.push(r); deals.set(r.conversation_id, a); }
  }
  const agg = new Map<string, Agg>();
  const get = (k: string): Agg => { let g = agg.get(k); if (!g) { g = { n: 0, tk: 0, acts: {}, tkActs: {}, tkPrimary: {}, judged: 0, miss: 0, uncertain: 0, shallow: 0, reasons: {}, after: {} }; agg.set(k, g); } return g; };
  const sceneSrc: Record<string, number> = {};
  const turnInfo: Array<{ conv: string; t0: number; scene: string; primary: string; tk: boolean }> = [];
  for (const t of turns) {
    if ((t.scene_key ?? "").startsWith("対象外")) continue;
    const all = msgs.get(t.conversation_id) ?? [];
    const t0 = Date.parse(t.customer_turn_at), t1 = Date.parse(t.customer_last_at ?? t.customer_turn_at);
    const cust = all.filter((m) => m.sender === "customer" && Date.parse(m.created_at) >= t0 - 1000 && Date.parse(m.created_at) <= t1 + 1000).map((m) => m.text ?? "");
    const prevCust = all.filter((m) => m.sender === "customer" && Date.parse(m.created_at) < t0 - 1000);
    const text = cust.join("\n");
    const own = cust.filter((x) => !/^\s*\[(?:画像|動画|ファイル)/.test(x)).join("\n");
    const scenes: string[] = [];
    if (!prevCust.length) scenes.push("初回");
    for (const s of SCENES) if (s.k === "物件を送ってきた" ? s.re.test(text) : s.re.test(own)) scenes.push(s.k);
    if (!scenes.length && own.trim() && own.length <= 40 && THANKS_RE.test(own) && !/[？?]/.test(own)) scenes.push("お礼・了承だけ");
    if (!scenes.length && !own.trim() && /\[スタンプ\]/.test(text)) scenes.push("お礼・了承だけ");
    let src = "語の網";
    if (!scenes.length) {
      const b = (brainScenes.get(t.conversation_id) ?? []).filter((x) => x.at >= t0 - 60_000 && x.at <= t1 + 30 * 60_000).sort((a, z) => a.at - z.at)[0];
      if (b && BRAIN_SCENE[b.k]) { scenes.push(BRAIN_SCENE[b.k]); src = "ブレインの札"; }
    }
    if (!scenes.length) {
      const w = WATCH_SCENE.find(([re]) => re.test(t.scene_key ?? ""));
      if (w) { scenes.push(w[1]); src = "見張りの札"; }
    }
    if (!scenes.length) src = "決まらない";
    sceneSrc[src] = (sceneSrc[src] ?? 0) + 1;
    const primary = scenes[0] ?? "その他";
    const gapDays = prevCust.length ? (t0 - Date.parse(prevCust[prevCust.length - 1].created_at)) / 86400_000 : 0;
    const keys = [primary, ...(gapDays >= 7 ? ["久しぶりの連絡（7日以上）"] : []), "（全体）"];
    const staffTexts = t.staff_texts ?? [];
    const aix = t.staff_aix ?? [];
    // ② 竹内さんの番: 手打ちの通・AIX の通の書き手
    const near = (at: string, aixMsg: boolean) => all.filter((m) => m.sender === "staff" && !!m.is_aix_generated === aixMsg && Math.abs(Date.parse(m.created_at) - Date.parse(at)) < (aixMsg ? 15 * 60_000 : 3000)).map((m) => m.staff_writer);
    const writers = [...staffTexts.flatMap((s) => near(s.at, false)), ...aix.flatMap((a) => near(a.at, true))];
    const isTk = writers.includes("takeuchi");
    const acts: string[] = [];
    if (staffTexts.length) acts.push("返信（手打ち）");
    for (const a of aix) acts.push(`AIX:${a.aix_type}`);
    if (aix.some((a) => /estimate|cost_/.test(a.aix_type))) acts.push("〔見積〕");
    if (aix.some((a) => /phone/.test(a.aix_type)) || staffTexts.some((s) => /お電話(?:させて|致し|いたし|頂け|いただけ)/.test(s.text ?? ""))) acts.push("〔電話〕");
    const searched = (pickups.get(t.conversation_id) ?? []).some((x) => x >= t0 && x <= t1 + 24 * 3600_000);
    if (searched) acts.push("〔物件検索〕");
    if (!staffTexts.length && !aix.length) acts.push("〔待つ（動きなし）〕");
    // 一番の動き（1番に1つ）: AIX があれば最初の AIX の種類・無ければ返信のみ／物件検索だけ／待つ
    // 返信の文が約束（2段＝後で AIX で果たす）か: brain-exam の正解の札（2段:check／2段:pickup／2段:estimate）と同じ分け方
    const st = staffTexts.map((s) => s.text ?? "").join("\n");
    const promise = /(?:御見積|お見積|見積書)[^。！\n]{0,20}(?:作成|お送り|させて頂きます)/.test(st) ? "2段:estimate"
      : /(?:確認させて頂きます|確認させていただきます|確認致します|確認いたします)/.test(st) ? "2段:check"
      : /ピックアップ[^。！\n]{0,20}(?:お送り|させて頂きます|させていただきます)|(?:新着|お部屋)[^。！\n]{0,15}出次第[^。！\n]{0,10}お送り/.test(st) ? "2段:pickup" : null;
    const primaryAct = aix.length ? `AIX:${aix[0].aix_type}` : staffTexts.length ? (promise ?? (searched ? "返信＋物件検索" : "返信のみ")) : searched ? "物件検索" : "待つ";
    turnInfo.push({ conv: t.conversation_id, t0, scene: primary, primary: primaryAct, tk: isTk });
    // ③ その後 30日以内に進んだか
    const dl = deals.get(t.conversation_id) ?? [];
    const within = (v: string | null | undefined) => !!v && Date.parse(v) > t0 && Date.parse(v) <= t0 + 30 * 86400_000;
    const view = dl.some((d) => within(d.viewing_held_at) || within(d.viewing_at)), apply = dl.some((d) => within(d.applied_at)), won = dl.some((d) => within(d.won_at));
    const vd = (t.verdict_detail ?? {}) as { reason?: string; uncertain?: boolean };
    for (const k of keys) {
      const g = get(k);
      g.n++;
      if (isTk) { g.tk++; g.tkPrimary[primaryAct] = (g.tkPrimary[primaryAct] ?? 0) + 1; }
      for (const a of new Set(acts)) { g.acts[a] = (g.acts[a] ?? 0) + 1; if (isTk) g.tkActs[a] = (g.tkActs[a] ?? 0) + 1; }
      const af = (g.after[primaryAct] ??= { n: 0, view: 0, apply: 0, won: 0 });
      af.n++; if (view) af.view++; if (apply) af.apply++; if (won) af.won++;
      if (t.verdict && t.verdict !== "na") {
        g.judged++;
        if (t.verdict === "different" || t.verdict === "partial") {
          g.miss++;
          const r = vd.reason ?? "?";
          g.reasons[r] = (g.reasons[r] ?? 0) + 1;
          if (/missing|one_side|staff_fact|ask/.test(r)) g.shallow++;
        }
        if (vd.uncertain) g.uncertain++;
      }
    }
  }
  const order = ["（全体）", "初回", "物件を送ってきた", "お礼・了承だけ", "費用の質問", "内覧の段取り", "申込の意思", "審査の相談", "出し切り（他の物件は）", "保留・検討", "条件の言い直し", "一般の質問", "ご要望・依頼", "前向きな反応", "雑談・近況", "断り・不満", "久しぶりの連絡（7日以上）", "その他"];
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  const top = (o: Record<string, number>, n: number, base: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${pct(v, base)}`).join("・");
  const L: string[] = [
    `# 振り分けの表の土台 2版（見張りの番 ${DAYS}日・${new Date().toISOString().slice(0, 10)}・作業員5・scripts/audit-conductor-routing.ts）`, "",
    `- 場面の付け方: 語の網 → 決まらない番はブレインの記録の場面の札 → 見張りの返信の場面の札。内訳: ${Object.entries(sceneSrc).map(([k, v]) => `${k} ${v}`).join("・")}`,
    "- 場面の優先（語の網）: 初回→申込→審査→内覧→費用→物件送付→条件→出し切り→保留→お礼。久しぶり＝前のお客様の通から7日以上（重ねて数える）。申込以降の番は除く。",
    "- 竹内さんの番＝その番の手打ちの通か、その番に送った AIX の通（±15分）に竹内さん（書き手A）の通がある番。",
    "- 一番の動き＝AIX があれば最初の AIX の種類／無ければ「返信のみ」「返信＋物件検索」「物件検索」「待つ」。",
    "- 深さの目安＝下書きの外れ（partial/different）の割合・自信の低い番（uncertain）・材料が届いていない形の外れ（acts_missing・fact_one_side・text_but_staff_fact・ask）。", "",
    "## 1. 場面ごとの動きと深さ", "",
    "| 場面 | 番 | 竹内さんの番 | 竹内さんの一番の動き（上位・6割以上は★） | スタッフ全体の動き（上位） | 外れ | 自信が低い | 外れのうち浅すぎの形 | 外れの理由（上位） |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const cands: Record<string, string> = {};
  for (const k of order) {
    const g = agg.get(k);
    if (!g) continue;
    const tp = Object.entries(g.tkPrimary).sort((a, b) => b[1] - a[1]);
    const lead = tp[0] && g.tk >= 5 && tp[0][1] / g.tk >= 0.6 ? `★${tp[0][0]}` : "";
    if (lead) cands[k] = tp[0][0];
    L.push(`| ${k} | ${g.n} | ${g.tk} | ${lead ? `${lead}・` : ""}${top(g.tkPrimary, 4, g.tk)} | ${top(g.acts, 5, g.n)} | ${pct(g.miss, g.judged)}（${g.miss}/${g.judged}） | ${pct(g.uncertain, g.judged)} | ${pct(g.shallow, g.miss)} | ${top(g.reasons, 3, g.miss)} |`);
  }
  L.push("", "## 2. その後 30日以内に進んだ割合（成約データ deal_outcomes・場面×一番の動き・番が10以上の組だけ）", "", "| 場面 | 一番の動き | 番 | 内覧 | 申込 | 成約 |", "|---|---|---|---|---|---|");
  for (const k of order) {
    const g = agg.get(k);
    if (!g || k === "（全体）") continue;
    for (const [a, v] of Object.entries(g.after).sort((x, y) => y[1].n - x[1].n)) if (v.n >= 10) L.push(`| ${k} | ${a} | ${v.n} | ${pct(v.view, v.n)} | ${pct(v.apply, v.n)} | ${pct(v.won, v.n)} |`);
  }
  // ④ brain-exam の問題に「動かす物」の案
  L.push("", "## 3. 振り分けの試験の正解の案（brain-exam の問題 × 場面の竹内さんの多数の動き）", "",
    "- 問題を見張りの番に結び（同じ会話・問題の時刻の ±10分にお客様の番が始まる）、その番の場面に竹内さんの一番の動きが6割以上（竹内さんの番5以上）ならその動きを「動かす物」の案にする。問題の正解（accept）と並べ、食い違う物は目で読む候補。", "",
    "| 問題 | 種類 | 場面 | 動かす物の案（場面の竹内さんの多数） | 問題の正解（accept） | その番の実際の一番の動き | 竹内さんの番か |", "|---|---|---|---|---|---|---|");
  try {
    const P = JSON.parse(readFileSync("scripts/brain-exam/problems.json", "utf8")) as Array<{ id: string; type: string; conv: string; at: string; accept: string[] }> | { problems: Array<{ id: string; type: string; conv: string; at: string; accept: string[] }> };
    const probs = Array.isArray(P) ? P : P.problems;
    let linked = 0;
    for (const p of probs) {
      const at = Date.parse(p.at);
      const ti = turnInfo.filter((x) => x.conv === p.conv && Math.abs(x.t0 - at) <= 10 * 60_000).sort((a, z) => Math.abs(a.t0 - at) - Math.abs(z.t0 - at))[0];
      if (!ti) continue;
      linked++;
      L.push(`| ${p.id} | ${p.type} | ${ti.scene} | ${cands[ti.scene] ?? "（多数なし）"} | ${(p.accept ?? []).join("／")} | ${ti.primary} | ${ti.tk ? "○" : ""} |`);
    }
    L.push("", `結べた問題 ${linked}/${probs.length}（結べない問題は見張りの記録の外＝${DAYS}日より前か見張りが無い番）`);
  } catch (e) { L.push(`（問題が読めない: ${e instanceof Error ? e.message : String(e)}）`); }
  writeFileSync(arg("out", "conductor-routing.md"), L.join("\n") + "\n");
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify({ agg: Object.fromEntries(agg), sceneSrc, cands }, null, 1));
  console.log(L.slice(0, 40).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
