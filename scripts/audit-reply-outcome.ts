// scripts/audit-reply-outcome.ts — 結果から学ぶ（app/lib/reply-outcome-learn.ts）を、もうある記録で作って確かめる（本番 DB は読むだけ・書かない・LLM なし）
//
//   お客様の番 → こちらの返事（48時間以内・最初の3時間の連投をまとめる）を1番とし、
//     段階（deal_outcomes の 物件送付・内覧の予定・申込の時刻）× 返し方の形（replyShapeOf）
//   ごとに、その後 14日で内覧の予定（deal_outcomes.viewing_at / viewings / viewing_history の作成）・30日で申込（推定でない applied_at）・7日で返事 を数える。
//   進んだ＝ 条件を聞く段・内覧前: 内覧の予定14日 か 申込30日 ／ 内覧の予定の後: 申込30日。
//   偏りの揃え: 同じ層（段階×お客様の番の種類×返事までの時間×アカウント×それまでのやり取りの多さ）の平均との差（数が少ない層は粗い層に戻る）。
//   確かめ: 古い 70% と新しい 30% に分け、両方で差の向き・順位が保たれるか（会話ごとの再標本で 90% の幅）。
// 実行:
//   npx tsx --env-file=.env.local scripts/audit-reply-outcome.ts [--days=365] [--examples] [--write-table]
//   --write-table: 全部の番で数え表を作り、古い側だけで確かだったマスに新しい側でも向きが保たれたかの印を付けて app/lib/reply-outcome-table-data.ts に書く（数だけ）
//   週1回の作り直し: scripts/refresh-reply-outcome.ps1（この --write-table を回して差分があればコミットの候補を出す）
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { isTestConversation } from "../app/lib/test-conversations";
import { applicationMaterialReason, piiValueSignal } from "../app/lib/test-pii-guard";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";
import { classifyCustomerBurst, type ReactionCat } from "../app/lib/customer-reaction-predict";
import {
  replyShapeOf, sceneAt, REPLY_SHAPES, REPLY_SHAPE_JA, OUTCOME_SCENES, OUTCOME_SCENE_JA,
  type ReplyShape, type OutcomeScene, type OutcomeCell, type OutcomeTable,
} from "../app/lib/reply-outcome-learn";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const has = (k: string) => process.argv.includes(`--${k}`);
const DAYS = Number(arg("days", "365"));
const SPLIT = Number(arg("split", "0.7"));
const BOOT = Number(arg("boot", "400"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type M = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null };
const H = 3600_000, D = 24 * H;

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 900_000; i += 1000) { const { data, error } = await q(i); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;

type Turn = {
  cid: string; at: number; scene: OutcomeScene; shape: ReplyShape; now: ReactionCat; lag: string; acct: string; eng: string;
  view14: boolean; apply30: boolean; reply7: boolean; progress: boolean;
  staffText: string; custText: string; name: string | null;
};

function lagBucket(ms: number) { return ms <= H ? "≤1h" : ms <= 6 * H ? "1-6h" : "6h+"; }
function engBucket(n: number) { return n <= 1 ? "1" : n <= 5 ? "2-5" : "6+"; }

/** 層の平均（細かい層→粗い層・n>=MINS で採る） */
function expectations(ts: Turn[], MINS = 25): number[] {
  const keys = (t: Turn) => [`${t.scene}|${t.now}|${t.lag}|${t.acct}|${t.eng}`, `${t.scene}|${t.now}|${t.lag}`, `${t.scene}|${t.now}`, `${t.scene}`];
  const agg = new Map<string, [number, number]>();
  for (const t of ts) for (const k of keys(t)) { const a = agg.get(k) ?? [0, 0]; a[0] += +t.progress; a[1]++; agg.set(k, a); }
  return ts.map((t) => { for (const k of keys(t)) { const a = agg.get(k)!; if (a[1] >= MINS) return a[0] / a[1]; } const a = agg.get(t.scene)!; return a[0] / a[1]; });
}

type CellStat = { scene: OutcomeScene; shape: ReplyShape; n: number; convs: number; progress: number; view14: number; apply30: number; reply7: number; lift: number; lo: number; hi: number };

function cellStats(ts: Turn[]): CellStat[] {
  const exp = expectations(ts);
  const resid = ts.map((t, i) => +t.progress - exp[i]);
  const byCell = new Map<string, number[]>();
  ts.forEach((t, i) => { const k = `${t.scene}|${t.shape}`; (byCell.get(k) ?? byCell.set(k, []).get(k)!).push(i); });
  // 会話ごとの再標本（同じ会話の番はまとめて引く）
  const convIdx = new Map<string, number[]>(); ts.forEach((t, i) => { (convIdx.get(t.cid) ?? convIdx.set(t.cid, []).get(t.cid)!).push(i); });
  const convs = [...convIdx.keys()];
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const boots = new Map<string, number[]>();
  for (let b = 0; b < BOOT; b++) {
    const sum = new Map<string, [number, number]>();
    for (let j = 0; j < convs.length; j++) {
      const c = convs[Math.floor(rnd() * convs.length)];
      for (const i of convIdx.get(c)!) { const k = `${ts[i].scene}|${ts[i].shape}`; const a = sum.get(k) ?? [0, 0]; a[0] += resid[i]; a[1]++; sum.set(k, a); }
    }
    for (const [k, [s, n]] of sum) (boots.get(k) ?? boots.set(k, []).get(k)!).push(s / n);
  }
  const out: CellStat[] = [];
  for (const [k, idx] of byCell) {
    const [scene, shape] = k.split("|") as [OutcomeScene, ReplyShape];
    const xs = idx.map((i) => ts[i]);
    const bs = (boots.get(k) ?? []).sort((a, b) => a - b);
    const q = (p: number) => bs.length ? bs[Math.min(bs.length - 1, Math.floor(p * bs.length))] : 0;
    out.push({
      scene, shape, n: xs.length, convs: new Set(xs.map((t) => t.cid)).size,
      progress: xs.filter((t) => t.progress).length / xs.length, view14: xs.filter((t) => t.view14).length / xs.length,
      apply30: xs.filter((t) => t.apply30).length / xs.length, reply7: xs.filter((t) => t.reply7).length / xs.length,
      lift: idx.reduce((a, i) => a + resid[i], 0) / idx.length, lo: q(0.05), hi: q(0.95),
    });
  }
  return out;
}

function spearman(a: number[], b: number[]) {
  const rank = (xs: number[]) => { const o = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]); const r = new Array(xs.length); o.forEach(([, i], k) => (r[i] = k)); return r as number[]; };
  const ra = rank(a), rb = rank(b), n = a.length; if (n < 3) return NaN;
  const d2 = ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0); return 1 - (6 * d2) / (n * (n * n - 1));
}

