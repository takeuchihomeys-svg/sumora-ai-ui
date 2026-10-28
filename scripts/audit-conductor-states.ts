// scripts/audit-conductor-states.ts — 振り分けの表の3版: 場面 × 状態の組で竹内さんの一番の動きがそろうか（どの状態が効くか）を数える（読むだけ・LLM なし・作業員5 10/28）
//   場面と一番の動きは scripts/audit-conductor-routing.ts と同じ決め方。状態の候補:
//     段階（初期／提案中／見積済み／内覧予定／内覧後）・送れる物件の候補（売上サポの未送付 7日以内）・開いている約束の種類（確認・ピックアップ・見積で、果たす AIX がまだ）・
//     直前（3日）の物件確認した・こちらの最後の送信からの時間・お客様の気持ち（ブレインの記録の emo）
//   効き目＝その状態を足した時、竹内さんの番が5以上の組のうち一番の動きが6割以上の組に入る竹内さんの番の割合（場面だけの時から何ポイント増えるか）
// 実行: npx tsx --env-file=.env.local scripts/audit-conductor-states.ts [--days=120] --out=<md>
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { buildPromiseQueue, PROMISE_KIND_JA, PROMISE_ORDER } from "../app/lib/promise-queue";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120"));

const SCENES: Array<{ k: string; re: RegExp }> = [
  { k: "申込の意思", re: /申し?込(?:み)?(?:し(?:たい|ます)|お願い|でお願い|させて|進め)|(?:部屋|ここ|こちら)[をはも]?(?:抑え|押さえ|おさえ)|に(?:決め|します)|契約したい/ },
  { k: "審査の相談", re: /審査|保証会社|保証人|ブラック|延滞|滞納|無職|夜職|収入|勤続|転職/ },
  { k: "内覧の段取り", re: /内覧|内見|見学|見に行|見たい|何時|日程|待ち合わせ|現地|案内/ },
  { k: "費用の質問", re: /初期費用|費用|いくら|見積|割引|安く|スモ割|家賃.{0,6}(?:下が|交渉)|仲介手数料|敷金|礼金/ },
  { k: "物件を送ってきた", re: /https?:\/\/|^\s*\[画像\]|【物件の画面|by SUUMO|LIFULL|アットホーム/m },
  { k: "条件の言い直し", re: /(?:エリア|家賃|予算|間取り|駅|徒歩|条件|広さ|築).{0,15}(?:変え|変更|広げ|上げ|下げ|追加|でも大丈夫|でもいい|以内|以上)|やっぱり|条件(?:を|は)/ },
  { k: "出し切り", re: /他に(?:は)?(?:あり|ない|も)|もう少し探|もっと探|別の(?:物件|部屋)|他の(?:物件|部屋)|新しいの/ },
  { k: "保留・検討", re: /検討|考え(?:ます|させ|てみ)|また連絡|一旦|少し待|保留|見送/ },
];
const THANKS_RE = /ありがと|了解|わかりました|分かりました|承知|よろしく|お願いします|はい|スタンプ|助かり|嬉しい/;
const BRAIN_SCENE: Record<string, string> = { ack: "お礼・了承だけ", property_share: "物件を送ってきた", conditions: "条件の言い直し", cost: "費用の質問", viewing: "内覧の段取り", apply: "申込の意思", considering: "保留・検討", question: "一般の質問" };
const WATCH_SCENE: Array<[RegExp, string]> = [
  [/短い了承・お礼/, "お礼・了承だけ"], [/条件提示/, "条件の言い直し"], [/検討中・一時保留/, "保留・検討"], [/断り・キャンセル|意図:negative/, "断り・不満"],
  [/返信:質問|意図:question/, "一般の質問"], [/意図:decision/, "申込の意思"], [/意図:consultation/, "審査の相談"], [/意図:desire/, "ご要望・依頼"],
  [/意図:positive/, "前向きな反応"], [/意図:chat/, "雑談・近況"],
];
const PROMISE: Array<[string, RegExp, RegExp]> = [
  ["見積", /(?:御見積|お見積|見積書)[^。！\n]{0,20}(?:作成|お送り|させて頂きます)/, /estimate_sheet|cost_/],
  ["確認", /(?:確認させて頂きます|確認させていただきます|確認致します|確認いたします)/, /property_check_result|acknowledge_check/],
  ["ピックアップ", /ピックアップ[^。！\n]{0,20}(?:お送り|させて頂きます|させていただきます)|(?:新着|お部屋)[^。！\n]{0,15}出次第[^。！\n]{0,10}お送り/, /property_send|property_recommendation|zenryoku_support/],
];

