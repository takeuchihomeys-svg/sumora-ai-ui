// scripts/learn-aix-meanings.ts — AIX のボタン×ピッカーの意味を DB から学んで app/lib/aix-catalog-learned.ts を作り直す（DB は読むだけ・LLM なし・LINE に送らない）
//
// 2026-10-22 竹内さん「データベース見たらボタン毎の意味やピッカー毎の意味が分かるから、その意味を理解すればもっと判断の質上がる」
//   同日の訂正: 従業員は正しいボタン・ピッカーを押していない事が多い → 基準は 竹内基準（竹内さんの送信と決定）。
//   ・意味（目的・中身・型・次の一手・お手本）は 定義（カタログ・aix-pickers の when）＋竹内さんの決定（設計知見）＋竹内さんの AIX の送信（messages.staff_writer='takeuchi'）だけから。
//   ・従業員の送信は押し間違いを見つける側だけ（app/lib/aix-meaning-learn.misPressOf）。手打ちで AIX の結果を送った文も数える（H3）。
//   ・竹内さんのお手本が 3 未満のピッカーは needsOwnerGold（作らない・竹内さんに聞く）。
//   ・試験の候補: 似た組（SIMILAR_GROUPS）で 竹内さんが押した番 → 正解＝竹内さんの押下（add-batch の候補・人が読んで足す）。
//                 従業員が押した番 → 正解は決めない（owner_questions の kind=gold の候補・竹内さんが決める）。
//
// 実行: npx tsx --env-file=.env.local scripts/learn-aix-meanings.ts [--max-exam=25] [--max-gold=30] [--apply-questions]
//   出力: app/lib/aix-catalog-learned.ts（伏せたお手本だけ）／<倉庫の根>/.claude/exam-cache/aix-meanings/<日付>.md・.json（押し間違いの例・候補）
//   --apply-questions を付けた時だけ owner_questions に足す（dedupe_key で二重にしない）。既定は書かない。
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIX_CATALOG, catalogKeyOfPress, topicKey } from "../app/lib/aix-catalog";
import { AIX_PICKERS } from "../app/lib/aix-pickers";
import { AIX_BUTTON_LABELS } from "../app/lib/aix-taxonomy";
import {
  contentTopicsOf, structureOf, customerIntentOf, misPressOf, handTypedAixTopic, maskExemplar, topShares, groupsOfKey,
  TOPIC_JA, type LearnedMeaning,
} from "../app/lib/aix-meaning-learn";
import { isTestConversation } from "../app/lib/test-conversations";
import { isApplicationStatusQuestion } from "../app/lib/aix-new-pickers";
import { applicationMaterialReason, piiValueSignal } from "../app/lib/test-pii-guard";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";
import { piiGate, dedupeCandidates } from "./lib/exam-question-candidates";
import { examCacheRoot } from "./lib/llm-cassette";
import { SPEC_FILE } from "./lib/exam-brain-io";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const MAX_EXAM = Number(arg("max-exam", "25")) || 25;
const MAX_GOLD = Number(arg("max-gold", "30")) || 30;
const APPLY = process.argv.includes("--apply-questions");
const OWNER_MIN = 3;
const P = (s: string) => Date.parse(s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const gate = { piiValueSignal, applicationMaterialReason };

type Usage = { id: string; conversation_id: string; aix_type: string | null; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: unknown; generated_text: string | null; line_message_id: string | null; created_at: string; sent_at: string | null };
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; line_message_id: string | null; is_aix_generated: boolean | null; staff_writer: string | null; staff_writer_confidence: string | null };

