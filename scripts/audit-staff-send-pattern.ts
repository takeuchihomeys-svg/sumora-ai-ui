// 実際のスタッフの送り方を本番の実送信で数える（読み取りのみ・LLM は呼ばない）
// 2026-09-27 竹内「AIXにずれがないか確認するためにも実際のスタッフが送ったようになるように／AIXを活用しながらテスト進めていく」
//
// 1番 = お客様の連投 → 次のお客様の発言まで（48時間以内）のこちらの送信。分類は app/lib/staff-send-pattern.ts classifyStaffTurn
//   AIX の文: messages.is_aix_generated・aix_usage_logs.line_message_id・近い（±10分）generated_text と2文字の組で60%以上（audit-sim-shadow と同じ）
// ① 送り方の形（返信だけ／AIX だけ／AIX→一言／返信→AIX／AIX を2つ）全体とブレインの判断（場面）ごと
// ② 返信→AIX（ブレインの AIX を、返信を先に送ってから同じ番で押した）率 → REPLY_THEN_AIX_RATE
// ③ 点滅だけ（ブレインは action を持つが reply_mode≠aix）の番で、その AIX を押した率 → SHOWN_NOT_AIX_PRESS_RATE
// ④ AIX を2つ続ける組 → AIX_PAIR_RATE
// ⑤ AIX の後の一言の率と出所（送信後のバナーのテンプレ＝template_selection_logs の post_aix／同じテンプレの文型／手打ち）・バナーで選ばれたテンプレ
// ⑥ AIX ごとのピッカーの選び方（check_pattern・send_mode・app_sub_mode・picker_choices）と場面からの選び方（simPickerFor）の一致
//
// 実行: npx tsx --env-file=.env.local scripts/audit-staff-send-pattern.ts   （DAYS=180・SHOW=4）
import { createClient } from "@supabase/supabase-js";
import {
  classifyStaffTurn, brainSceneLabel, STAFF_TURN_SHAPE_JA, FOLLOWUP_TEMPLATE_CATEGORY, simPickerFor, followupTemplateUsable,
  type StaffSendItem, type StaffTurnShape,
} from "../app/lib/staff-send-pattern";
import { AIX_FOLLOWUP_RATE } from "../app/lib/customer-sim-shadow";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const SHOW = Number(process.env.SHOW ?? 4);
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
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const inc = <K>(m: Map<K, number>, k: K, d = 1) => m.set(k, (m.get(k) ?? 0) + d);

