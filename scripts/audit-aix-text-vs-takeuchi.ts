// scripts/audit-aix-text-vs-takeuchi.ts — AIX の生成文と竹内さんが実際に送った文の「ずれ」をボタン×ピッカーごとに数える（読むだけ・LLM なし）
//
// 2026-10-13 竹内「AIX テンプレートで文が生成される所の文の質が今悪いので、実際に竹内が送っているのと比べてずれている部分や、
//   ちゃんと届いていない部分を改善する」。物差しは竹内さんの LINE の実送信だけ（messages.staff_writer='takeuchi'・設計知見 3b508208・ce349a3f）。
//
// 組にする物（3つの道）:
//   A. AIX の本文（aix/action）: 押下 aix_usage_logs → 押下の前60分の最後の生成 aix_generate_log（source≠aix-template-generate）
//      → 送った文 aix_usage_logs.generated_text（画面が実際に送った文）・書き手は line_message_id の messages.staff_writer
//   B. ✨この会話に合った文（aix-template-generate）と 🟣テンプレの最適化（generate-reply）: template_selection_logs.adapted_text → final_sent_text
//      書き手は送った時刻の前後3分の同じ文の messages.staff_writer
//   ※ 固定の雛形だけの経路（見積書の1通目の費用の文 等）も A に入る（生成＝雛形）。ずれは「スタッフがどこを直したか」
// ずれの型（1組に複数）:
//   事実の取り違え（生成の数字・号室・日付・時刻・金額が送った文に無く、送った文に別の値がある）／ピッカーの値が文に無い（押下の物件名・待ち合わせの日時が生成に無い）
//   ブレインの向きと違う締め（その時のブレインの判断の方向 digest.dir の内覧/申込/見積と、生成の締めが食い違い、竹内さんの締めはブレイン側）
//   言い回し（同じ位置の文の言い換え）／余計な文（生成だけの文＝竹内さんが消した）／足りない文（竹内さんだけの文＝足した）／冒頭・挨拶・締めの型の違い
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-text-vs-takeuchi.ts [--days=60] [--samples=3] [--action=property_send] [--json=out.json] [--writer=takeuchi|all]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { diffTexts, coreOf, dice } from "../app/lib/text-diff-types";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60"));
const SAMPLES = Number(arg("samples", "0"));
const ONLY = arg("action", "");
const JSON_OUT = arg("json", "");
const WRITER = arg("writer", "takeuchi");
const SINCE = new Date(Date.now() - DAYS * 86400e3).toISOString();
const ms = (s: string) => Date.parse(s);

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 300_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}

type Press = { id: string; conversation_id: string; aix_type: string; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; created_at: string; sent_at: string | null; generated_text: string | null; was_edited: boolean | null; line_message_id: string | null; property_names: string[] | null; picker_choices: Record<string, unknown> | null; conversation_match: boolean | null };
type Gen = { conversation_id: string; action_type: string; generated_text: string | null; generated_at: string; check_pattern: string | null; conditions_snapshot: Record<string, unknown> | null };
type Tsl = { id: string; conversation_id: string; created_at: string; aix_action_type: string | null; picker_mode: string | null; adapted_text: string | null; final_sent_text: string | null; open_context: string | null; was_modified_after_adapt: boolean | null };
type Brain = { conversation_id: string; created_at: string; digest: Record<string, unknown> | null; suggested_action: string | null };