async function main() {
  const since = new Date(Date.now() - DAYS * D).toISOString();
  const msgs = await all<M>((i) => sb.from("messages").select("id, conversation_id, sender, created_at, text").gte("created_at", since).order("created_at").order("id").range(i, i + 999));
  const convs = await all<{ id: string; line_source_type: string | null; customer_name: string | null; account: string | null }>((i) => sb.from("conversations").select("id, line_source_type, customer_name, account").range(i, i + 999));
  const outs = await all<{ conversation_id: string; started_at: string | null; property_sent_at: string | null; viewing_at: string | null; applied_at: string | null; applied_at_estimated: boolean | null }>((i) => sb.from("deal_outcomes").select("conversation_id, started_at, property_sent_at, viewing_at, applied_at, applied_at_estimated").range(i, i + 999));
  const vws = await all<{ conversation_id: string; created_at: string }>((i) => sb.from("viewings").select("conversation_id, created_at").range(i, i + 999));
  const vh = await all<{ conversation_id: string; created_at: string }>((i) => sb.from("viewing_history").select("conversation_id, created_at").range(i, i + 999));

  const skip = new Set(convs.filter((c) => c.line_source_type === "group").map((c) => c.id));
  const meta = new Map(convs.map((c) => [c.id, c]));
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  const viewEv = new Map<string, number[]>(), applyEv = new Map<string, number[]>(), applyAny = new Map<string, number[]>(), propEv = new Map<string, number[]>();
  for (const o of outs) {
    if (o.viewing_at) push(viewEv, o.conversation_id, Date.parse(o.viewing_at));
    if (o.property_sent_at) push(propEv, o.conversation_id, Date.parse(o.property_sent_at));
    if (o.applied_at) { push(applyAny, o.conversation_id, Date.parse(o.applied_at)); if (!o.applied_at_estimated) push(applyEv, o.conversation_id, Date.parse(o.applied_at)); }
  }
  for (const v of [...vws, ...vh]) push(viewEv, v.conversation_id, Date.parse(v.created_at));
  const firstBefore = (xs: number[] | undefined, t: number) => { let best: number | null = null; for (const x of xs ?? []) if (x <= t && (best == null || x > best)) best = x; return best; };
  const anyIn = (xs: number[] | undefined, a: number, b: number) => (xs ?? []).some((x) => x > a && x <= b);

  const by = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id) || skip.has(m.conversation_id)) continue; push(by, m.conversation_id, m); }
  const nowMs = Date.now();
  const turns: Turn[] = [];
  let dropped = { noShape: 0, postApply: 0, young: 0, slow: 0 };
  for (const [cid, list] of by) {
    const runs: Array<{ who: "c" | "s"; ms: M[] }> = [];
    for (const m of list) { const who = m.sender === "customer" ? "c" : "s"; const r = runs[runs.length - 1]; if (r && r.who === who) r.ms.push(m); else runs.push({ who, ms: [m] }); }
    let custBursts = 0;
    for (let i = 0; i < runs.length; i++) {
      const c = runs[i]; if (c.who !== "c") continue; custBursts++;
      const s = runs[i + 1]; if (!s) continue;
      const cEnd = Date.parse(c.ms[c.ms.length - 1].created_at), s0 = Date.parse(s.ms[0].created_at);
      if (s0 - cEnd > 48 * H) { dropped.slow++; continue; }
      if (nowMs - s0 < 30 * D) { dropped.young++; continue; }
      // 申込（推定も含む）より後は対象外
      const apAny = firstBefore(applyAny.get(cid), s0); if (apAny != null) { dropped.postApply++; continue; }
      const reply = s.ms.filter((m) => Date.parse(m.created_at) - s0 <= 3 * H);
      const staffText = reply.map((m) => m.text ?? "").join("\n");
      const shape = replyShapeOf(staffText); if (!shape) { dropped.noShape++; continue; }
      const scene = sceneAt(s0, { propertySentAt: firstBefore(propEv.get(cid), s0), viewingAt: firstBefore(viewEv.get(cid), s0), appliedAt: null });
      if (!scene) continue;
      const now = classifyCustomerBurst(c.ms.map((m) => m.text));
      const view14 = anyIn(viewEv.get(cid), s0, s0 + 14 * D);
      const apply30 = anyIn(applyEv.get(cid), s0, s0 + 30 * D);
      const sEnd = Date.parse(s.ms[s.ms.length - 1].created_at);
      const n = runs[i + 2]; const reply7 = !!n && Date.parse(n.ms[0].created_at) - sEnd <= 7 * D;
      const progress = scene === "viewing" ? apply30 : view14 || apply30;
      turns.push({ cid, at: s0, scene, shape, now, lag: lagBucket(s0 - cEnd), acct: meta.get(cid)?.account ?? "?", eng: engBucket(custBursts),
        view14, apply30, reply7, progress, staffText, custText: c.ms.map((m) => m.text ?? "").join("\n"), name: meta.get(cid)?.customer_name ?? null });
    }
  }
  if (has("no-proceed")) { const k = turns.length; turns.splice(0, turns.length, ...turns.filter((t) => t.now !== "proceed")); console.log(`（感度の確かめ: お客様の番が「内覧・申込へ進む」の番を外した ${k - turns.length}）`); }
  turns.sort((a, b) => a.at - b.at);
  const cut = turns[Math.floor(turns.length * SPLIT)]?.at ?? 0;
  const old = turns.filter((t) => t.at < cut), neu = turns.filter((t) => t.at >= cut);
  const d = (t: number) => new Date(t + 9 * H).toISOString().slice(0, 10);
  console.log(`番: ${turns.length}（会話 ${new Set(turns.map((t) => t.cid)).size}・${turns.length ? d(turns[0].at) : "-"}〜${turns.length ? d(turns[turns.length - 1].at) : "-"}）・外した ${JSON.stringify(dropped)}`);
  console.log(`古い ${old.length}／新しい ${new Set(neu.map((t) => t.cid)).size}会話 ${neu.length}（${d(cut)} 以降）`);
  for (const sc of OUTCOME_SCENES) { const g = turns.filter((t) => t.scene === sc); console.log(`  ${OUTCOME_SCENE_JA[sc]}: ${g.length}番・進んだ ${pct(g.filter((t) => t.progress).length, g.length)}・内覧14日 ${pct(g.filter((t) => t.view14).length, g.length)}・申込30日 ${pct(g.filter((t) => t.apply30).length, g.length)}・返事7日 ${pct(g.filter((t) => t.reply7).length, g.length)}`); }
  const shapeDist = REPLY_SHAPES.map((s) => `${s} ${turns.filter((t) => t.shape === s).length}`).join("・");
  console.log(`形の数: ${shapeDist}`);

  if (has("examples")) {
    console.log("\n── 形の見本（伏せた文・申込の書類と個人の値の通は出さない）");
    for (const s of REPLY_SHAPES) {
      const xs = turns.filter((t) => t.shape === s && !applicationMaterialReason(t.staffText) && !piiValueSignal(t.staffText)).slice(-200);
      for (const t of xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / 2)) === 0).slice(0, 2)) {
        const names = addressNamesOf([t.staffText]);
        console.log(`[${s}] ${maskExamText(t.staffText, t.name, names).replace(/\s+/g, " ").slice(0, 110)}`);
      }
    }
  }

  const all3 = cellStats(turns), so = cellStats(old), sn = cellStats(neu);
  const get = (xs: CellStat[], sc: string, sh: string) => xs.find((c) => c.scene === sc && c.shape === sh);
  console.log("\n── 段階 × 返し方 → 進んだ（同じ層の平均との差 pt・90%幅）｜古い側の差｜新しい側の差");
  const pairs: Array<[number, number, number]> = [];
  for (const sc of OUTCOME_SCENES) {
    console.log(`■ ${OUTCOME_SCENE_JA[sc]}`);
    for (const c of all3.filter((x) => x.scene === sc).sort((a, b) => b.lift - a.lift)) {
      const o = get(so, sc, c.shape), nn = get(sn, sc, c.shape);
      const sig = c.lo > 0 || c.hi < 0 ? "＊" : " ";
      console.log(`  ${sig}${REPLY_SHAPE_JA[c.shape].padEnd(18)} ${String(c.n).padStart(4)}番/${String(c.convs).padStart(3)}会話 進む ${pct(c.progress * c.n, c.n).padStart(6)} 差 ${pp(c.lift).padStart(6)}（${pp(c.lo)}〜${pp(c.hi)}）｜古 ${o ? `${pp(o.lift)}(${o.n})` : "-"}｜新 ${nn ? `${pp(nn.lift)}(${nn.n})` : "-"}｜返事7日 ${pct(c.reply7 * c.n, c.n)}`);
      if (o && nn && o.n >= 15 && nn.n >= 15) pairs.push([o.lift, nn.lift, Math.min(o.n, nn.n)]);
    }
  }
  const agree = pairs.filter(([a, b]) => Math.sign(a) === Math.sign(b));
  const wAgree = agree.reduce((s, p) => s + p[2], 0) / Math.max(1, pairs.reduce((s, p) => s + p[2], 0));
  console.log(`\n── 時間で分けた確かめ（両側 15番以上のマス ${pairs.length}）: 向きが同じ ${agree.length}/${pairs.length}（数で重み ${(wAgree * 100).toFixed(0)}%）・順位の相関 ${spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1])).toFixed(2)}`);
  // 古い側で幅が 0 をまたがなかったマスが、新しい側でどうだったか
  const strongOld = so.filter((c) => c.n >= 30 && (c.lo > 0 || c.hi < 0));
  for (const c of strongOld) { const nn = get(sn, c.scene, c.shape); console.log(`  古い側で確か: ${OUTCOME_SCENE_JA[c.scene]}×${REPLY_SHAPE_JA[c.shape]} 古 ${pp(c.lift)}(${c.n}) → 新 ${nn ? `${pp(nn.lift)}(${nn.n}・幅 ${pp(nn.lo)}〜${pp(nn.hi)})` : "-"}`); }
  // 新しい側で、古い側の差で並べた上位半分と下位半分の進んだ割合（揃えた差）
  for (const sc of OUTCOME_SCENES) {
    const ranked = so.filter((c) => c.scene === sc && c.n >= 15).sort((a, b) => b.lift - a.lift);
    if (ranked.length < 4) continue;
    const half = Math.floor(ranked.length / 2); const topS = new Set(ranked.slice(0, half).map((c) => c.shape)), botS = new Set(ranked.slice(-half).map((c) => c.shape));
    const exp = expectations(neu); const r = neu.map((t, i) => ({ t, res: +t.progress - exp[i] })).filter((x) => x.t.scene === sc);
    const m = (f: (s: ReplyShape) => boolean) => { const g = r.filter((x) => f(x.t.shape)); return { n: g.length, raw: g.filter((x) => x.t.progress).length / Math.max(1, g.length), res: g.reduce((a, x) => a + x.res, 0) / Math.max(1, g.length) }; };
    const a = m((s) => topS.has(s)), b = m((s) => botS.has(s));
    console.log(`  ${OUTCOME_SCENE_JA[sc]}: 古い側の上位の形（${[...topS].join(",")}）は新しい側で 進む ${(a.raw * 100).toFixed(1)}%・差 ${pp(a.res)}（${a.n}番）／下位（${[...botS].join(",")}）${(b.raw * 100).toFixed(1)}%・差 ${pp(b.res)}（${b.n}番）`);
  }

  if (has("write-table")) {
    const cells: OutcomeCell[] = all3.filter((c) => c.n >= 10).map((c) => {
      const o = get(so, c.scene, c.shape), nn = get(sn, c.scene, c.shape);
      // 選ぶのは古い側だけ（古い側で 30番以上・幅が 0 をまたがない）→ 新しい側は確かめだけ（同じ向きか）。
      //   新しい側で選ぶと確かめが選びに混ざって甘くなる（2026-10-21 レビュー）。古い側で確かでないマスは null（出さない）
      const oldSure = !!o && o.n >= 30 && (o.lo > 0 || o.hi < 0);
      const held = oldSure && nn && nn.n >= 15 ? Math.sign(o!.lift) === Math.sign(nn.lift) && Math.sign(c.lift) === Math.sign(o!.lift) : null;
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      return { scene: c.scene, shape: c.shape, n: c.n, convs: c.convs, progress: r3(c.progress), view14: r3(c.view14), apply30: r3(c.apply30), reply7: r3(c.reply7), lift: r3(c.lift), lo: r3(c.lo), hi: r3(c.hi), held };
    }).sort((a, b) => a.scene.localeCompare(b.scene) || b.lift - a.lift);
    const table: OutcomeTable = { builtAt: new Date().toISOString().slice(0, 10), days: DAYS, turns: turns.length, outcome: "progress", cells };
    const file = path.join(__dirname, "..", "app", "lib", "reply-outcome-table-data.ts");
    const body = `// app/lib/reply-outcome-table-data.ts — scripts/audit-reply-outcome.ts --write-table が書く（手で直さない・数だけ）\nimport type { OutcomeTable } from "./reply-outcome-learn";\nexport const REPLY_OUTCOME_TABLE: OutcomeTable = ${JSON.stringify(table).replace(/\},\{/g, "},\n  {")};\n`;
    fs.writeFileSync(file, body, "utf8");
    console.log(`\n書いた: ${file}（${cells.length}マス）`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