async function main() {
  const convs = await page("conversations", "id, line_source_type", null);
  const ok = new Set<string>(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => c.id));
  const msgs = (await page("messages", "conversation_id, sender, text, created_at, is_aix_generated, line_message_id", since)).filter((m) => ok.has(m.conversation_id));
  const aix = (await page("aix_usage_logs", "id, conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, sent_at, created_at, line_message_id, generated_text", since, "created_at"))
    .filter((a) => ok.has(a.conversation_id)).map((a) => ({ ...a, t: Date.parse(a.sent_at ?? a.created_at) }));
  const brain = (await page("brain_decision_logs", "conversation_id, suggested_action, suggested_reply_mode, suggested_check_pattern, analyzed_msg_ts, created_at", since)).filter((b) => ok.has(b.conversation_id) && b.analyzed_msg_ts);
  const tsl = (await page("template_selection_logs", "conversation_id, template_id, template_category, open_context, aix_action_type, original_text, final_sent_text, created_at", since)).filter((x) => ok.has(x.conversation_id));
  const tmpl = await page("templates", "id, label, text, category, requires_image, sort_order", null, "created_at", (q: Any) => q.in("category", Object.values(FOLLOWUP_TEMPLATE_CATEGORY)));
  const brainFrom = brain.length ? brain.map((b) => b.created_at).sort()[0] : null;
  console.log(`=== ${DAYS}日: 発言 ${msgs.length}・AIX ${aix.length}・ブレインの判断 ${brain.length}（${brainFrom ? brainFrom.slice(0, 10) : "-"}〜）・テンプレの選択 ${tsl.length}（グループ・YUMA を除く） ===`);

  const byConv = new Map<string, Any[]>();
  for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push({ ...m, t: Date.parse(m.created_at) }); byConv.set(m.conversation_id, a); }
  const aixBy = new Map<string, Any[]>();
  for (const a of aix) { const x = aixBy.get(a.conversation_id) ?? []; x.push(a); aixBy.set(a.conversation_id, x); }
  const brainBy = new Map<string, Any[]>();
  for (const b of brain) { const x = brainBy.get(b.conversation_id) ?? []; x.push({ ...b, at: Date.parse(b.analyzed_msg_ts), ct: Date.parse(b.created_at) }); brainBy.set(b.conversation_id, x); }
  const tslBy = new Map<string, Any[]>();
  for (const x of tsl) { const a = tslBy.get(x.conversation_id) ?? []; a.push({ ...x, t: Date.parse(x.created_at) }); tslBy.set(x.conversation_id, a); }

  type Turn = { conv: string; cust: string; custT: number; firstT: number; hasImage: boolean; sentBefore: number; staffTexts: string[]; sends: Array<StaffSendItem & { log: Any | null }>; brain: Any | null };
  const turns: Turn[] = [];
  for (const [conv, ms0] of byConv) {
    const ms = ms0.sort((a, b) => a.t - b.t);
    const ax = (aixBy.get(conv) ?? []).sort((a, b) => a.t - b.t);
    const bl = (brainBy.get(conv) ?? []).sort((a, b) => a.ct - b.ct);
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer") continue;
      let j = i; while (j + 1 < ms.length && ms[j + 1].sender === "customer") j++;
      const custMsgs = ms.slice(i, j + 1);
      const sends: Turn["sends"] = [];
      let k = j + 1;
      while (k < ms.length && ms[k].sender !== "customer" && ms[k].t - ms[j].t < 48 * 3600e3) {
        const m = ms[k];
        if (m.sender === "staff" && m.text && !MEDIA.test(m.text)) {
          const near = ax.filter((a) => Math.abs(a.t - m.t) < 10 * 60e3 && a.generated_text);
          let best: Any = null, bs = 0;
          for (const a of near) { const s = sim(m.text, a.generated_text); if (s > bs) { bs = s; best = a; } }
          const byId = ax.find((a) => a.line_message_id && a.line_message_id === m.line_message_id);
          const isAix = !!m.is_aix_generated || !!byId || bs >= 0.6;
          const hit = byId ?? (bs >= 0.6 ? best : null) ?? (isAix ? [...near, ...ax.filter((a) => Math.abs(a.t - m.t) < 10 * 60e3)].sort((a: Any, b: Any) => Math.abs(a.t - m.t) - Math.abs(b.t - m.t))[0] ?? null : null);
          sends.push({ t: m.t, isAix, aixType: isAix ? (hit?.aix_type ?? null) : null, checkPattern: hit?.check_pattern ?? null, text: m.text, log: isAix ? hit : null });
        }
        k++;
      }
      // ブレインの判断: この連投を見た判断（analyzed_msg_ts が連投の中）の最後の物で、最初の送信より前に保存された物
      const firstT = sends[0]?.t ?? Infinity;
      const b = bl.filter((x) => x.at >= custMsgs[0].t - 5000 && x.at <= ms[j].t + 5000 && x.ct <= firstT).pop() ?? null;
      const sentBefore = ax.filter((a) => a.t < ms[i].t && /property_send|property_recommendation/.test(a.aix_type)).length;
      const staffTexts = ms.slice(Math.max(0, i - 12), i).filter((m) => m.sender === "staff" && m.text && !MEDIA.test(m.text)).map((m) => m.text);
      turns.push({
        conv, cust: custMsgs.map((m) => m.text ?? "").filter((x) => x && !MEDIA.test(x)).join("\n"), custT: ms[j].t, firstT,
        hasImage: custMsgs.some((m) => /^\[画像\]|https?:\/\//.test(m.text ?? "")), sentBefore, staffTexts, sends, brain: b,
      });
      i = j;
    }
  }
  const cls = turns.map((t) => ({ t, c: classifyStaffTurn(t.sends) }));
  const SHAPES = Object.keys(STAFF_TURN_SHAPE_JA) as StaffTurnShape[];

  // ── ① 形の分布 ──
  {
    const all = new Map<StaffTurnShape, number>();
    for (const { c } of cls) inc(all, c.shape);
    const sent = cls.filter(({ c }) => c.shape !== "none").length;
    console.log(`\n■ ① お客様の連投 ${cls.length}番（こちらが送った番 ${sent}）の送り方`);
    for (const s of SHAPES) console.log(`  ${STAFF_TURN_SHAPE_JA[s].padEnd(10)} ${String(all.get(s) ?? 0).padStart(6)}（送った番の ${s === "none" ? "—" : pct(all.get(s) ?? 0, sent)}）`);
    const withAix = cls.filter(({ c }) => c.firstAix).length;
    console.log(`  → AIX を押した番 ${withAix}（送った番の ${pct(withAix, sent)}）`);

    console.log(`\n■ ① ブレインの判断（場面）ごと（判断のある番だけ・${brainFrom?.slice(0, 10) ?? "-"}〜）`);
    const g = new Map<string, Map<StaffTurnShape | "pressed_brain" | "n", number>>();
    for (const { t, c } of cls) {
      if (!t.brain || c.shape === "none") continue;
      const k = brainSceneLabel(t.brain);
      const r = g.get(k) ?? new Map(); inc(r, "n"); inc(r, c.shape);
      if (t.brain.suggested_action && c.aixTypes.includes(t.brain.suggested_action)) inc(r, "pressed_brain");
      g.set(k, r);
    }
    console.log(`  ${"場面".padEnd(34)} ${"番".padStart(5)}  ${SHAPES.filter((s) => s !== "none").map((s) => STAFF_TURN_SHAPE_JA[s]).join(" ／ ")} ／ ブレインの AIX を押した`);
    for (const [k, r] of [...g].sort((a, b) => (b[1].get("n") ?? 0) - (a[1].get("n") ?? 0)).slice(0, 26)) {
      const n = r.get("n") ?? 0;
      console.log(`  ${k.padEnd(34)} ${String(n).padStart(5)}  ${SHAPES.filter((s) => s !== "none").map((s) => `${r.get(s) ?? 0}(${pct(r.get(s) ?? 0, n)})`).join(" ／ ")} ／ ${r.get("pressed_brain") ?? 0}(${pct(r.get("pressed_brain") ?? 0, n)})`);
    }
  }

  // ── ② 返信→AIX ──
  const replyThen: Record<string, { n: number; hit: number; delays: number[] }> = {};
  {
    const byType = new Map<string, { n: number; delays: number[]; samples: string[] }>();
    for (const { t, c } of cls) {
      if (c.shape !== "reply_then_aix" || !c.firstAix) continue;
      const r = byType.get(c.firstAix) ?? { n: 0, delays: [], samples: [] }; r.n++; if (c.replyToAixMs !== null) r.delays.push(c.replyToAixMs);
      if (r.samples.length < SHOW) r.samples.push(`客「${mask(one(t.cust, 40))}」→ 返信「${mask(one(t.sends.find((s) => !s.isAix)?.text, 70))}」→ AIX ${c.firstAix}`);
      byType.set(c.firstAix, r);
    }
    console.log("\n■ ② 返信→AIX（手打ちを先に送ってから同じ番で AIX）の AIX ごと（全期間）");
    for (const [k, r] of [...byType].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
      console.log(`  ${k.padEnd(26)} ${String(r.n).padStart(4)}番  返信→AIX の間 中央 ${Math.round(median(r.delays) / 60000)}分`);
      for (const s of r.samples) console.log(`      ${s}`);
    }
    // ブレインの判断が AIX:X で X を押した番のうち、返信を先に送った率
    for (const { t, c } of cls) {
      const a = t.brain?.suggested_reply_mode === "aix" ? t.brain?.suggested_action : null;
      if (!a || !c.aixTypes.includes(a)) continue;
      const r = replyThen[a] ?? { n: 0, hit: 0, delays: [] }; r.n++;
      if (c.shape === "reply_then_aix" && c.firstAix === a) { r.hit++; if (c.replyToAixMs !== null) r.delays.push(c.replyToAixMs); }
      replyThen[a] = r;
    }
    const tot = Object.values(replyThen).reduce((x, r) => ({ n: x.n + r.n, hit: x.hit + r.hit }), { n: 0, hit: 0 });
    console.log(`\n■ ② ブレインの AIX を押した番 ${tot.n} のうち返信を先に送った ${tot.hit}（${pct(tot.hit, tot.n)}）→ REPLY_THEN_AIX_RATE`);
    for (const [k, r] of Object.entries(replyThen).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(26)} ${r.hit}/${r.n}（${pct(r.hit, r.n)}）${r.delays.length ? `・間 中央 ${Math.round(median(r.delays) / 60000)}分` : ""}`);
  }

  // ── ③ 点滅だけの番 ──
  const pulse: Record<string, { n: number; hit: number }> = {};
  {
    for (const { t, c } of cls) {
      const a = t.brain?.suggested_action;
      if (!a || t.brain?.suggested_reply_mode === "aix" || c.shape === "none") continue;
      const r = pulse[a] ?? { n: 0, hit: 0 }; r.n++; if (c.aixTypes.includes(a)) r.hit++; pulse[a] = r;
    }
    console.log("\n■ ③ ブレインは action を持つが reply_mode≠aix（画面は点滅）の番で、その AIX を押した率 → SHOWN_NOT_AIX_PRESS_RATE");
    for (const [k, r] of Object.entries(pulse).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(26)} ${r.hit}/${r.n}（${pct(r.hit, r.n)}）`);
  }

  // ── ④ AIX を2つ ──
  const pairs: Record<string, { n: number; hit: number }> = {};
  {
    const firstCount = new Map<string, number>();
    const pairCount = new Map<string, number>();
    for (const { c } of cls) {
      if (!c.aixTypes.length) continue;
      inc(firstCount, c.aixTypes[0]);
      if (c.aixTypes.length >= 2) inc(pairCount, `${c.aixTypes[0]}>${c.aixTypes[1]}`);
    }
    console.log("\n■ ④ AIX を2つ続けた組（先>後・先の AIX を押した番のうちの率）→ AIX_PAIR_RATE");
    for (const [k, n] of [...pairCount].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
      const first = firstCount.get(k.split(">")[0]) ?? 0;
      pairs[k] = { n: first, hit: n };
      console.log(`  ${k.padEnd(48)} ${n}/${first}（${pct(n, first)}）`);
    }
  }

  // ── ⑤ AIX の後の一言と出所 ──
  const picks: Record<string, Record<string, number>> = {};
  {
    const tmplById = new Map(tmpl.map((t) => [t.id, t]));
    const g = new Map<string, { n: number; after: number; src: Map<string, number>; samples: string[] }>();
    for (const { t, c } of cls) {
      if (!c.firstAix) continue;
      const k = c.firstAix;
      const r = g.get(k) ?? { n: 0, after: 0, src: new Map<string, number>(), samples: [] as string[] }; r.n++;
      if (c.shape === "aix_then_line" && c.followup) {
        r.after++;
        const fu = c.followup;
        const logs = (tslBy.get(t.conv) ?? []).filter((x) => x.t >= fu.t - 15 * 60e3 && x.t <= fu.t + 2 * 60e3);
        const lg = logs.map((x) => ({ x, s: Math.max(sim(fu.text ?? "", x.final_sent_text ?? ""), sim(fu.text ?? "", x.original_text ?? "")) })).sort((a, b) => b.s - a.s)[0];
        const cat = FOLLOWUP_TEMPLATE_CATEGORY[k];
        const catT = cat ? tmpl.filter((x) => x.category === cat) : [];
        const bestT = catT.map((x) => ({ x, s: sim(fu.text ?? "", x.text ?? "") })).sort((a, b) => b.s - a.s)[0];
        let src = "手打ち";
        if (lg && lg.s >= 0.5) src = `テンプレ（${lg.x.open_context ?? "?"}）`;
        else if (bestT && bestT.s >= 0.6) src = "同じ種類のテンプレの文型（記録なし）";
        inc(r.src, src);
        if (r.samples.length < SHOW) r.samples.push(`[${src}] ${mask(one(fu.text, 110))}`);
      }
      g.set(k, r);
    }
    console.log("\n■ ⑤ AIX の後10分以内の一言（最初の AIX ごと）と出所");
    for (const [k, r] of [...g].sort((a, b) => b[1].n - a[1].n).slice(0, 14)) {
      const cur = AIX_FOLLOWUP_RATE[k];
      console.log(`  ${k.padEnd(26)} ${r.after}/${r.n}（${pct(r.after, r.n)}）${cur ? `  表 ${Math.round(cur.rate * 100)}%` : ""}  出所: ${[...r.src].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join("・") || "-"}`);
      for (const s of r.samples) console.log(`      ${s}`);
    }
    // 形を問わず（返信→AIX・AIX を2つの番も含む）: その AIX の最後の送信の後10分以内に手打ちがあったか（AIX_FOLLOWUP_RATE と同じ数え方）
    {
      const h = new Map<string, { n: number; after: number }>();
      for (const { t, c } of cls) {
        for (const x of c.aixTypes) {
          const lastX = [...t.sends].filter((s) => s.isAix && s.aixType === x).pop()!;
          const r = h.get(x) ?? { n: 0, after: 0 }; r.n++;
          if (t.sends.some((s) => !s.isAix && s.t > lastX.t && s.t - lastX.t <= 10 * 60e3)) r.after++;
          h.set(x, r);
        }
      }
      console.log("\n■ ⑤ 形を問わず: その AIX の後10分以内に手打ち（AIX_FOLLOWUP_RATE と同じ数え方）");
      for (const [k, r] of [...h].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
        const cur = AIX_FOLLOWUP_RATE[k];
        console.log(`  ${k.padEnd(26)} ${r.after}/${r.n}（${pct(r.after, r.n)}）${cur ? `  表 ${Math.round(cur.rate * 100)}%（n=${cur.n}）` : ""}`);
      }
    }
    // バナー（post_aix）から選ばれたテンプレ
    for (const x of tsl) {
      if (x.open_context !== "post_aix" || !x.template_id || !x.aix_action_type) continue;
      const m = picks[x.aix_action_type] ?? (picks[x.aix_action_type] = {});
      m[x.template_id] = (m[x.template_id] ?? 0) + 1;
    }
    console.log("\n■ ⑤ 送信後のバナー（post_aix）から選ばれたテンプレ（使える物に ✓）");
    for (const [a, m] of Object.entries(picks).sort((p, q) => Object.values(q[1]).reduce((s, v) => s + v, 0) - Object.values(p[1]).reduce((s, v) => s + v, 0))) {
      const tot = Object.values(m).reduce((s, v) => s + v, 0);
      console.log(`  ${a}（${tot}回）`);
      for (const [id, n] of Object.entries(m).sort((p, q) => q[1] - p[1]).slice(0, 4)) {
        const t = tmplById.get(id);
        console.log(`    ${n}回 ${t && followupTemplateUsable(t) ? "✓" : " "} ${id.slice(0, 8)} ${t ? `${t.label}｜${one(t.text, 90)}` : "（今は無いテンプレ）"}`);
      }
    }
  }

  // ── ⑥ ピッカー ──
  {
    console.log("\n■ ⑥ AIX ごとのピッカーの選び方（aix_usage_logs）");
    const g = new Map<string, Map<string, number>>();
    for (const a of aix) {
      const m = g.get(a.aix_type) ?? new Map<string, number>();
      inc(m, "n");
      if (a.check_pattern) inc(m, `check_pattern=${a.check_pattern}`);
      if (a.send_mode) inc(m, `send_mode=${a.send_mode}`);
      if (a.app_sub_mode) inc(m, `app_sub_mode=${a.app_sub_mode}`);
      for (const [pk, pv] of Object.entries(a.picker_choices ?? {})) if (typeof pv === "string") inc(m, `${pk}=${pv}`);
      if (!a.check_pattern && !a.send_mode && !a.app_sub_mode && !a.picker_choices) inc(m, "（記録なし）");
      g.set(a.aix_type, m);
    }
    for (const [k, m] of [...g].sort((a, b) => (b[1].get("n") ?? 0) - (a[1].get("n") ?? 0)).slice(0, 14)) {
      const n = m.get("n") ?? 0;
      console.log(`  ${k.padEnd(26)} ${n}: ${[...m].filter(([x]) => x !== "n").sort((a, b) => b[1] - a[1]).slice(0, 8).map(([x, c]) => `${x} ${c}`).join("・")}`);
    }
    // 場面からの選び方（simPickerFor）と実際の選択の一致（記録のある列だけ）
    console.log("\n■ ⑥ 場面からの選び方（simPickerFor）と実際の選択の一致");
    const agree = new Map<string, { n: number; ok: number; miss: Map<string, number>; samples: string[] }>();
    for (const { t, c } of cls) {
      for (const s of t.sends) {
        if (!s.isAix || !s.log || !s.aixType) continue;
        const actual = s.aixType === "property_send" ? s.log.send_mode : s.aixType === "application_push" ? s.log.app_sub_mode : s.aixType === "property_check_result" ? s.log.check_pattern : null;
        if (!actual) continue;
        const p = simPickerFor({ aixType: s.aixType, turnText: t.cust, hasImage: t.hasImage, sentPropertyCount: t.sentBefore, recentStaffTexts: t.staffTexts, roomStatus: "unknown" });
        if (!p) continue;
        const r = agree.get(s.aixType) ?? { n: 0, ok: 0, miss: new Map<string, number>(), samples: [] as string[] }; r.n++;
        if (p.value === actual) r.ok++;
        else {
          inc(r.miss, `${p.value}→実際 ${actual}`);
          if (r.samples.length < SHOW * 2) r.samples.push(`${p.value}→実際 ${actual}: 客「${mask(one(t.cust, 60))}」 前のこちら「${mask(one(t.staffTexts.slice(-1)[0], 60))}」`);
        }
        agree.set(s.aixType, r);
        void c;
      }
    }
    for (const [k, r] of agree) {
      console.log(`  ${k.padEnd(26)} ${r.ok}/${r.n}（${pct(r.ok, r.n)}）  外れ: ${[...r.miss].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([x, n]) => `${x} ${n}`).join("・")}`);
      for (const x of r.samples) console.log(`      ${x}`);
    }
    console.log("  ※ 物件確認した は結果（あった／なかった）を会話から読めない（roomStatus=unknown → 物件あった）＝一致は目安");
  }

  // ── 表（staff-send-pattern.ts に書く物） ──
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const table = (o: Record<string, { n: number; hit: number }>, min: number) => Object.fromEntries(Object.entries(o).filter(([, r]) => r.n >= min).sort((a, b) => b[1].n - a[1].n).map(([k, r]) => [k, { rate: r2(r.hit / r.n), n: r.n }]));
  console.log("\n■ 表（n≥5）");
  console.log("REPLY_THEN_AIX_RATE =", JSON.stringify(table(replyThen, 5)));
  console.log("PULSE_PRESS_RATE =", JSON.stringify(table(pulse, 5)));
  console.log("AIX_PAIR_RATE =", JSON.stringify(table(pairs, 5)));
  console.log("POST_AIX_TEMPLATE_PICKS =", JSON.stringify(Object.fromEntries(Object.entries(picks).map(([a, m]) => [a, Object.fromEntries(Object.entries(m).sort((p, q) => q[1] - p[1]).slice(0, 3))]))));
}
main().catch((e) => { console.error(e); process.exit(1); });