// 事実の型（数字の持つ意味ごと）
const FACT_RES: Array<[string, RegExp]> = [
  ["日付", /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/g], ["時刻", /(\d{1,2})[:：](\d{2})/g], ["金額", /([\d,]{3,})\s*円/g],
  ["号室", /(\d{2,4})\s*号室/g], ["徒歩", /徒歩\s*(\d{1,2})\s*分/g], ["件数", /(\d{1,2})\s*件/g], ["階", /(\d{1,2})\s*階/g],
];
function factsOf(t: string): Map<string, Set<string>> {
  const s = String(t ?? "").normalize("NFKC");
  const out = new Map<string, Set<string>>();
  for (const [k, re] of FACT_RES) { const set = new Set<string>(); for (const m of s.matchAll(re)) set.add(m.slice(1).filter(Boolean).map((x) => x.replace(/,/g, "").replace(/^0+(?=\d)/, "")).join("/")); if (set.size) out.set(k, set); }
  return out;
}
/** 生成にあって送った文に無い値で、送った文が同じ種類の別の値を持つ＝取り違え（直された事実） */
function factSwaps(gen: string, sent: string): string[] {
  const g = factsOf(gen), s = factsOf(sent); const out: string[] = [];
  for (const [k, gs] of g) { const ss = s.get(k); if (!ss) continue; for (const v of gs) if (!ss.has(v)) out.push(`${k}:${v}→${[...ss].filter((x) => !gs.has(x)).join("|") || "?"}`); }
  return out;
}
const lastLine = (t: string) => (String(t ?? "").trim().split("\n").map((x) => x.trim()).filter(Boolean).pop() ?? "").normalize("NFKC");
function closeKind(t: string): string {
  const s = String(t ?? "").normalize("NFKC"); const tail = s.split("\n").slice(-3).join("\n");
  if (/お申込み?(?:し|で)?(?:て)?お部屋(?:を)?(?:抑|押)|お申込み?(?:は|の方)?(?:如何|いかが)/.test(tail)) return "申込";
  if (/ご都合(?:の)?よろしい|ご内覧|ご案内させて|内覧(?:可能|できる|出来る)/.test(tail)) return "内覧";
  if (/ご査収/.test(tail)) return "査収";
  if (/お気軽に/.test(tail)) return "お気軽に";
  if (/何卒|よろしくお願い/.test(tail)) return "何卒";
  return "なし";
}
function brainCloseKind(dir: string): string {
  const s = String(dir ?? "");
  if (/申込|お申込み|抑え/.test(s)) return "申込"; if (/内覧|ご案内/.test(s)) return "内覧"; if (/見積/.test(s)) return "査収"; return "";
}
// 消した／足した文の中身の札（ブレインのどの判断に当たるか: 挨拶=約束の台帳（お待たせ）・時刻／締め=方向・訴求のタイミング／
//   約束の行=turn_contract／退去・内覧=property_state／新着=行動台帳（送った件数・新着か）／訴求の箇条=お客様の希望（preferences）／条件=条件の行）
const BINS: Array<[string, RegExp]> = [
  ["挨拶", /お世話になっております|お待たせ致しました|夜分遅く|失礼致します/],
  ["新着・募集に出た", /新着|募集に(?:出|で)ました|かなり条件のいいお部屋/],
  ["締め(申込/内覧/査収)", /お申込み?(?:し|で)?お部屋|ご都合(?:の)?よろしい|ご案内させて|ご査収|お気軽に/],
  ["約束(確認・交渉します)", /(?:確認|交渉|お探し|ピックアップ)(?:させて|致し)(?:頂|いただ)きます/],
  ["退去予定・内覧可否", /退去予定|ご?内覧(?:可能|出来|でき)|現況|即入居|入居可能/],
  ["見積・費用", /見積|初期費用|割引/],
  ["条件・エリアの行", /全域から|周辺から|ご条件に(?:近い|合った)|ご希望の/],
  ["訴求の箇条(・)", /^・/],
  ["状況の説明(探した結果・申込あり等)", /募集が(?:現在)?ない|お申込(?:み)?が(?:入|はい)|2番手|のみとなります|全て確認|ございませんでした|御座いま/],
];
const pickerOf = (p: Press) => p.check_pattern ?? p.app_sub_mode ?? p.send_mode ?? (p.picker_choices && typeof p.picker_choices.estimate_count === "string" ? `est:${p.picker_choices.estimate_count}` : "");

type Row = {
  route: "aix/action" | "template"; key: string; picker: string; conv: string; at: string; writer: string;
  gen: string; sent: string; same: boolean; sameCore: boolean; sim: number;
  types: string[]; swaps: string[]; pickerMiss: string[]; brainDir: string; brainClose: string; genClose: string; sentClose: string; brainCloseMiss: boolean;
  added: string[]; removed: string[]; paraphrase: number; staffOnlyInAdded: number; genSource: string;
};