async function pageAll<T>(table: string, cols: string, apply: (q: any) => any, order = "created_at"): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(sb.from(table).select(cols)).order(order, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const writerOf = (m: Msg | undefined) => (m?.staff_writer && m.staff_writer_confidence === "sure" ? m.staff_writer : m?.staff_writer ? `${m.staff_writer}?` : "unknown");

(async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が要ります（読むだけ）");
  // ── 読む ──
  const usages = (await pageAll<Usage>("aix_usage_logs", "id, conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, generated_text, line_message_id, created_at, sent_at", (q) => q))
    .filter((u) => !isTestConversation(u.conversation_id));
  const since = usages.reduce((m, u) => (u.created_at < m ? u.created_at : m), new Date().toISOString());
  const msgs = (await pageAll<Msg>("messages", "conversation_id, sender, text, created_at, line_message_id, is_aix_generated, staff_writer, staff_writer_confidence", (q) => q.gte("created_at", new Date(P(since) - 7 * 86_400_000).toISOString())))
    .filter((m) => !isTestConversation(m.conversation_id));
  const { data: convRows } = await sb.from("conversations").select("id, customer_name, call_name");
  const convs = (convRows ?? []) as Array<{ id: string; customer_name: string | null; call_name: string | null }>;
  const custName = new Map(convs.map((c) => [c.id, c.customer_name ?? c.call_name ?? null]));
  const callName = new Map(convs.map((c) => [c.id, c.call_name ?? null]));
  const { data: kbRows } = await sb.from("system_design_thinking").select("id, title, tags, priority, is_current").eq("is_current", true);
  const kb = ((kbRows ?? []) as Array<{ id: string; title: string; tags: string[] | null; priority: number | null }>)
    .filter((r) => (r.priority ?? 9) <= 1 && /【決定】|【お手本】|竹内/.test(r.title + (r.tags ?? []).join(" ")));

  const byLm = new Map<string, Msg>();
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (m.line_message_id) byLm.set(m.line_message_id, m); if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  // 会話ごとの伏せる名前（お客様の名前・呼び名・こちらの文で呼んでいる名前の全部）
  const namesCache = new Map<string, string[]>();
  const namesOf = (conv: string) => {
    if (!namesCache.has(conv)) {
      const staffTexts = (byConv.get(conv) ?? []).filter((x) => x.sender !== "customer").map((x) => x.text ?? "");
      namesCache.set(conv, [...new Set([...addressNamesOf(staffTexts), callName.get(conv) ?? ""].filter((x) => x && x.length >= 1))]);
    }
    return namesCache.get(conv)!;
  };
  const maskFor = (conv: string, text: string) => maskExemplar(maskExamText(text, custName.get(conv) ?? null, namesOf(conv)));
  const usagesByConv = new Map<string, Usage[]>();
  for (const u of usages) { if (!usagesByConv.has(u.conversation_id)) usagesByConv.set(u.conversation_id, []); usagesByConv.get(u.conversation_id)!.push(u); }

  // ── 1. 一覧の抜け（コードの全ボタン・全ピッカー vs カタログの知識） ──
  const catKeys = new Set(AIX_CATALOG.map((e) => e.key));
  const catButtons = new Set(AIX_CATALOG.map((e) => e.aixType));
  const gaps: string[] = [];
  for (const t of new Set([...Object.keys(AIX_PICKERS), ...Object.keys(AIX_BUTTON_LABELS)])) if (!catButtons.has(t)) gaps.push(`ボタン ${t}（${AIX_PICKERS[t]?.button ?? AIX_BUTTON_LABELS[t]}）がカタログに無い`);
  // 竹内さんの決定で作ると決まったがコードにまだ無いピッカー（設計知見を見て確かめた物）
  const decidedNotInCode: Array<{ label: string; kb: string; re: RegExp }> = [
    { label: "入居者の条件（お子様・年齢）", kb: "2d860ddb", re: /入居者の条件/ },
    { label: "審査について→審査の結果", kb: "2d860ddb", re: /審査の結果/ },
  ];
  const pickerSrc = readFileSync("app/lib/aix-pickers.ts", "utf8") + readFileSync("app/lib/aix-owner-answers-1021.ts", "utf8");
  for (const d of decidedNotInCode) if (!d.re.test(pickerSrc)) gaps.push(`ピッカー「${d.label}」: 竹内さんの決定（${d.kb}）で作ると決まったが画面のコードに無い`);
  // カタログにあるがピッカーごとの知識（PICKER_KNOW）が無く、ボタンの説明で代用している物
  // 送る情報（staffOnly）がボタンの説明のまま（そのボタンの行で一番多い staffOnly）で、使う時も画面の説明のまま＝ピッカーごとの知識が無い
  const btnStaffOnly = (t: string) => { const c: Record<string, number> = {}; for (const e of AIX_CATALOG.filter((x) => x.aixType === t)) c[e.staffOnly] = (c[e.staffOnly] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""; };
  const genericKnow = AIX_CATALOG.filter((e) => e.picker && e.brainSelectable && e.staffOnly === btnStaffOnly(e.aixType) && e.when === (AIX_PICKERS[e.aixType]?.pickers.flatMap((p) => p.options ?? []).find((o) => o.value === e.picker!.value)?.when || "\u0000"));
  for (const e of genericKnow) gaps.push(`ピッカー ${e.key}（${e.picker!.label}）: カタログに専用の知識が無い（画面の説明だけ）`);
  // 審査について の話題（SCREENING_TOPIC_OPTIONS）はカタログの鍵が mgmt_screening 1つ
  gaps.push("審査について の中の話題（職業・名義・保証人・外国籍・時期・その他）はカタログでは mgmt_screening の1行（話題の線は無い）");
  // 子のピッカー（主のピッカー以外）
  gaps.push("子のピッカー（駐車場の中のバイク置き場 parking_kind・室内写真の現地撮影・物件オススメの理由 等）はカタログの行にならない（主のピッカーの説明の中だけ）");

  // ── 2. 押下ごとに学ぶ ──
  type Row = { u: Usage; key: string; keySource: string; text: string; writer: string; before: string; beforeAt: string | null; prevStaff: string; nextCust: string; nextAix: string | null; mis: ReturnType<typeof misPressOf> };
  const rows: Row[] = [];
  for (const u of usages) {
    const m = u.line_message_id ? byLm.get(u.line_message_id) : undefined;
    // 物件の束は1通目（紹介文）と物件ごとの通に分かれる＝押した記録の文（generated_text）を先に。無い時は送った通
    const text = (u.generated_text ?? m?.text ?? "").trim();
    const pk = catalogKeyOfPress({ aix_type: u.aix_type, check_pattern: u.check_pattern, send_mode: u.send_mode, app_sub_mode: u.app_sub_mode, picker_choices: u.picker_choices, text });
    const at = m?.created_at ?? u.sent_at ?? u.created_at;
    const conv = byConv.get(u.conversation_id) ?? [];
    const prior = conv.filter((x) => P(x.created_at) < P(at) - 1000);
    const lastCustIdx = prior.map((x) => x.sender).lastIndexOf("customer");
    let before = "", beforeAt: string | null = null;
    if (lastCustIdx >= 0 && P(at) - P(prior[lastCustIdx].created_at) < 3 * 86_400_000) {
      let i = lastCustIdx; const parts: string[] = [];
      while (i >= 0 && prior[i].sender === "customer") { parts.unshift(prior[i].text ?? ""); i--; }
      before = parts.join("\n"); beforeAt = prior[lastCustIdx].created_at;
    }
    const prevStaff = [...prior].reverse().find((x) => x.sender !== "customer" && P(x.created_at) < P(beforeAt ?? at))?.text ?? "";
    const nextC = conv.find((x) => x.sender === "customer" && P(x.created_at) > P(at) && P(x.created_at) - P(at) < 2 * 86_400_000);
    const nextU = (usagesByConv.get(u.conversation_id) ?? []).find((x) => P(x.created_at) > P(u.created_at) + 60_000 && P(x.created_at) - P(u.created_at) < 7 * 86_400_000 && x.aix_type !== u.aix_type);
    rows.push({ u, key: pk.key, keySource: pk.source, text, writer: writerOf(m), before, beforeAt, prevStaff, nextCust: nextC?.text ?? "", nextAix: nextU?.aix_type ?? null, mis: misPressOf(pk.key, text) });
  }

  // ── 3. 学んだ意味（竹内さんの送信だけ） ──
  const keysAll = [...new Set([...AIX_CATALOG.map((e) => e.key), ...AIX_CATALOG.map((e) => e.aixType)])];
  const learned: Record<string, LearnedMeaning> = {};
  // ピッカーの意味は「押した記録にピッカーがある」押下だけ（古い押下の文からの推定は、物件オススメの既定＝新規ピックアップのように当てにならない）。ボタンの意味は全部
  const rowsOf = (k: string) => rows.filter((r) => (k.includes("/") ? r.key === k && r.keySource === "recorded" : r.key.split("/")[0] === k));
  for (const k of keysAll) {
    const entry = AIX_CATALOG.find((e) => e.key === k) ?? AIX_CATALOG.find((e) => e.aixType === k);
    if (!entry) continue;
    const all = rowsOf(k);
    const ownerAll = all.filter((r) => r.writer === "takeuchi");
    const owner = ownerAll.filter((r) => !r.mis);
    const topicC: Record<string, number> = {}, beforeC: Record<string, number> = {}, nextC: Record<string, number> = {};
    const st = { uke: 0, amount: 0, promise: 0, appeal: 0, close: 0 };
    for (const r of owner) {
      for (const tp of contentTopicsOf(r.text)) topicC[TOPIC_JA[tp]] = (topicC[TOPIC_JA[tp]] ?? 0) + 1;
      const s = structureOf(r.text); for (const f of Object.keys(st) as Array<keyof typeof st>) if (s[f]) st[f]++;
      const bi = customerIntentOf(r.before); beforeC[bi] = (beforeC[bi] ?? 0) + 1;
      const n = r.nextAix ? `AIX ${AIX_PICKERS[r.nextAix]?.button ?? AIX_BUTTON_LABELS[r.nextAix] ?? r.nextAix}` : r.nextCust ? `お客様: ${customerIntentOf(r.nextCust)}` : "返事なし（2日）";
      nextC[n] = (nextC[n] ?? 0) + 1;
    }
    const enough = owner.length >= OWNER_MIN;
    // お手本: 竹内さんの送信・押し間違いでない・伏せて個人の値が残らない・中身の長さが中くらい・新しい順に3
    const exemplars: string[] = [];
    if (enough) {
      for (const r of [...owner].sort((a, b) => P(b.u.created_at) - P(a.u.created_at))) {
        if (exemplars.length >= 3) break;
        const raw = r.text; if (raw.length < 40 || raw.length > 600) continue;
        if (applicationMaterialReason(raw)) continue;
        const masked = maskFor(r.u.conversation_id, raw);
        if (piiGate([masked], gate)) continue;
        const short = masked.length > 260 ? `${masked.slice(0, 260)}…` : masked;
        if (exemplars.some((e) => e.slice(0, 40) === short.slice(0, 40))) continue;
        exemplars.push(short);
      }
    }
    const pickerLabel = entry.picker && entry.key === k ? entry.picker.label : null;
    const kbIds = kb.filter((r) => (pickerLabel && r.title.includes(pickerLabel)) || (!pickerLabel && r.title.includes(`【${entry.button}】`))).slice(0, 3).map((r) => r.id.slice(0, 8));
    const pct = (n: number) => (owner.length ? Math.round((n / owner.length) * 100) : 0);
    learned[k] = {
      key: k,
      purpose: [entry.staffOnly ? `送る情報: ${entry.staffOnly}` : "送る情報: 定型の文・フォーム", `使う時: ${entry.key === k ? entry.when : (AIX_CATALOG.find((e) => e.aixType === k && !e.picker)?.when ?? entry.when)}`].join("／"),
      writeContains: enough ? topShares(topicC, owner.length, { min: 0.4, n: 4 }) : [],
      structure: enough ? { uke: pct(st.uke), amount: pct(st.amount), promise: pct(st.promise), appeal: pct(st.appeal), close: pct(st.close) } : null,
      nextStep: enough ? topShares(nextC, owner.length, { min: 0.2, n: 3 }) : [],
      before: enough ? topShares(beforeC, owner.length, { min: 0.2, n: 3 }) : [],
      exemplars,
      counts: { owner: owner.length, all: all.length, misPressStaff: all.filter((r) => r.writer !== "takeuchi" && r.mis).length, misPressOwner: ownerAll.length - owner.length },
      needsOwnerGold: entry.brainSelectable && !enough,
      kb: kbIds,
    };
  }

  // ── 4. 押し間違い（従業員）と手打ちの AIX ──
  const misByBtn: Record<string, { n: number; staff: number; owner: number; reasons: Record<string, number>; ex: string[] }> = {};
  for (const r of rows) {
    if (!r.mis) continue;
    const b = r.key;
    const o = (misByBtn[b] ??= { n: 0, staff: 0, owner: 0, reasons: {}, ex: [] });
    o.n++; if (r.writer === "takeuchi") o.owner++; else o.staff++;
    const why = `${r.mis.reason}${r.mis.suggest ? ` → ${r.mis.suggest}` : ""}`;
    o.reasons[why] = (o.reasons[why] ?? 0) + 1;
    if (o.ex.length < 2 && r.writer !== "takeuchi") {
      const masked = maskFor(r.u.conversation_id, r.text);
      if (!piiGate([masked], gate) && !applicationMaterialReason(r.text)) o.ex.push(oneLine(masked).slice(0, 140));
    }
  }
  const pressedLms = new Set(usages.map((u) => u.line_message_id).filter(Boolean) as string[]);
  const hand: Record<string, { takeuchi: number; employee: number; unknown: number; ex: string[] }> = {};
  for (const m of msgs) {
    if (m.sender === "customer" || m.is_aix_generated || (m.line_message_id && pressedLms.has(m.line_message_id))) continue;
    const k = handTypedAixTopic(m.text); if (!k) continue;
    const w = m.staff_writer === "takeuchi" ? "takeuchi" : m.staff_writer === "employee" ? "employee" : "unknown";
    const o = (hand[k] ??= { takeuchi: 0, employee: 0, unknown: 0, ex: [] }); o[w]++;
    if (o.ex.length < 2 && !applicationMaterialReason(m.text)) { const masked = maskFor(m.conversation_id, m.text ?? ""); if (!piiGate([masked], gate)) o.ex.push(oneLine(masked).slice(0, 140)); }
  }

  // ── 5. 試験の候補（竹内さんの押下＝正解）と 竹内さんに正解を聞く番（従業員の押下・お手本の足りないピッカー） ──
  const spec = (existsSync(SPEC_FILE) ? JSON.parse(readFileSync(SPEC_FILE, "utf8")) : []) as Array<{ conv?: string; at?: string }>;
  const examRaw: Array<{ c: Parameters<typeof dedupeCandidates>[0][number]; group: string }> = [];
  const goldTurn: Array<{ dedupe: string; question: string; options: string[]; recommended: string | null; why: string; ref: string }> = [];
  let examSkipped: Record<string, number> = {};
  const sk = (k: string) => { examSkipped[k] = (examSkipped[k] ?? 0) + 1; };
  const examKey = (k: string) => (/^property_(?:send|recommendation)/.test(k) ? k.split("/")[0] : k.startsWith("property_check_result") ? k : k.split("/")[0]);
  for (const r of rows) {
    const gs = groupsOfKey(r.key);
    if (!gs.length) continue;
    if (!r.before.trim()) { sk("お客様の直前の発言なし（こちらから出した番）"); continue; }
    if (r.beforeAt && P(r.u.created_at) - P(r.beforeAt) > 3 * 3600_000) { sk("お客様の発言から3時間超（こちらから出した番）"); continue; }
    if (["お礼・了承", "なし"].includes(customerIntentOf(r.before)) || /^(?:\[スタンプ\]\s*)+$/.test(r.before.trim())) { sk("お礼・了承・スタンプだけ（発言への答えでない）"); continue; }
    const customer = oneLine(maskFor(r.u.conversation_id, r.before)).slice(0, 200);
    if (isApplicationStatusQuestion(r.before)) { sk("後の竹内さんの決定で正解が変わった型（申込状況 10/20）"); continue; }
    const staffPrev = oneLine(maskFor(r.u.conversation_id, r.prevStaff)).slice(0, 200);
    const g = piiGate([r.before, r.prevStaff], { piiValueSignal: () => null, applicationMaterialReason }) ?? piiGate([customer, staffPrev], gate);
    if (g) { sk(`個人情報の網`); continue; }
    const mine = examKey(r.key);
    const sib = [...new Set(gs.flatMap((x) => x.keys).map(examKey))].filter((k) => k !== mine && topicKey(k) !== topicKey(mine));
    if (!sib.length) { sk("組の中で試験の区別がつかない（同じ話題）"); continue; }
    if (r.writer === "takeuchi" && !r.mis) {
      examRaw.push({ group: gs.map((x) => x.name).join("・"), c: { source: "見張り", conv: r.u.conversation_id, at: r.beforeAt ?? r.u.created_at, type: "AIXのピッカー選び", tags: ["ピッカー選び", ...gs.map((x) => x.name)], accept: [`AIX:${mine}`], mustNot: sib.map((k) => `AIX:${k}`), customer, staff: staffPrev, writer: "takeuchi", why: `竹内さんが ${r.key} を押した番（似た組: ${gs.map((x) => x.name).join("・")}）`, needs: ["依頼（asks）の要点"] } });
    } else if (r.writer !== "takeuchi") {
      const opts = [...new Set([mine, ...sib])];
      goldTurn.push({ dedupe: `aix-picker-gold:${r.u.id}`, question: `AIX のピッカー選び（${gs.map((x) => x.name).join("・")}）: 客「${customer.slice(0, 90)}」${staffPrev ? `／前のこちら「${staffPrev.slice(0, 60)}」` : ""} → どれが正解？（従業員が押したのは ${r.key}${r.mis ? `・中身が合わない: ${r.mis.reason}` : ""}）`, options: opts.map((k) => `AIX:${k}`).concat(["返信"]), recommended: r.mis?.suggest && opts.includes(examKey(r.mis.suggest)) ? `AIX:${examKey(r.mis.suggest)}` : null, why: "従業員の押下は正解にしない（竹内基準）", ref: `aix_usage_logs ${r.u.id.slice(0, 8)}・会話 ${r.u.conversation_id.slice(0, 8)} ${r.u.created_at.slice(0, 16)}` });
    }
  }
  const dd = dedupeCandidates(examRaw.map((x) => x.c), spec);
  for (const x of dd.dropped) sk(x.why);
  const exam = dd.keep.sort((a, b) => P(b.at) - P(a.at)).slice(0, MAX_EXAM);
  const goldPicked = [...goldTurn].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended)).slice(0, MAX_GOLD);
  const goldNeed = Object.values(learned).filter((m) => m.needsOwnerGold && m.key.includes("/")).map((m) => {
    const e = AIX_CATALOG.find((x) => x.key === m.key)!;
    return { dedupe: `aix-picker-meaning:${m.key}`, question: `AIX【${e.button}】→${e.picker?.label ?? ""}（${m.key}）: 竹内さんの送信のお手本が ${m.counts.owner}件で、意味（使う時・書く中身）を竹内基準で決められません。いつ押す物か・お手本の文を教えてください（今の定義: ${e.when.slice(0, 80)}）`, options: ["今の定義のままでよい", "直す（答えに書く）"], recommended: "今の定義のままでよい", why: "従業員の押下から意味を作らない（竹内基準）", ref: `scripts/learn-aix-meanings.ts・全部の送信 ${m.counts.all}件・押し間違いの候補 ${m.counts.misPressStaff}件` };
  });

  // ── 書く（生成のデータ） ──
  const genAt = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  const ts = [
    "// app/lib/aix-catalog-learned.ts — 生成物（scripts/learn-aix-meanings.ts が作る・手で直さない）",
    `// 作った時: ${genAt} JST・aix_usage_logs ${usages.length}件（${since.slice(0, 10)}〜）・竹内基準（竹内さんの送信 messages.staff_writer='takeuchi' と定義・設計知見）だけで意味を作る`,
    "// お手本は伏せた文だけ（お客様の名前・電話・住所・物件名・URL は出さない）。needsOwnerGold＝竹内さんのお手本が 3 未満（竹内さんに聞く）",
    'import type { LearnedMeaning } from "./aix-meaning-learn";',
    "",
    `export const AIX_LEARNED_GENERATED_AT = ${JSON.stringify(genAt)};`,
    `export const AIX_LEARNED: Readonly<Record<string, LearnedMeaning>> = ${JSON.stringify(learned, null, 2)};`,
    "",
  ].join("\n");
  writeFileSync("app/lib/aix-catalog-learned.ts", ts, "utf8");

  // ── 報告（手元だけ） ──
  const dir = join(examCacheRoot(), "aix-meanings"); mkdirSync(dir, { recursive: true });
  const day = genAt.slice(0, 10);
  const ownerByKey = Object.values(learned).filter((m) => m.key.includes("/") || !AIX_CATALOG.some((e) => e.aixType === m.key && e.picker)).map((m) => `${m.key}=${m.counts.owner}/${m.counts.all}${m.needsOwnerGold ? "（要 owner gold）" : ""}`);
  const L: string[] = [`# AIX のボタン×ピッカーの意味（${genAt} JST）`, "", "## 1. 一覧の抜け", ...gaps.map((g) => `- ${g}`), "",
    "## 2. 竹内さんの送信の数（竹内さん/全部）", ownerByKey.join("・"), "",
    "## 3. 押し間違いの候補（送った文の中身が押したピッカーの意味と合わない）",
    ...Object.entries(misByBtn).sort((a, b) => b[1].n - a[1].n).map(([k, o]) => `- ${k}: ${o.n}（従業員 ${o.staff}・竹内さん ${o.owner}）— ${Object.entries(o.reasons).map(([r, n]) => `${r} ${n}`).join("／")}${o.ex.length ? `\n  例: ${o.ex.map((e) => `「${e}」`).join(" ")}` : ""}`), "",
    "## 4. 手打ちで送った AIX の結果（H3: AIX が正解）",
    ...Object.entries(hand).map(([k, o]) => `- ${k}: 竹内さん ${o.takeuchi}・従業員 ${o.employee}・不明 ${o.unknown}${o.ex.length ? `\n  例: ${o.ex.map((e) => `「${e}」`).join(" ")}` : ""}`), "",
    `## 5. 試験の候補（竹内さんの押下＝正解）${exam.length}（全 ${examRaw.length}）／正解を聞く番 ${goldPicked.length}（全 ${goldTurn.length}）／お手本が足りないピッカー ${goldNeed.length}`,
    `外した: ${Object.entries(examSkipped).map(([k, v]) => `${k} ${v}`).join("・")}`,
    ...exam.map((c, i) => `${i + 1}. ${c.accept[0]}（× ${c.mustNot.join(",")}）客「${c.customer.slice(0, 80)}」`), "",
  ];
  writeFileSync(join(dir, `${day}.md`), L.join("\n"), "utf8");
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({ gaps, misByBtn, hand, examAddBatch: exam.map((c) => ({ conv: c.conv, at: c.at, type: c.type, tags: c.tags, accept: c.accept, mustNot: c.mustNot, source: "AIX のピッカー選び（竹内さんの押下）", why: c.why, addedBy: "learn-aix-meanings（人が確かめて足す）" })), goldTurn: goldPicked, goldNeed }, null, 2), "utf8");
  console.log(L.join("\n"));
  console.log(`\n書いた: app/lib/aix-catalog-learned.ts（${(ts.length / 1024).toFixed(1)}KB）・${join(dir, day)}.md/.json`);

  if (APPLY) {
    const { data: existing } = await sb.from("owner_questions").select("dedupe_key");
    const have = new Set(((existing ?? []) as Array<{ dedupe_key: string | null }>).map((r) => r.dedupe_key));
    const ins = [...goldPicked, ...goldNeed].filter((q) => !have.has(q.dedupe)).map((q, i) => ({ kind: "gold", topic: "正解", question: q.question, options: q.options, recommended: q.recommended, why: q.why, source_kind: "learn-aix-meanings", source_ref: q.ref, status: "open", priority: 50 + i, dedupe_key: q.dedupe }));
    if (ins.length) { const { error } = await sb.from("owner_questions").insert(ins); if (error) throw new Error(error.message); }
    console.log(`owner_questions に ${ins.length} 件足した`);
  } else console.log(`owner_questions には書いていない（--apply-questions で ${goldPicked.length + goldNeed.length} 件を足す）`);
})().catch((e) => { console.error(e); process.exit(1); });