type Turn = { draft_first: string | null; brain_action: string | null; brain_reply_mode: string | null; decision_id: string | null; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; staff_texts: Array<{ at: string; text: string }> | null; staff_aix: Array<{ at: string; aix_type: string }> | null; scene_key: string | null };
type Msg = { sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
type Row = { scene: string; act: string; tk: boolean; st: Record<string, string>; brainAct: string | null; emoSrc: string; twoChoice: boolean; brainAix: string | null };

(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const turns: Turn[] = [];
  for (let f = 0; ; f += 1000) {
    const r = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, staff_texts, staff_aix, scene_key, brain_action, brain_reply_mode, decision_id, draft_first").gte("customer_turn_at", since).order("id").range(f, f + 999);
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
  const push = <T,>(m: Map<string, T[]>, k: string, v: T) => { const a = m.get(k) ?? []; a.push(v); m.set(k, a); };
  const pickups = new Map<string, Array<{ c: number; s: number | null }>>();
  const brain = new Map<string, Array<{ at: number; k: string | null; emo: string | null; ms: string | null }>>();
  const dsById = new Map<string, string>();
  const tcById = new Map<string, boolean>();
  const aixLog = new Map<string, Array<{ at: number; t: string; cp: string | null; sent: string | null; est: boolean | null; txt: string | null }>>();
  const deals = new Map<string, Array<{ v: number | null; vh: number | null }>>();
  const p = (s: string | null | undefined) => (s ? Date.parse(s) : null);
  for (let i = 0; i < convIds.length; i += 100) {
    const ids = convIds.slice(i, i + 100);
    const [{ data: pk }, { data: bd }, { data: au }, { data: dl }] = await Promise.all([
      sb.from("property_pickups").select("conversation_id, created_at, sent_at").in("conversation_id", ids),
      sb.from("brain_decision_logs").select("id, conversation_id, created_at, scene_key, digest").in("conversation_id", ids).gte("created_at", since),
      sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type, check_pattern, sent_at, estimate_sent, generated_text").in("conversation_id", ids),
      sb.from("deal_outcomes").select("conversation_id, viewing_at, viewing_held_at").in("conversation_id", ids),
    ]);
    for (const r of (pk ?? []) as Array<{ conversation_id: string; created_at: string; sent_at: string | null }>) push(pickups, r.conversation_id, { c: Date.parse(r.created_at), s: p(r.sent_at) });
    for (const r of (bd ?? []) as Array<{ id: string; conversation_id: string; created_at: string; scene_key: string | null; digest: { emo?: string; ms?: string; ds?: string } | null }>) { push(brain, r.conversation_id, { at: Date.parse(r.created_at), k: r.scene_key, emo: r.digest?.emo ?? null, ms: r.digest?.ms ?? null }); dsById.set(r.id, r.digest?.ds ?? ""); tcById.set(r.id, (r.digest as { tc?: unknown } | null)?.tc === true); }
    for (const r of (au ?? []) as Array<{ conversation_id: string; created_at: string; aix_type: string; check_pattern: string | null; sent_at: string | null; estimate_sent: boolean | null; generated_text: string | null }>) push(aixLog, r.conversation_id, { at: Date.parse(r.created_at), t: r.aix_type, cp: r.check_pattern, sent: r.sent_at, est: r.estimate_sent, txt: r.generated_text });
    for (const r of (dl ?? []) as Array<{ conversation_id: string; viewing_at: string | null; viewing_held_at: string | null }>) push(deals, r.conversation_id, { v: p(r.viewing_at), vh: p(r.viewing_held_at) });
  }
  const rows: Row[] = [];
  for (const t of turns) {
    if ((t.scene_key ?? "").startsWith("対象外")) continue;
    const all = msgs.get(t.conversation_id) ?? [];
    const t0 = Date.parse(t.customer_turn_at), t1 = Date.parse(t.customer_last_at ?? t.customer_turn_at);
    const cust = all.filter((m) => m.sender === "customer" && Date.parse(m.created_at) >= t0 - 1000 && Date.parse(m.created_at) <= t1 + 1000).map((m) => m.text ?? "");
    const prevCust = all.filter((m) => m.sender === "customer" && Date.parse(m.created_at) < t0 - 1000);
    const text = cust.join("\n"), own = cust.filter((x) => !/^\s*\[(?:画像|動画|ファイル)/.test(x)).join("\n");
    let scene: string | null = !prevCust.length ? "初回" : null;
    for (const s of SCENES) if (!scene && (s.k === "物件を送ってきた" ? s.re.test(text) : s.re.test(own))) scene = s.k;
    if (!scene && ((own.trim() && own.length <= 40 && THANKS_RE.test(own) && !/[？?]/.test(own)) || (!own.trim() && /\[スタンプ\]/.test(text)))) scene = "お礼・了承だけ";
    const bAt = (brain.get(t.conversation_id) ?? []).filter((x) => x.at >= t0 - 60_000 && x.at <= t1 + 30 * 60_000).sort((a, z) => a.at - z.at)[0];
    if (!scene && bAt?.k && BRAIN_SCENE[bAt.k]) scene = BRAIN_SCENE[bAt.k];
    if (!scene) scene = WATCH_SCENE.find(([re]) => re.test(t.scene_key ?? ""))?.[1] ?? "その他";
    const staffTexts = t.staff_texts ?? [], aix = t.staff_aix ?? [];
    const near = (at: string, aixMsg: boolean) => all.filter((m) => m.sender === "staff" && !!m.is_aix_generated === aixMsg && Math.abs(Date.parse(m.created_at) - Date.parse(at)) < (aixMsg ? 15 * 60_000 : 3000)).map((m) => m.staff_writer);
    const tk = [...staffTexts.flatMap((s) => near(s.at, false)), ...aix.flatMap((a) => near(a.at, true))].includes("takeuchi");
    const st = staffTexts.map((s) => s.text ?? "").join("\n");
    const prom = PROMISE.find(([, re]) => re.test(st));
    const searched = (pickups.get(t.conversation_id) ?? []).some((x) => x.c >= t0 && x.c <= t1 + 24 * 3600_000);
    const act = aix.length ? `AIX:${aix[0].aix_type}` : staffTexts.length ? (prom ? `2段:${prom[0]}` : searched ? "返信＋物件検索" : "返信のみ") : searched ? "物件検索" : "待つ";
    // ─ 状態 ─
    const before = (aixLog.get(t.conversation_id) ?? []).filter((x) => x.at < t0);
    const dl = deals.get(t.conversation_id) ?? [];
    const stage = dl.some((d) => d.vh && d.vh < t0) ? "内覧後" : dl.some((d) => d.v && d.v < t0) || before.some((x) => /meeting_place|viewing_invite/.test(x.t)) ? "内覧予定" : before.some((x) => /estimate_sheet/.test(x.t)) ? "見積済み" : before.some((x) => /property_send|property_recommendation/.test(x.t)) ? "提案中" : "初期";
    const unsent = (pickups.get(t.conversation_id) ?? []).some((x) => x.c <= t0 && x.c >= t0 - 7 * 86400_000 && (x.s === null || x.s > t0)) ? "送れる候補あり" : "候補なし";
    const prevStaff = all.filter((m) => m.sender === "staff" && Date.parse(m.created_at) < t0 && Date.parse(m.created_at) >= t0 - 7 * 86400_000 && !m.is_aix_generated);
    // 行動台帳の約束（promise-queue.buildPromiseQueue＝本番の要対応と同じ組み立て）: その番の時点で開いている約束
    const qMsgs = all.filter((m) => Date.parse(m.created_at) < t0).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated }));
    const qLogs = (aixLog.get(t.conversation_id) ?? []).filter((x) => x.at < t0).map((x) => ({ aixType: x.t, checkPattern: x.cp, sentAt: x.sent ?? new Date(x.at).toISOString(), estimateSent: x.est, text: x.txt }));
    const steps = buildPromiseQueue(qMsgs, qLogs, t0);
    const pend = steps.filter((x) => x.status === "pending");
    const firm = PROMISE_ORDER.filter((k) => pend.some((x) => x.kind === k && !x.watch));
    const ledgerP = firm.length ? `約束:${PROMISE_KIND_JA[firm[0]]}` : pend.some((x) => x.watch) ? "探し続ける約束だけ" : "約束なし";
    let openP = "約束なし";
    for (let i = prevStaff.length - 1; i >= 0; i--) {
      const hit = PROMISE.find(([, re]) => re.test(prevStaff[i].text ?? ""));
      if (!hit) continue;
      const pt = Date.parse(prevStaff[i].created_at);
      const done = before.some((x) => x.at > pt && hit[2].test(x.t));
      openP = done ? "約束なし" : `約束:${hit[0]}`;
      break;
    }
    const checked = before.some((x) => x.at >= t0 - 3 * 86400_000 && /property_check_result/.test(x.t)) ? "直前に確認済み" : "確認なし";
    const lastStaff = all.filter((m) => m.sender === "staff" && Date.parse(m.created_at) < t0).pop();
    const gapH = lastStaff ? (t0 - Date.parse(lastStaff.created_at)) / 3600_000 : null;
    const since = gapH === null ? "送信なし" : gapH < 1 ? "1時間内" : gapH < 24 ? "1日内" : gapH < 168 ? "1週間内" : "1週間超";
    const emoRaw = bAt?.emo ?? "";
    const emo = /刺さ|前向|喜|期待|嬉/.test(emoRaw) ? "前向き" : /迷|不安|心配|検討|慎重/.test(emoRaw) ? "迷い・不安" : /急/.test(emoRaw) ? "急ぎ" : emoRaw ? "その他" : "不明";
    // ブレインの選んだ動き（見張りに残ったその番の判断）: 2段の約束の決まり（ds）は 2段:種類・AIX はその種類・それ以外は返信のみ
    const ds = t.decision_id ? dsById.get(t.decision_id) ?? "" : "";
    const two = /two_stage_promise|promise:|ack_after_promise/.test(ds) ? (/estimate/.test(ds) ? "2段:見積" : /pickup/.test(ds) ? "2段:ピックアップ" : /check|brought/.test(ds) ? "2段:確認" : null) : null;
    // 返信の道で下書きが約束の文（「ピックアップしてお送り」等）なら、竹内さんの側と同じ網で 2段 に数える（初回の下書きは約束を書くのに ds に出ない）
    const draftProm = PROMISE.find(([, re]) => re.test(t.draft_first ?? ""));
    const brainAct = t.brain_reply_mode == null && t.brain_action == null ? null : two ?? (t.brain_reply_mode === "aix" && t.brain_action ? `AIX:${t.brain_action}` : draftProm ? `2段:${draftProm[0]}` : "返信のみ");
    const emoSrc = bAt?.emo ? "emo" : bAt?.ms ? "ms（気持ちの要約）だけ" : bAt ? "判断はあるが気持ち無し" : "その番の判断の記録無し";
    rows.push({ scene, act, tk, brainAct, emoSrc, twoChoice: t.decision_id ? tcById.get(t.decision_id) ?? false : false, brainAix: t.brain_action, st: { 段階: stage, 送れる候補: unsent, 開いている約束: openP, 行動台帳の約束: ledgerP, 直前の確認: checked, 最後の送信から: since, 気持ち: emo } });
  }
  const tkRows = rows.filter((r) => r.tk);
  /** 組の鍵ごとに、竹内さんの番が5以上で一番の動きが6割以上の組に入る番の割合 */
  const coverage = (keyOf: (r: Row) => string) => {
    const g = new Map<string, Record<string, number>>();
    for (const r of tkRows) { const k = keyOf(r); const o = g.get(k) ?? {}; o[r.act] = (o[r.act] ?? 0) + 1; g.set(k, o); }
    let covered = 0, groups = 0;
    const sel: Array<{ k: string; act: string; n: number; share: number }> = [];
    for (const [k, o] of g) {
      const n = Object.values(o).reduce((a, b) => a + b, 0);
      const [act, c] = Object.entries(o).sort((a, b) => b[1] - a[1])[0];
      if (n >= 5 && c / n >= 0.6) { covered += n; groups++; sel.push({ k, act, n, share: c / n }); }
    }
    return { covered, groups, all: tkRows.length, sel };
  };
  /** 当てられる番の割合（その組の多数の動きを当てた時の一致・組が5番未満なら場面だけの多数で当てる・1つ抜き＝自分の番を抜いて多数を決める） */
  const accuracy = (keyOf: (r: Row) => string) => {
    const g = new Map<string, Record<string, number>>(), sg = new Map<string, Record<string, number>>();
    for (const r of tkRows) {
      const k = keyOf(r); const o = g.get(k) ?? {}; o[r.act] = (o[r.act] ?? 0) + 1; g.set(k, o);
      const so = sg.get(r.scene) ?? {}; so[r.act] = (so[r.act] ?? 0) + 1; sg.set(r.scene, so);
    }
    const majOf = (o: Record<string, number>, self: string) => { const c = { ...o }; c[self] = (c[self] ?? 1) - 1; const e = Object.entries(c).sort((a, b) => b[1] - a[1]); return { act: e[0]?.[0], n: Object.values(c).reduce((a, b) => a + b, 0) }; };
    let hit = 0;
    for (const r of tkRows) {
      const m = majOf(g.get(keyOf(r))!, r.act);
      const pick = m.n >= 5 ? m.act : majOf(sg.get(r.scene)!, r.act).act;
      if (pick === r.act) hit++;
    }
    return hit;
  };
  const base = coverage((r) => r.scene);
  const feats = Object.keys(tkRows[0]?.st ?? {});
  const baseAcc = accuracy((r) => r.scene);
  const single = feats.map((f) => ({ f, acc: accuracy((r) => `${r.scene}｜${r.st[f]}`), ...coverage((r) => `${r.scene}｜${r.st[f]}`) })).sort((a, b) => b.acc - a.acc);
  const pairs: Array<{ f: string; covered: number; groups: number; acc: number }> = [];
  for (let i = 0; i < feats.length; i++) for (let j = i + 1; j < feats.length; j++) {
    const kf = (r: Row) => `${r.scene}｜${r.st[feats[i]]}｜${r.st[feats[j]]}`;
    const c = coverage(kf);
    pairs.push({ f: `${feats[i]}＋${feats[j]}`, covered: c.covered, groups: c.groups, acc: accuracy(kf) });
  }
  pairs.sort((a, b) => b.acc - a.acc);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  const L: string[] = [
    `# 振り分けの表 3版: 場面 × 状態（見張りの番 ${DAYS}日・竹内さんの番 ${tkRows.length}・${new Date().toISOString().slice(0, 10)}・作業員5・scripts/audit-conductor-states.ts）`, "",
    "- 物差し①（当てる率）＝その組（5番以上）の竹内さんの多数の動きで、竹内さんの実際の一番の動きを当てた割合（自分の番は抜いて多数を決める・5番未満の組は場面だけの多数で当てる）。",
    "- 物差し②（そろう番）＝竹内さんの番が5以上の組のうち、竹内さんの一番の動きが6割以上にそろう組に入る竹内さんの番の割合（＝その組なら動かす物がほぼ決まる番の割合）。",
    "- 状態: 段階（初期／提案中／見積済み／内覧予定／内覧後）・送れる候補（売上サポの未送付・7日以内）・開いている約束（確認・ピックアップ・見積で、果たす AIX がまだ）・直前の確認（3日以内の物件確認した）・最後の送信から（こちらの最後の通からの時間）・気持ち（その番のブレインの記録の emo）。", "",
    `## 1. 状態ごとの効き目（場面だけ: 当てる率 ${pct(baseAcc, base.all)}・そろう番 ${pct(base.covered, base.all)}・${base.groups}組）`, "",
    "| 順位 | 足す状態 | 当てる率 | 場面だけからの増え | そろう番（6割以上の組） | そろう組 |", "|---|---|---|---|---|---|",
    ...single.map((s, i) => `| ${i + 1} | ${s.f} | ${pct(s.acc, s.all)} | ${s.acc - baseAcc >= 0 ? "+" : ""}${Math.round((100 * (s.acc - baseAcc)) / Math.max(1, base.all))}ポイント | ${pct(s.covered, s.all)}（${s.covered}） | ${s.groups} |`),
    "", "## 2. 状態を2つ足した時（上位8）", "", "| 足す状態 | 当てる率 | そろう番 | そろう組 |", "|---|---|---|---|",
    ...pairs.slice(0, 8).map((s) => `| ${s.f} | ${pct(s.acc, base.all)} | ${pct(s.covered, base.all)}（${s.covered}） | ${s.groups} |`),
    "", `## 3. 一番効く状態（${single[0]?.f}）でそろう組（竹内さんの動きが6割以上）`, "", "| 場面｜状態 | 竹内さんの番 | 一番の動き | 割合 |", "|---|---|---|---|",
    ...(single[0]?.sel ?? []).sort((a, b) => b.n - a.n).map((s) => `| ${s.k} | ${s.n} | ${s.act} | ${pct(s.share * 100, 100)} |`),
    "", `## 4. 2つの組で一番効く組（${pairs[0]?.f}）でそろう組`, "", "| 場面｜状態｜状態 | 竹内さんの番 | 一番の動き | 割合 |", "|---|---|---|---|",
  ];
  if (pairs[0]) {
    const [a, b] = pairs[0].f.split("＋");
    for (const s of coverage((r) => `${r.scene}｜${r.st[a]}｜${r.st[b]}`).sel.sort((x, y) => y.n - x.n)) L.push(`| ${s.k} | ${s.n} | ${s.act} | ${pct(s.share * 100, 100)} |`);
  }
  // 状態の分布（どれくらい埋まっているか）
  L.push("", "## 5. 状態の値の分布（竹内さんの番）", "");
  for (const f of feats) {
    const o: Record<string, number> = {};
    for (const r of tkRows) o[r.st[f]] = (o[r.st[f]] ?? 0) + 1;
    L.push(`- ${f}: ${Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  // ─ 6. ブレインの判断と竹内さんの一番の動きの一致（場面ごと・場面×行動台帳の約束）と表の見込みの比べ ─
  const withBrain = tkRows.filter((r) => r.brainAct);
  const tableHit = (keyOf: (r: Row) => string) => { const g = new Map<string, Record<string, number>>(); for (const r of tkRows) { const k = keyOf(r); const o = g.get(k) ?? {}; o[r.act] = (o[r.act] ?? 0) + 1; g.set(k, o); } return (r: Row) => { const c = { ...g.get(keyOf(r))! }; c[r.act]--; const e = Object.entries(c).sort((a, b) => b[1] - a[1]); return e[0]?.[0] === r.act; }; };
  const thScene = tableHit((r) => r.scene), thProm = tableHit((r) => r.scene + "｜" + r.st["行動台帳の約束"]);
  const cmp = (keyOf: (r: Row) => string, th: (r: Row) => boolean) => {
    const g = new Map<string, { n: number; brain: number; table: number; miss: Record<string, number> }>();
    for (const r of withBrain) { const k = keyOf(r); const o = g.get(k) ?? { n: 0, brain: 0, table: 0, miss: {} }; o.n++; if (r.brainAct === r.act) o.brain++; else { const m = "ブレイン " + r.brainAct + "→竹内さん " + r.act; o.miss[m] = (o.miss[m] ?? 0) + 1; } if (th(r)) o.table++; g.set(k, o); }
    return [...g.entries()].filter(([, o]) => o.n >= 5).sort((a, b) => (a[1].brain - a[1].table) / a[1].n - (b[1].brain - b[1].table) / b[1].n);
  };
  const tot = withBrain.length, bHit = withBrain.filter((r) => r.brainAct === r.act).length, tHit = withBrain.filter(thScene).length;
  const missOf = (o: { miss: Record<string, number> }) => Object.entries(o.miss).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, v]) => m + " " + v).join("・");
  L.push("", "## 6. ブレインの判断 対 表の見込み（竹内さんの番でブレインの判断が見張りに残っている " + tot + "番）", "",
    "- 全体: ブレインの一致 " + pct(bHit, tot) + "／表の見込み（場面の多数・1つ抜き） " + pct(tHit, tot) + "／表（場面×行動台帳の約束） " + pct(withBrain.filter(thProm).length, tot),
    "- 並びは「ブレイン − 表」の小さい順（上ほどブレインが表に負ける＝振り分けを鍛える的）", "",
    "### 場面ごと", "", "| 場面 | 番 | ブレイン | 表の見込み | 差 | ブレインの外れ方（上位） |", "|---|---|---|---|---|---|");
  for (const [k, o] of cmp((r) => r.scene, thScene)) L.push("| " + k + " | " + o.n + " | " + pct(o.brain, o.n) + " | " + pct(o.table, o.n) + " | " + Math.round((100 * (o.brain - o.table)) / o.n) + " | " + missOf(o) + " |");
  L.push("", "### 場面×行動台帳の約束（5番以上）", "", "| 場面｜約束 | 番 | ブレイン | 表の見込み | 差 | ブレインの外れ方（上位） |", "|---|---|---|---|---|---|");
  for (const [k, o] of cmp((r) => r.scene + "｜" + r.st["行動台帳の約束"], thProm)) L.push("| " + k + " | " + o.n + " | " + pct(o.brain, o.n) + " | " + pct(o.table, o.n) + " | " + Math.round((100 * (o.brain - o.table)) / o.n) + " | " + missOf(o) + " |");
  const es: Record<string, number> = {};
  for (const r of tkRows) es[r.emoSrc] = (es[r.emoSrc] ?? 0) + 1;
  L.push("", "## 7. 気持ちの欄の出どころ（竹内さんの番）", "", "- " + Object.entries(es).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v + "（" + pct(v, tkRows.length) + "）").join("・"));
  // ─ 8. 「約束で返すか、その場で果たすか」の番と 2択（feedback_two_choice_aix・digest.tc=true）─
  const KIND: Record<string, RegExp> = { 確認: /property_check_result|acknowledge_check/, 見積: /estimate_sheet|cost_/, ピックアップ: /property_send|property_recommendation|zenryoku_support/ };
  const kindOfAct = (a: string | null) => { if (!a) return null; const m = a.match(/^2段:(.+)$/); if (m) return { kind: m[1], now: false }; const aix = a.replace(/^AIX:/, ""); for (const [k, re] of Object.entries(KIND)) if (a.startsWith("AIX:") && re.test(aix)) return { kind: k, now: true }; return null; };
  const pn = withBrain.filter((r) => { const b = kindOfAct(r.brainAct), c = kindOfAct(r.act); return b && c && b.kind === c.kind && b.now !== c.now; });
  const targetScenes = withBrain.filter((r) => (r.scene === "物件を送ってきた" || r.scene === "費用の質問") && /確認|御見積/.test(r.st["行動台帳の約束"]));
  const tcAll = withBrain.filter((r) => r.twoChoice).length;
  const tcHit = (r: Row) => { const c = kindOfAct(r.act); const b = kindOfAct(r.brainAct); return !!c && !!b && c.kind === b.kind; };
  L.push("", "## 8. 「約束で返すか、その場で AIX で果たすか」と 2択（feedback_two_choice_aix）", "",
    "- 2択＝ブレインが「AIX か返信か」を両方セットした番（brain_decision_logs.digest.tc=true・two_choice_mode）。",
    "- 約束とその場の取り違え＝ブレインと竹内さんが同じ種類（確認・見積・ピックアップ）を選び、片方が約束の返信・片方がその場の AIX の番。", "",
    "| 範囲 | 番 | うち 2択が出ていた | 2択が出ていれば拾えた見込み（同じ種類の約束／AIX の組） |", "|---|---|---|---|",
    "| ブレインの判断のある竹内さんの番 | " + withBrain.length + " | " + tcAll + "（" + pct(tcAll, withBrain.length) + "） | - |",
    "| 約束とその場の取り違え | " + pn.length + " | " + pn.filter((r) => r.twoChoice).length + "（" + pct(pn.filter((r) => r.twoChoice).length, pn.length) + "） | " + pct(pn.filter(tcHit).length, pn.length) + "（種類が同じ＝2択の両方に竹内さんの動きが入る） |",
    "| 物件を送ってきた・費用の質問 × 確認・見積の約束中 | " + targetScenes.length + " | " + targetScenes.filter((r) => r.twoChoice).length + " | ブレインの一致 " + pct(targetScenes.filter((r) => r.brainAct === r.act).length, targetScenes.length) + " → 2択なら " + pct(targetScenes.filter((r) => r.brainAct === r.act || tcHit(r)).length, targetScenes.length) + " |",
    "", "- 2択が出ていた番の竹内さんの一致（どちらかを押した）: " + pct(withBrain.filter((r) => r.twoChoice && (r.brainAct === r.act || tcHit(r))).length, tcAll) + "（" + tcAll + "番）",
    "- 取り違えの内訳: " + Object.entries(pn.reduce((o, r) => { const k = r.brainAct + "→" + r.act; o[k] = (o[k] ?? 0) + 1; return o; }, {} as Record<string, number>)).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v).join("・"));
  writeFileSync(arg("out", "conductor-states.md"), L.join("\n") + "\n");
  console.log(L.slice(0, 30).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
