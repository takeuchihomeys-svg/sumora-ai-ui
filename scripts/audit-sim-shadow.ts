// お客様役の「影の道」の判定（app/lib/customer-sim-shadow.ts judgeShadowTurn）を本番の実送信に当てて線を確かめる（読み取りのみ・LLM は呼ばない）
// 2026-09-27 竹内「返信もAIXも仮定して送る形でズレなくしていく／設計知見と協力しておこなっていく」
//
// 1ターン = お客様の連投 → 次のお客様の発言まで（48時間以内）のこちらの送信
//   AIX の文: messages.is_aix_generated か、近い（±10分）aix_usage_logs.generated_text と 2文字の組で 60% 以上重なる手打ち扱いの行
// ① AIX の番（その番に AIX を送った）× 同じお客様の発言への生成の下書き（ai_reply_examples line_reply の ai_draft）
//      → judgeShadowTurn(chosen=aix)。当たった行為を**スタッフが送った文（sent_reply）から消したか**で当たりの目安を見る
// ② 手打ちだけの番 × 場面の候補（detectAixSceneEvidence）× 生成の下書き → judgeShadowTurn(chosen=draft)。同じく消したか
// ③ AIX の後の一言の率（AIX_FOLLOWUP_RATE の元の数字）
// ④ YUMA（お客様役）の記録 %TEMP%/sumora-customer-sim/*.jsonl に当てる（影の下書きが無い記録は AIX の後の一言だけ）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-sim-shadow.ts   （DAYS=180・SHOW=8）
import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectAixSceneEvidence } from "../app/lib/aix-scene-evidence";
import {
  judgeShadowTurn, staffActsOf, aixKey, AIX_FOLLOWUP_RATE, SHADOW_KINDS, shadowKindJa,
  type ShadowFinding, type StaffAct,
} from "../app/lib/customer-sim-shadow";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const SHOW = Number(process.env.SHOW ?? 8);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
const MEDIA = /^\[(画像|動画|スタンプ|ファイル|音声|位置情報)/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function page(table: string, cols: string, s: string | null, tcol = "created_at", filter?: (q: Any) => Any): Promise<Any[]> {
  const out: Any[] = [];
  for (let p = 0; p < 400; p++) {
    let q = sb.from(table).select(cols).order(tcol).range(p * 1000, p * 1000 + 999);
    if (s) q = q.gte(tcol, s);
    if (filter) q = filter(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const one = (s: string | null | undefined, n = 140) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/https?:\/\/\S+/g, "[URL]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1");
const norm = (s: string) => String(s ?? "").replace(/[\s　！!。、,😊😌]/g, "");
function bigrams(s: string) { const n = norm(s); const b = new Set<string>(); for (let i = 0; i < n.length - 1; i++) b.add(n.slice(i, i + 2)); return b; }
function sim(a: string, b: string) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let x = 0; for (const g of A) if (B.has(g)) x++; return x / Math.min(A.size, B.size); }
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

/** 当たった行為が送った文に残ったか（finding の detail の「」内の行為名で照合） */
function actOfFinding(f: ShadowFinding): StaffAct | null {
  const m = f.detail.match(/「([^」]+)」/g);
  if (!m) return null;
  const ja: Record<string, StaffAct> = {
    "確認の宣言": "check_promise", "見積書を送る宣言": "estimate_promise", "初期費用・割引の金額": "cost_amount", "初期費用の中身の説明": "cost_items",
    "内覧の候補日時": "viewing_datetime", "内覧の日程を聞く": "viewing_date_ask", "待ち合わせの場所・住所": "meeting_detail", "室内の写真の話": "photo",
    "保証会社名・審査の通りやすさ": "guarantor_detail", "申込の書類の案内": "apply_docs", "申込フォーム本体": "apply_form", "募集中の断言": "vacancy_assert", "電話の約束": "phone_promise",
  };
  for (const x of m) { const k = x.slice(1, -1); if (ja[k]) return ja[k]; }
  return null;
}

async function main() {
  const convs = await page("conversations", "id, line_source_type", null);
  const ok = new Set<string>(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => c.id));
  const msgs = (await page("messages", "conversation_id, sender, text, created_at, is_aix_generated, line_message_id", since)).filter((m) => ok.has(m.conversation_id));
  const aix = (await page("aix_usage_logs", "conversation_id, aix_type, check_pattern, sent_at, line_message_id, generated_text", since, "sent_at")).filter((a) => a.sent_at && ok.has(a.conversation_id));
  const ex = (await page("ai_reply_examples", "conversation_id, customer_message, ai_draft, sent_reply, entry_source", since, "created_at", (q: Any) => q.eq("entry_source", "line_reply")))
    .filter((e) => e.ai_draft && e.sent_reply && ok.has(e.conversation_id));
  console.log(`=== ${DAYS}日: 発言 ${msgs.length}・AIX ${aix.length}・生成の下書き ${ex.length}（グループ・YUMA を除く） ===`);

  const byConv = new Map<string, Any[]>();
  for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push({ ...m, t: Date.parse(m.created_at) }); byConv.set(m.conversation_id, a); }
  const aixBy = new Map<string, Any[]>();
  for (const a of aix) { const x = aixBy.get(a.conversation_id) ?? []; x.push({ ...a, t: Date.parse(a.sent_at) }); aixBy.set(a.conversation_id, x); }
  const exBy = new Map<string, Any>();
  for (const e of ex) exBy.set(`${e.conversation_id}|${norm(e.sent_reply).slice(0, 40)}`, e);

  type Turn = { conv: string; cust: string; custT: number; hasImageOrUrl: boolean; priorSends: number; recent: Any[]; aixHist: Any[]; staff: Array<{ t: number; text: string; isAix: boolean; type: string | null; cp: string | null }> };
  const turns: Turn[] = [];
  for (const [conv, ms0] of byConv) {
    const ms = ms0.sort((a, b) => a.t - b.t);
    const ax = (aixBy.get(conv) ?? []).sort((a, b) => a.t - b.t);
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer") continue;
      let j = i; while (j + 1 < ms.length && ms[j + 1].sender === "customer") j++;
      const custMsgs = ms.slice(i, j + 1);
      const cust = custMsgs.map((m) => m.text ?? "").filter((x) => x && !MEDIA.test(x)).join("\n");
      const hasImageOrUrl = custMsgs.some((m) => /^\[画像\]|https?:\/\//.test(m.text ?? ""));
      const before = ax.filter((a) => a.t < ms[i].t);
      const priorSends = before.filter((a) => /property_send|property_recommendation/.test(a.aix_type) && a.t > ms[i].t - 21 * 86400e3).length;
      const staff: Turn["staff"] = [];
      let k = j + 1;
      while (k < ms.length && ms[k].sender !== "customer" && ms[k].t - ms[j].t < 48 * 3600e3) {
        const m = ms[k];
        if (m.sender === "staff" && m.text && !MEDIA.test(m.text)) {
          const near = ax.filter((a) => Math.abs(a.t - m.t) < 10 * 60e3 && a.generated_text);
          let best: Any = null, bs = 0;
          for (const a of near) { const s = sim(m.text, a.generated_text); if (s > bs) { bs = s; best = a; } }
          const byId = ax.find((a) => a.line_message_id && a.line_message_id === m.line_message_id);
          const isAix = !!m.is_aix_generated || !!byId || bs >= 0.6;
          const hit = byId ?? (bs >= 0.6 ? best : null) ?? (isAix ? near.sort((a: Any, b: Any) => Math.abs(a.t - m.t) - Math.abs(b.t - m.t))[0] : null);
          staff.push({ t: m.t, text: m.text, isAix, type: isAix ? (hit?.aix_type ?? null) : null, cp: hit?.check_pattern ?? null });
        }
        k++;
      }
      turns.push({ conv, cust, custT: ms[j].t, hasImageOrUrl, priorSends, recent: ms.slice(Math.max(0, i - 20), j + 1).map((m) => ({ sender: m.sender, text: m.text, isAix: m.is_aix_generated })), aixHist: before.slice(-10).map((a) => ({ aix_type: a.aix_type, check_pattern: a.check_pattern })), staff });
      i = j;
    }
  }

  // ── ① AIX の番 × 生成の下書き ──
  type Hit = { f: ShadowFinding; kept: boolean; cust: string; draft: string; sent: string; aixText: string };
  const hitsA: Hit[] = []; let nA = 0;
  const hitsB: Hit[] = []; let nB = 0;
  const sceneRows: Array<{ key: string; aixSent: boolean }> = [];
  for (const t of turns) {
    const firstAix = t.staff.find((s) => s.isAix && s.type);
    const manual = t.staff.filter((s) => !s.isAix);
    for (const m of manual) {
      const e = exBy.get(`${t.conv}|${norm(m.text).slice(0, 40)}`);
      if (!e) continue;
      if (firstAix) {
        nA++;
        const fs = judgeShadowTurn({
          chosen: "aix", aix: { action: firstAix.type!, checkPattern: firstAix.cp, text: null }, draftText: e.ai_draft,
          focusSentByUs: t.priorSends > 0 && !t.hasImageOrUrl,
        });
        for (const f of fs) { const a = actOfFinding(f); hitsA.push({ f, kept: a ? staffActsOf(e.sent_reply).has(a) : false, cust: t.cust, draft: e.ai_draft, sent: e.sent_reply, aixText: firstAix.text }); }
      }
    }
    if (!firstAix && manual.length) {
      const ev = detectAixSceneEvidence({ latestCustomerTurn: t.cust, hasCustomerImage: t.hasImageOrUrl, recentMessages: t.recent, aixHistory: t.aixHist, sentPropertyCount: t.priorSends });
      if (!ev) continue;
      sceneRows.push({ key: aixKey(ev.candidateAction, ev.checkPattern), aixSent: false });
      for (const m of manual) {
        const e = exBy.get(`${t.conv}|${norm(m.text).slice(0, 40)}`);
        if (!e) continue;
        nB++;
        const fs = judgeShadowTurn({ chosen: "draft", candidates: [{ action: ev.candidateAction, checkPattern: ev.checkPattern, source: "scene" }], draftText: e.ai_draft })
          .filter((f) => f.kind !== "aix_scene_skipped");
        for (const f of fs) { const a = actOfFinding(f); hitsB.push({ f, kept: a ? staffActsOf(e.sent_reply).has(a) : false, cust: t.cust, draft: e.ai_draft, sent: e.sent_reply, aixText: "" }); }
      }
    }
  }
  const show = (title: string, n: number, hits: Hit[]) => {
    console.log(`\n■ ${title}（下書き ${n}通）`);
    const g = new Map<string, Hit[]>();
    for (const h of hits) { const k = `${shadowKindJa(h.f.kind)}｜${h.f.detail.replace(/（[^）]*）$/, "")}`; const a = g.get(k) ?? []; a.push(h); g.set(k, a); }
    if (!g.size) console.log("  当たり 0");
    for (const [k, hs] of [...g].sort((a, b) => b[1].length - a[1].length)) {
      const removed = hs.filter((h) => !h.kept).length;
      console.log(`  ${k}: ${hs.length}通（スタッフが消した ${removed}・${pct(removed, hs.length)}）`);
      for (const h of hs.slice(0, SHOW)) {
        console.log(`    ${h.kept ? "残した" : "消した"} 客「${mask(one(h.cust, 50))}」`);
        if (h.aixText) console.log(`       AIX: ${mask(one(h.aixText, 90))}`);
        console.log(`       下書き: ${mask(one(h.draft, 200))}`);
        console.log(`       送った: ${mask(one(h.sent, 200))}`);
      }
    }
  };
  show("① AIX の番 × 生成の下書き", nA, hitsA);
  show("② 手打ちだけの番 × 場面の候補 × 生成の下書き", nB, hitsB);

  // ── 場面の候補ごとに AIX で返した率（決まりの場面を下書きで返した率） ──
  {
    const all = new Map<string, { n: number; aix: number }>();
    for (const t of turns) {
      const ev = detectAixSceneEvidence({ latestCustomerTurn: t.cust, hasCustomerImage: t.hasImageOrUrl, recentMessages: t.recent, aixHistory: t.aixHist, sentPropertyCount: t.priorSends });
      if (!ev || !t.staff.length) continue;
      const k = aixKey(ev.candidateAction, ev.checkPattern);
      const r = all.get(k) ?? { n: 0, aix: 0 }; r.n++; if (t.staff.some((s) => s.isAix)) r.aix++; all.set(k, r);
    }
    console.log("\n■ 場面の候補ごと: こちらが AIX で返した率（残りは手打ちだけ）");
    for (const [k, r] of [...all].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(38)} ${r.n}番 AIX ${r.aix}（${pct(r.aix, r.n)}）`);
  }

  // ── ⑤ 誤検知の目安: スタッフ自身が送った手打ち（＝正しいとみなす）に同じ判定を当てる ──
  {
    const g = new Map<string, { n: number; samples: string[] }>();
    let nA2 = 0, nB2 = 0;
    for (const t of turns) {
      const firstAix = t.staff.find((s) => s.isAix && s.type);
      const manual = t.staff.filter((s) => !s.isAix);
      if (!manual.length) continue;
      let fs: ShadowFinding[] = [];
      if (firstAix) {
        nA2++;
        for (const m of manual) fs.push(...judgeShadowTurn({ chosen: "aix", aix: { action: firstAix.type!, checkPattern: firstAix.cp, text: null }, draftText: m.text, focusSentByUs: t.priorSends > 0 && !t.hasImageOrUrl }));
      } else {
        const ev = detectAixSceneEvidence({ latestCustomerTurn: t.cust, hasCustomerImage: t.hasImageOrUrl, recentMessages: t.recent, aixHistory: t.aixHist, sentPropertyCount: t.priorSends });
        if (!ev) continue;
        nB2++;
        for (const m of manual) fs.push(...judgeShadowTurn({ chosen: "draft", candidates: [{ action: ev.candidateAction, checkPattern: ev.checkPattern, source: "scene" }], draftText: m.text }).filter((f) => f.kind !== "aix_scene_skipped"));
      }
      const seen = new Set<string>();
      for (const f of fs) {
        const k = `${shadowKindJa(f.kind)}｜${f.detail.replace(/（[^）]*）$/, "")}`;
        if (seen.has(k)) continue; seen.add(k);
        const r = g.get(k) ?? { n: 0, samples: [] }; r.n++;
        if (r.samples.length < 3) r.samples.push(`客「${mask(one(t.cust, 40))}」→ ${mask(one(manual.map((m) => m.text).join(" ｜ "), 160))}`);
        g.set(k, r);
      }
    }
    console.log(`\n■ 誤検知の目安: スタッフが実際に送った手打ちに当てた（AIX の番 ${nA2}・場面の候補のある手打ちだけの番 ${nB2}）`);
    for (const [k, r] of [...g].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${k}: ${r.n}番`);
      for (const s of r.samples.slice(0, Math.min(SHOW, 3))) console.log(`    ${s}`);
    }
  }

  // ── ③ AIX の後の一言 ──
  {
    const g = new Map<string, { n: number; after: number }>();
    for (const t of turns) {
      const idx = t.staff.map((s, i) => (s.isAix ? i : -1)).filter((i) => i >= 0);
      if (!idx.length || !t.staff[idx[0]].type) continue;
      const first = t.staff[idx[0]], last = t.staff[idx[idx.length - 1]];
      const k = aixKey(first.type!, first.type === "property_check_result" ? first.cp : null);
      const r = g.get(k) ?? { n: 0, after: 0 }; r.n++;
      if (t.staff.slice(idx[idx.length - 1] + 1).some((s) => !s.isAix && s.t - last.t <= 10 * 60e3)) r.after++;
      g.set(k, r);
    }
    console.log("\n■ AIX の後10分以内に手打ちの一言（AIX_FOLLOWUP_RATE の元）");
    for (const [k, r] of [...g].sort((a, b) => b[1].n - a[1].n).slice(0, 14)) console.log(`  ${k.padEnd(38)} ${r.after}/${r.n}（${pct(r.after, r.n)}）${AIX_FOLLOWUP_RATE[k] ? "  ← 表にある" : ""}`);
  }

  // ── ④ お客様役の記録（YUMA） ──
  {
    const dir = join(tmpdir(), "sumora-customer-sim");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
    let n = 0; const found: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean)) {
        const r = JSON.parse(line) as Any;
        if (!r.sent) continue;
        n++;
        const isAix = String(r.sentKind ?? "").startsWith("AIX ");
        const [action, cp] = isAix ? String(r.sentKind).slice(4).split("/") : [null, null];
        const fs = isAix
          ? judgeShadowTurn({ chosen: "aix", aix: { action: action!, checkPattern: cp ?? null, text: r.sent }, draftText: r.shadow?.draft ?? null, followupSent: false })
          : judgeShadowTurn({ chosen: "draft", candidates: r.shadow?.candidates ?? [], draftText: r.sent });
        for (const f of fs) found.push(`${file} 往復${r.round}: ${shadowKindJa(f.kind)}（${f.detail}）\n      送った: ${one(r.sent, 120)}`);
      }
    }
    console.log(`\n■ お客様役の記録（${files.length}ファイル・送った往復 ${n}）`);
    for (const x of found) console.log(`  ${x}`);
    if (!found.length) console.log("  当たり 0");
  }
  console.log(`\n種類: ${SHADOW_KINDS.map(shadowKindJa).join("／")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