(async () => {
  const [presses, gens, tsls] = await Promise.all([
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("id, conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, created_at, sent_at, generated_text, was_edited, line_message_id, property_names, picker_choices, conversation_match").gte("created_at", SINCE).order("created_at").range(f, t)),
    readAll<Gen>((f, t) => sb.from("aix_generate_log").select("conversation_id, action_type, generated_text, generated_at, check_pattern, conditions_snapshot").gte("generated_at", new Date(ms(SINCE) - 3600e3).toISOString()).not("generated_text", "is", null).order("generated_at").range(f, t)),
    readAll<Tsl>((f, t) => sb.from("template_selection_logs").select("id, conversation_id, created_at, aix_action_type, picker_mode, adapted_text, final_sent_text, open_context, was_modified_after_adapt").gte("created_at", SINCE).not("adapted_text", "is", null).not("final_sent_text", "is", null).order("created_at").range(f, t)),
  ]);
  const real = (c: string) => !!c && !isTestConversation(c);
  const ps = presses.filter((p) => real(p.conversation_id) && (!ONLY || p.aix_type === ONLY));
  const gensBy = new Map<string, Gen[]>(); for (const g of gens) { const k = `${g.conversation_id}|${g.action_type}`; if (!gensBy.has(k)) gensBy.set(k, []); gensBy.get(k)!.push(g); }
  // 書き手（line_message_id → messages）
  const lineIds = [...new Set(ps.map((p) => p.line_message_id).filter(Boolean))] as string[];
  const writerByLine = new Map<string, string>();
  for (let i = 0; i < lineIds.length; i += 300) {
    const { data } = await sb.from("messages").select("line_message_id, staff_writer").in("line_message_id", lineIds.slice(i, i + 300));
    for (const m of (data ?? []) as Array<{ line_message_id: string; staff_writer: string | null }>) writerByLine.set(m.line_message_id, m.staff_writer ?? "不明");
  }
  // ブレインの判断（押下の前の最後）
  const convs = [...new Set([...ps.map((p) => p.conversation_id), ...tsls.map((t) => t.conversation_id)].filter(real))];
  const brainsBy = new Map<string, Brain[]>();
  for (let i = 0; i < convs.length; i += 100) {
    const rows = await readAll<Brain>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, digest, suggested_action").in("conversation_id", convs.slice(i, i + 100)).gte("created_at", new Date(ms(SINCE) - 7 * 86400e3).toISOString()).order("created_at").range(f, t));
    for (const b of rows) { if (!brainsBy.has(b.conversation_id)) brainsBy.set(b.conversation_id, []); brainsBy.get(b.conversation_id)!.push(b); }
  }
  const brainAt = (conv: string, t: number) => (brainsBy.get(conv) ?? []).filter((b) => ms(b.created_at) <= t).pop() ?? null;
  // スタッフの文（書き手のための template の照合）
  async function writerOfText(conv: string, at: number, text: string): Promise<string> {
    const { data } = await sb.from("messages").select("text, staff_writer, created_at").eq("conversation_id", conv).neq("sender", "customer").gte("created_at", new Date(at - 10 * 60e3).toISOString()).lte("created_at", new Date(at + 10 * 60e3).toISOString());
    const best = ((data ?? []) as Array<{ text: string | null; staff_writer: string | null }>).map((m) => ({ m, s: dice(coreOf(m.text ?? ""), coreOf(text)) })).sort((a, b) => b.s - a.s)[0];
    return best && best.s >= 0.8 ? (best.m.staff_writer ?? "不明") : "照合なし";
  }

  const rows: Row[] = [];
  const skip: Record<string, number> = {};
  const bump = (k: string) => { skip[k] = (skip[k] ?? 0) + 1; };
  for (const p of ps) {
    const sent = String(p.generated_text ?? "").trim();
    if (!sent) { bump("送った文なし（予約・未記録）"); continue; }
    const pt = ms(p.sent_at ?? p.created_at);
    const cand = (gensBy.get(`${p.conversation_id}|${p.aix_type}`) ?? []).filter((g) => ms(g.generated_at) <= pt + 60e3 && ms(g.generated_at) >= pt - 60 * 60e3 && (g.conditions_snapshot?.source ?? "") !== "aix-template-generate");
    if (!cand.length) { bump(`生成の記録なし(${p.aix_type})`); continue; }
    // 同じ押下の前に複数版があれば送った文に一番近い版（スタッフが選び直した版）
    const g = cand.map((x) => ({ x, s: dice(coreOf(x.generated_text ?? ""), coreOf(sent)) })).sort((a, b) => b.s - a.s || ms(b.x.generated_at) - ms(a.x.generated_at))[0].x;
    const gen = String(g.generated_text ?? "").trim();
    const writer = p.line_message_id ? (writerByLine.get(p.line_message_id) ?? "不明") : "不明";
    if (WRITER !== "all" && writer !== WRITER) { bump(`書き手=${writer}`); continue; }
    rows.push(makeRow("aix/action", p.aix_type, pickerOf(p) || "-", p.conversation_id, p.created_at, writer, gen, sent, p, brainAt(p.conversation_id, pt), String(g.conditions_snapshot?.source ?? "")));
  }
  for (const t of tsls) {
    if (!real(t.conversation_id) || !t.aix_action_type) continue;
    if (ONLY && t.aix_action_type !== ONLY) continue;
    const gen = String(t.adapted_text ?? "").trim(), sent = String(t.final_sent_text ?? "").trim();
    if (!gen || !sent) continue;
    const writer = await writerOfText(t.conversation_id, ms(t.created_at), sent);
    if (WRITER !== "all" && writer !== WRITER) { bump(`テンプレ 書き手=${writer}`); continue; }
    rows.push(makeRow("template", `✨/🟣:${t.aix_action_type}`, t.picker_mode ?? "-", t.conversation_id, t.created_at, writer, gen, sent, null, brainAt(t.conversation_id, ms(t.created_at)), t.open_context ?? ""));
  }

  function makeRow(route: Row["route"], key: string, picker: string, conv: string, at: string, writer: string, gen: string, sent: string, p: Press | null, b: Brain | null, genSource: string): Row {
    const d = diffTexts(gen, sent);
    const swaps = factSwaps(gen, sent);
    const pickerMiss: string[] = [];
    if (p) {
      const g = gen.normalize("NFKC").replace(/\s/g, "");
      for (const n of (p.property_names ?? []).filter(Boolean)) { const b0 = n.normalize("NFKC").replace(/\s/g, "").replace(/\d{2,4}号?室?$/, ""); if (b0.length >= 3 && !g.includes(b0.slice(0, Math.min(6, b0.length)))) pickerMiss.push(`物件名:${n}`); }
      const pc = p.picker_choices ?? {};
      for (const k of ["meeting_date", "meeting_time"]) { const v = String((pc as Record<string, unknown>)[k] ?? "").normalize("NFKC"); if (v && !g.includes(v.replace(/\s/g, ""))) pickerMiss.push(`${k}:${v}`); }
    }
    const dir = String(b?.digest?.dir ?? "");
    const bc = brainCloseKind(dir); const gc = closeKind(gen); const sc = closeKind(sent);
    const staffOnlyInAdded = d.detail.added.filter((x) => /確認|募集|管理会社|見積|内覧|日程|空き/.test(x)).length;
    return {
      route, key, picker, conv, at, writer, gen, sent, same: d.same, sameCore: d.sameCore, sim: d.sim, types: d.types, swaps, pickerMiss,
      brainDir: dir.slice(0, 120), brainClose: bc, genClose: gc, sentClose: sc, brainCloseMiss: !!bc && gc !== sc && sc === bc,
      added: d.detail.added, removed: d.detail.removed, paraphrase: d.detail.paraphrase.length, staffOnlyInAdded, genSource,
    };
  }

  // ── 表 ──
  const by = new Map<string, Row[]>();
  for (const r of rows) { const k = `${r.route === "template" ? r.key : r.key}｜${r.picker}`; if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  console.log(`# AIX の生成文 × 竹内さんの実送信（直近${DAYS}日・書き手=${WRITER}）組 ${rows.length}`);
  console.log(`除外: ${Object.entries(skip).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log("ボタン｜ピッカー｜組｜そのまま｜芯が同じ｜似ている度｜事実の取り違え｜ピッカーの値なし｜ブレイン側の締めに直した｜余計な文｜足りない文｜言い回し｜冒頭｜挨拶｜締めの語尾");
  const total: Record<string, number> = {};
  const lines: Array<[number, string]> = [];
  for (const [k, rs] of by) {
    const n = rs.length;
    const c = (f: (r: Row) => boolean) => rs.filter(f).length;
    const vals = {
      same: c((r) => r.same), core: c((r) => r.sameCore), swap: c((r) => r.swaps.length > 0), pmiss: c((r) => r.pickerMiss.length > 0), bclose: c((r) => r.brainCloseMiss),
      rem: c((r) => r.removed.length > 0), add: c((r) => r.added.length > 0), para: c((r) => r.paraphrase > 0), op: c((r) => r.types.includes("opener")), gr: c((r) => r.types.includes("greeting")), end: c((r) => r.types.includes("ending")),
    };
    for (const [kk, v] of Object.entries(vals)) total[kk] = (total[kk] ?? 0) + v;
    const sim = rs.reduce((a, r) => a + r.sim, 0) / n;
    lines.push([n, `${k}｜${n}｜${pct(vals.same, n)}｜${pct(vals.core, n)}｜${sim.toFixed(2)}｜${vals.swap}｜${vals.pmiss}｜${vals.bclose}｜${vals.rem}｜${vals.add}｜${vals.para}｜${vals.op}｜${vals.gr}｜${vals.end}`]);
  }
  for (const [, l] of lines.sort((a, b) => b[0] - a[0])) console.log(l);
  console.log(`合計｜${rows.length}｜${pct(total.same, rows.length)}｜${pct(total.core, rows.length)}｜-｜${total.swap}｜${total.pmiss}｜${total.bclose}｜${total.rem}｜${total.add}｜${total.para}｜${total.op}｜${total.gr}｜${total.end}`);

  if (SAMPLES > 0) {
    for (const [k, rs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
      const bad = rs.filter((r) => !r.same).sort((a, b) => a.sim - b.sim).slice(0, SAMPLES);
      if (!bad.length) continue;
      console.log(`\n━━ ${k}（${rs.length}組・直した ${rs.filter((r) => !r.same).length}）`);
      for (const r of bad) {
        console.log(`－ ${r.at.slice(0, 16)} conv=${r.conv.slice(0, 8)} 似 ${r.sim} 型 ${r.types.join(",")}${r.swaps.length ? ` 取り違え ${r.swaps.join(" ")}` : ""}${r.pickerMiss.length ? ` ピッカーなし ${r.pickerMiss.join(" ")}` : ""} 締め 生成=${r.genClose} 竹内=${r.sentClose} ブレイン=${r.brainClose || "-"}（${r.brainDir.slice(0, 60)}）`);
        console.log(`  生成: ${r.gen.replace(/\n+/g, "／").slice(0, 260)}`);
        console.log(`  竹内: ${r.sent.replace(/\n+/g, "／").slice(0, 260)}`);
        if (r.removed.length) console.log(`  消した: ${r.removed.join(" ｜ ").slice(0, 200)}`);
        if (r.added.length) console.log(`  足した: ${r.added.join(" ｜ ").slice(0, 200)}`);
      }
    }
  }
  // ── 画面の was_edited（生成の記録が無い固定の雛形の経路も含む・竹内さんの送信だけ）──
  {
    const m = new Map<string, { n: number; ed: number; un: number }>();
    for (const p of ps) {
      const w = p.line_message_id ? (writerByLine.get(p.line_message_id) ?? "不明") : "不明";
      if (WRITER !== "all" && w !== WRITER) continue;
      const k = `${p.aix_type}｜${pickerOf(p) || "-"}`; const e = m.get(k) ?? { n: 0, ed: 0, un: 0 };
      e.n++; if (p.was_edited === true) e.ed++; else if (p.was_edited === false) e.un++; m.set(k, e);
    }
    console.log(`\n# 画面の「直して送った」（was_edited・固定の雛形の経路を含む）`);
    console.log("ボタン｜ピッカー｜押下｜直した｜そのまま｜直した割合");
    for (const [k, e] of [...m].sort((a, b) => b[1].n - a[1].n)) if (e.n >= 3) console.log(`${k}｜${e.n}｜${e.ed}｜${e.un}｜${pct(e.ed, e.ed + e.un)}`);
  }
  // ── 消した・足した文の中身（どの材料＝ブレインのどの判断に当たるか）──
  console.log(`\n# 竹内さんが消した文（余計）・足した文（足りない）の中身 — 列: 消した/足した の組数`);
  console.log(`ボタン｜${BINS.map(([k]) => k).join("｜")}`);
  for (const [k, rs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
    if (rs.length < 3) continue;
    const cells = BINS.map(([, re]) => `${rs.filter((r) => r.removed.some((x) => re.test(x))).length}/${rs.filter((r) => r.added.some((x) => re.test(x))).length}`);
    console.log(`${k}（${rs.length}）｜${cells.join("｜")}`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ since: SINCE, rows }, null, 1));
})().catch((e) => { console.error(e); process.exitCode = 1; });
