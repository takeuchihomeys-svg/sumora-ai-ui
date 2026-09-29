// scripts/audit-recommend-vs-score.ts
// スタッフが実際にお客様へ送った物件（🌟物件オススメ・物件ピックアップ・画像）と、その回の採点（点・札・順位・👑）を結び、
// 「採点のズレ」を数える（読むだけ・DB に書かない・LLM を呼ばない）。純関数は app/lib/recommend-score-drift.ts。
//
// 2026-09-28 竹内「実際どの物件をオススメでスタッフは送っているかで、そこの特徴、お客さん毎に対してどこの点を訴求するかの部分
//   併せて、お客さんの条件に対してのスコアリングのズレを見つける（お客さん毎に何か、特にこだわり条件が強い場合スコアリングの
//   加点が変わる、そこの率を分析するのと、分析する為の仕組を作る）」。重みを直すのはまだ（竹内さんの判断）。
//
// ■ 材料（正解＝スタッフが選んで送った事実。お客様の返信の有無は使わない）
//   pickup   … 売上サポ（property_pickups）の回。採点は保存そのまま（点＝判定＋画像の加点・札・complete_rank・👑＝まとめの best_id）。
//              選んだ物＝その回の後 72時間以内にお客様に届いた送付（sent_properties のお客様の行・pickup_id か同じ物件）か status=sent
//   snapshot … 🌟を送った時点の候補（recommendation_snapshots）。点は今の判定で付け直し（scoring-learning と同じ組み立て）。選んだ物＝🌟
//   pool     … 拡張の回（property_candidate_pools）を付け直し（--pool の時だけ・材料が薄く全部同点が多い）
//   こだわりの強さ … その回の時点の条件（property_condition_history で戻す）・その回より前 60日のお客様の発言・言い直し
//   訴求 … 🌟の本文（recommendation_snapshots.star_text）。売上サポの回は同じ会話で 72時間以内の🌟／AIX 物件ピックアップの文
// ■ 個人情報: お客様は会話 ID の先頭8文字だけ。お客様の発言・名前は出さない（物件名は出す）
// ■ YUMA（テスト用の会話）は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-recommend-vs-score.ts [--days=180] [--pool] [--show=3] [--out=path.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { loadEpisodes } from "../app/lib/scoring-learning-server";
import { customerAt, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { overallPoints } from "../app/lib/pickup-best";
import { isSameProperty } from "../app/lib/sent-property-record";
import { isCustomerRow, rowChannel } from "../app/lib/sent-delivery";
import { isTestConversation, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { TOPIC_LABEL, starHeadOf, factTopics } from "../app/lib/recommendation-gaps";
import { factsFromPickup } from "../app/lib/recommendation-snapshot-server";
import { deriveFacts, type CandidateFacts } from "../app/lib/candidate-facts";
import {
  roundOutcome, familyDrift, summarizeRounds, customerStrength, strengthLevelOf, strengthLevelOfTopic, appealVsScore, familiesOf, familyJa, topicFamily, topicFactDrift,
  type DriftRound, type DriftCand, type CustomerStrength,
} from "../app/lib/recommend-score-drift";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const SHOW = parseInt(String(args.show ?? "3"), 10);
const WITH_POOL = !!args.pool;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const H = 3600_000, D = 24 * H;
const WINDOW = 72 * H;

async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);
const pct = (x: number | null | undefined) => (x == null ? "-" : `${Math.round(x * 100)}%`);
const short = (id: unknown) => String(id ?? "").slice(0, 8) || "?";

type Meta = { round: DriftRound; customerId: string | null; conversationId: string | null; appealChannel: string | null; rawFacts: Array<CandidateFacts | null> };
const normRoom = (r: unknown) => String(r ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim();

async function main() {
  const until = Date.now();
  const sinceIso = new Date(until - DAYS * D).toISOString();
  const metas: Meta[] = [];
  const counts: Record<string, number> = {};

  // YUMA の物件顧客
  const yumaCust = new Set<string>();
  { const { data } = await sb.from("conversations").select("property_customer_id").eq("id", YUMA_CONVERSATION_ID).maybeSingle(); if (data?.property_customer_id) yumaCust.add(String(data.property_customer_id)); }

  // ── ① 売上サポの回（採点は保存そのまま） ────────────────────────────────────
  const pk = (await all((a, b) => sb.from("property_pickups").select("id, created_at, batch_id, complete_group_id, complete_rank, rank, property_customer_id, conversation_id, property_name, room_no, score, reason_codes, image_analysis, verdict, recommended, status, sent_at").gte("created_at", sinceIso).order("id").range(a, b) as never))
    .filter((r) => !isTestConversation(r.conversation_id) && !yumaCust.has(String(r.property_customer_id ?? "")));
  counts.pickup_rows = pk.length;
  const comps = await all((a, b) => sb.from("property_pickup_completions").select("group_id, best_id").range(a, b) as never);
  const bestOf = new Map(comps.map((c) => [String(c.group_id), c.best_id as number | null]));
  const pcIds = [...new Set(pk.map((r) => r.property_customer_id).filter(Boolean))] as string[];
  const convIds = [...new Set(pk.map((r) => r.conversation_id).filter(Boolean))] as string[];
  const earliest = pk.length ? new Date(Math.min(...pk.map((r) => Date.parse(r.created_at))) - H).toISOString() : sinceIso;
  const sends: Row[] = [];
  for (const c of chunks(pcIds, 60)) sends.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, conversation_id, property_name, room_no, source, channel, delivery, sent_at, pickup_id").in("property_customer_id", c).gte("sent_at", earliest).range(a, b) as never));
  for (const c of chunks(convIds, 60)) sends.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, conversation_id, property_name, room_no, source, channel, delivery, sent_at, pickup_id").in("conversation_id", c).gte("sent_at", earliest).range(a, b) as never));
  const custSends = sends.filter(isCustomerRow);
  // 🌟の本文・AIX 物件ピックアップの文（売上サポの回の訴求）
  const snapsRecent: Row[] = [];
  for (const c of chunks(convIds, 60)) snapsRecent.push(...await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, sent_at, star_name, star_room, star_text").in("conversation_id", c).gte("sent_at", earliest).range(a, b) as never));
  const aixSends: Row[] = [];
  for (const c of chunks(convIds, 60)) aixSends.push(...await all((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, generated_text").in("conversation_id", c).eq("aix_type", "property_send").not("sent_at", "is", null).gte("sent_at", earliest).range(a, b) as never));

  const groups = new Map<string, Row[]>();
  for (const r of pk) { const k = r.complete_group_id ?? `b:${r.batch_id}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  // 同じお客様の次の回が始まるまでを窓にする（次の回の物件を前の回の選択に数えない）
  const startsByCust = new Map<string, number[]>();
  for (const [, rows] of groups) { const pc = String(rows[0].property_customer_id ?? rows[0].conversation_id); const t0 = Math.min(...rows.map((r) => Date.parse(r.created_at))); (startsByCust.get(pc) ?? startsByCust.set(pc, []).get(pc)!).push(t0); }
  for (const [gid, rows] of groups) {
    const pc = rows[0].property_customer_id as string | null, cv = rows[0].conversation_id as string | null;
    const t0 = Math.min(...rows.map((r) => Date.parse(r.created_at)));
    const t1 = Math.max(...rows.map((r) => Date.parse(r.created_at)));
    const nextStart = (startsByCust.get(String(pc ?? cv)) ?? []).filter((t) => t > t1).sort((a, b) => a - b)[0] ?? Infinity;
    const end = Math.min(t0 + WINDOW, nextStart);
    const win = custSends.filter((s) => ((pc && s.property_customer_id === pc) || (cv && s.conversation_id === cv)) && Date.parse(s.sent_at) >= t0 - 10 * 60_000 && Date.parse(s.sent_at) <= end);
    const best = gid.startsWith("b:") ? null : bestOf.get(gid) ?? null;
    const cands: Array<DriftCand & { _row: Row }> = rows.map((r) => {
      const codes = (parse(r.reason_codes) ?? []) as string[];
      const room = r.room_no ? String(r.room_no) : null;
      const hit = win.filter((s) => s.pickup_id === r.id || isSameProperty({ property_name: r.property_name, room_no: room }, { property_name: s.property_name, room_no: s.room_no }));
      const sent = r.status === "sent" || hit.length > 0;
      const vias = [...new Set(hit.map((s) => rowChannel(s) ?? "other"))];
      return {
        key: `${r.property_name}${room ? ` ${room}` : ""}`,
        score: overallPoints({ score: r.score, reason_codes: codes, image_analysis: parse(r.image_analysis) }),
        codes, chosen: sent, crown: best != null && r.id === best, rank: r.complete_rank ?? r.rank ?? null,
        via: sent ? (vias.length ? vias.sort().join("+") : "pickup") : null,
        _row: r,
      } as DriftCand & { _row: Row };
    });
    // 同じ物件の2行（リアプロと itandi で同じ部屋）は点の高い方だけ残す
    const dedup: Array<DriftCand & { _row: Row }> = [];
    for (const c of [...cands].sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9))) {
      const dup = dedup.find((d) => d.key === c.key);
      if (dup) { dup.chosen = dup.chosen || c.chosen; dup.crown = dup.crown || c.crown; dup.via = dup.via ?? c.via; continue; }
      dedup.push({ ...c });
    }
    // 🌟（物件オススメで1件に絞った物）がこの回の物件なら印を付ける（比べる相手はそれ）
    const stars = snapsRecent.filter((s) => s.conversation_id === cv && Date.parse(s.sent_at) >= t0 - 10 * 60_000 && Date.parse(s.sent_at) <= end);
    let star: Row | undefined;
    for (const d of dedup) {
      const hitStar = stars.find((s) => isSameProperty({ property_name: d._row.property_name, room_no: d._row.room_no }, { property_name: s.star_name ?? starHeadOf(s.star_text)?.name ?? "", room_no: s.star_room }));
      if (hitStar) { d.star = true; d.chosen = true; d.via = d.via ?? "recommendation"; star = star ?? hitStar; }
    }
    if (!dedup.some((c) => c.chosen)) { counts.pickup_rounds_no_send = (counts.pickup_rounds_no_send ?? 0) + 1; continue; }
    const aix = aixSends.find((s) => s.conversation_id === cv && Date.parse(s.sent_at) >= t0 && Date.parse(s.sent_at) <= end);
    metas.push({
      round: { id: `pickup:${gid}`, source: "pickup", at: new Date(t0).toISOString(), customerKey: short(cv ?? pc), cands: dedup.map(({ _row, ...c }) => c), appealText: star?.star_text ?? aix?.generated_text ?? null },
      customerId: pc, conversationId: cv, appealChannel: star ? "🌟物件オススメ" : aix ? "物件ピックアップ" : null,
      rawFacts: dedup.map((c) => { try { const f = factsFromPickup(c._row) as CandidateFacts; deriveFacts(f); return f; } catch { return null; } }),
    });
  }

  // ── ② 🌟の回・拡張の回（今の判定で付け直し＝scoring-learning と同じ組み立て） ──────
  const load = await loadEpisodes(sb as never, { until: new Date(until).toISOString(), days: DAYS, sources: WITH_POOL ? ["snapshot", "pool"] : ["snapshot"] });
  Object.assign(counts, Object.fromEntries(Object.entries(load.counts).map(([k, v]) => [`learn_${k}`, v])));
  const snapIds = load.episodes.filter((e) => e.source === "snapshot").map((e) => Number(e.id.replace(/^snap:/, "")));
  const poolIds = load.episodes.filter((e) => e.source === "pool").map((e) => e.id.replace(/^pool:/, ""));
  const snapMeta = new Map<number, Row>();
  for (const c of chunks(snapIds, 150)) for (const r of await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, star_text, candidates").in("id", c).range(a, b) as never)) snapMeta.set(Number(r.id), r);
  const poolMeta = new Map<string, Row>();
  for (const c of chunks(poolIds, 150)) for (const r of await all((a, b) => sb.from("property_candidate_pools").select("id, property_customer_id").in("id", c).range(a, b) as never)) poolMeta.set(String(r.id), r);
  const convOfCust = new Map<string, string>();
  {
    const need = [...new Set([...poolMeta.values()].map((r) => r.property_customer_id).filter(Boolean))] as string[];
    for (const c of chunks(need, 100)) for (const r of await all((a, b) => sb.from("conversations").select("id, property_customer_id").in("property_customer_id", c).range(a, b) as never)) convOfCust.set(String(r.property_customer_id), String(r.id));
  }
  for (const e of load.episodes) {
    const isSnap = e.source === "snapshot";
    const m = isSnap ? snapMeta.get(Number(e.id.replace(/^snap:/, ""))) : poolMeta.get(e.id.replace(/^pool:/, ""));
    if (!m) continue;
    const pc = (m.property_customer_id as string) ?? null;
    const cv = isSnap ? (m.conversation_id as string) : (pc ? convOfCust.get(pc) ?? null : null);
    const raw = isSnap ? ((parse(m.candidates) ?? []) as Row[]) : [];
    const rawOf = (key: string) => raw.find((c) => `${c.name}${c.room_no ? ` ${normRoom(c.room_no)}` : ""}` === key) ?? null;
    metas.push({
      round: { id: e.id, source: e.source, at: e.at, customerKey: short(cv ?? pc), appealText: isSnap ? String(m.star_text ?? "") : null,
        cands: e.cands.map((c) => ({ key: c.key, score: typeof c.feats.score === "number" ? c.feats.score : null, codes: c.codes, chosen: c.chosen, star: isSnap && c.chosen, via: c.chosen ? (isSnap ? "recommendation" : "sent") : null })) },
      customerId: pc, conversationId: cv, appealChannel: isSnap ? "🌟物件オススメ" : null,
      rawFacts: e.cands.map((c) => { const r = rawOf(c.key); if (!r) return null; const f = { ...(r as CandidateFacts) }; try { deriveFacts(f); } catch { /* 読めない候補は値のまま */ } return f; }),
    });
  }

  // ── ③ こだわりの強さ（その回の時点） ─────────────────────────────────────────
  const custIds = [...new Set(metas.map((m) => m.customerId).filter(Boolean))] as string[];
  const custs = new Map<string, Row>();
  const hist: Row[] = [];
  for (const c of chunks(custIds, 80)) {
    const { data, error } = await sb.from("property_customers").select("*").in("id", c);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) custs.set(String(r.id), r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).range(a, b) as never));
  }
  const histOf = new Map<string, Row[]>();
  for (const h of hist) { const k = String(h.property_customer_id); if (!histOf.has(k)) histOf.set(k, []); histOf.get(k)!.push(h); }
  const convs = [...new Set(metas.map((m) => m.conversationId).filter(Boolean))] as string[];
  const msgsOf = new Map<string, Row[]>();
  const msgSince = new Date(until - (DAYS + 60) * D).toISOString();
  for (const c of chunks(convs, 40)) for (const r of await all((a, b) => sb.from("messages").select("conversation_id, text, created_at").in("conversation_id", c).eq("sender", "customer").gte("created_at", msgSince).range(a, b) as never)) {
    const k = String(r.conversation_id); if (!msgsOf.has(k)) msgsOf.set(k, []); msgsOf.get(k)!.push(r);
  }
  const strengthOfRound = new Map<string, CustomerStrength>();
  for (const m of metas) {
    const t = Date.parse(m.round.at);
    const base = m.customerId ? custs.get(m.customerId) : null;
    const h = (m.customerId ? histOf.get(m.customerId) ?? [] : []) as ConditionHistoryRow[];
    const cond = base ? customerAt(base, h, m.round.at).c : null;
    const msgs = (m.conversationId ? msgsOf.get(m.conversationId) ?? [] : []).filter((x) => Date.parse(x.created_at) < t && Date.parse(x.created_at) >= t - 60 * D).map((x) => String(x.text ?? ""));
    strengthOfRound.set(m.round.id, customerStrength({ conditions: cond, messages: msgs, history: h.filter((x) => Date.parse(x.created_at) < t) }));
    // 物件の値で決まる話題（その回の時点の条件で線を引く）
    const num = (v: unknown) => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(n) && n > 0 ? n : null; };
    const prof = { rentMax: num(cond?.rent_max) ?? num(cond?.max_rent), walkMax: num(cond?.walk_minutes), ageMax: num(cond?.building_age), sqmMin: num(cond?.floor_area_min) };
    m.round.cands.forEach((c, i) => { const f = m.rawFacts[i]; c.facts = f ? factTopics(f, prof) : null; });
  }
  const strengthOf = (r: DriftRound, f: string) => strengthLevelOf(strengthOfRound.get(r.id), f);

  // ── 報告 ─────────────────────────────────────────────────────────────────────
  const rounds = metas.map((m) => m.round);
  console.log(`=== 実送信 × 採点のズレ（${DAYS}日・YUMA 除く）===`);
  console.log("材料:", JSON.stringify(counts));
  for (const src of ["pickup", "snapshot", "pool"]) {
    const rs = rounds.filter((r) => r.source === src);
    if (!rs.length) continue;
    const s = summarizeRounds(rs);
    const custN = new Set(rs.map((r) => r.customerKey)).size;
    console.log(`\n■ ${src === "pickup" ? "売上サポ（保存の採点）" : src === "snapshot" ? "🌟の回（付け直し）" : "拡張の回（付け直し）"}: ${s.rounds}回・お客様 ${custN}人・比べられる ${s.comparable}回・全部同点 ${s.allTied}回`);
    console.log(`  選んだ物が点の1位 ${s.top1}/${s.comparable}（${pct(s.comparable ? s.top1 / s.comparable : null)}）・3位以内 ${s.top3}（${pct(s.comparable ? s.top3 / s.comparable : null)}）・相対順位 ${s.relRank ?? "-"}（0＝1位・でたらめ 0.5）`);
    console.log(`  👑 が決まった回 ${s.crownRounds}・👑 を送った ${s.crownChosen}（${pct(s.crownRounds ? s.crownChosen / s.crownRounds : null)}）`);
    console.log(`  👑 と違う物を選んだ回で 👑 だけが持つ札: ${s.crownOnlyTop.map(([k, n]) => `${k}×${n}`).join(" ") || "-"}`);
    console.log(`  〃 選んだ物だけが持つ札: ${s.chosenOnlyTop.map(([k, n]) => `${k}×${n}`).join(" ") || "-"}`);
    if (src === "pickup") {
      const stored = rs.map(roundOutcome).map((o) => o.chosenStoredRank).filter((x): x is number => x != null);
      if (stored.length) console.log(`  保存の順位（complete_rank）で選んだ物の一番良い順位: 1位 ${stored.filter((x) => x <= 1).length}・3位以内 ${stored.filter((x) => x <= 3).length}・中央値 ${[...stored].sort((a, b) => a - b)[stored.length >> 1]}（${stored.length}回）`);
    }
  }

  // 条件の種類 × 強さ
  const drift = familyDrift(rounds, strengthOf);
  console.log(`\n■ 条件の種類 × こだわりの強さ（全部の回・比べられる回だけ）`);
  console.log("  種類｜強さ｜回｜選んだ物が満たす｜候補全体｜👑（回）｜👑と違う回: スタッフが取った/点が👑に付いた（重み）｜材料の欠けで👑に付いた｜入れ替わるのに要った点（中央値・回）｜見立て");
  for (const r of drift.filter((x) => x.rounds >= 2 || x.materialCrownAdv > 0)) {
    console.log(`  ${familyJa(r.family)}｜${r.level}｜${r.rounds}｜${pct(r.chosenOk)}｜${pct(r.poolOk)}｜${pct(r.crownOk)}（${r.crownRounds}）｜${r.chosenAdv}/${r.crownAdv}｜${r.materialCrownAdv}｜${r.flipGapMedian ?? "-"}（${r.flipRounds}）｜${r.verdict}`);
  }
  // 物件の値で見る（設備など、付け直しでは札が出ない話題も）
  const tf = topicFactDrift(rounds, (r, t) => strengthLevelOfTopic(strengthOfRound.get(r.id), t));
  console.log(`\n■ 物件の値で見る話題 × 強さ（種類｜強さ｜回｜選んだ物が満たす｜候補全体｜👑（回）｜見立て）`);
  for (const r of tf.filter((x) => x.rounds >= 3)) {
    console.log(`  ${TOPIC_LABEL[r.topic]}${r.scored ? "" : "（採点に札なし）"}｜${r.level}｜${r.rounds}｜${pct(r.chosenHas)}｜${pct(r.poolHas)}｜${pct(r.crownHas)}（${r.crownRounds}）｜${r.verdict}`);
  }
  // 売上サポ: AIX 物件ピックアップで送った物が点の上位 N 件（既定のチェック）どおりか
  {
    let rs = 0, sentN = 0, outside = 0;
    for (const r of rounds.filter((x) => x.source === "pickup")) {
      const viaPick = r.cands.filter((c) => c.chosen && String(c.via ?? "").includes("pickup"));
      if (!viaPick.length) continue;
      rs++; sentN += viaPick.length;
      const top = [...r.cands].filter((c) => c.score != null).sort((a, b) => (b.score as number) - (a.score as number)).slice(0, viaPick.length);
      outside += viaPick.filter((c) => !top.includes(c)).length;
    }
    if (rs) console.log(`\n■ 売上サポ: 物件ピックアップで送った ${rs}回・${sentN}件のうち、点の上位 N 件の外から選んだ（チェックを入れ替えた）物 ${outside}件`);
  }

  // 訴求（🌟の時点の候補は家賃・広さ等の値が無い物が多い＝2026-09 の 1,899件中 家賃ありは 359件・8月は 0件。
  //   「採点が見ていない」の多くは材料の欠けなので、材料の揃う売上サポの回を別に出す）
  const appealTable = (ms: Meta[], title: string) => {
  const topicN = new Map<string, { n: number; scored: number; blind: number; wanted: number; strong: number }>();
  for (const m of ms) {
    const chosen = m.round.cands.filter((c) => c.star);
    const codes = (chosen.length ? chosen : m.round.cands.filter((c) => c.chosen)).flatMap((c) => c.codes);
    const av = appealVsScore(m.round.appealText, codes);
    const st = strengthOfRound.get(m.round.id);
    for (const t of av.topics) {
      const f = topicFamily(t);
      const v = topicN.get(t) ?? { n: 0, scored: 0, blind: 0, wanted: 0, strong: 0 };
      v.n++;
      if (f && av.scoredFamilies.includes(f)) v.scored++;
      if (av.blindTopics.includes(t)) v.blind++;
      const lv = f ? strengthLevelOf(st, f) : "none";
      if (lv !== "none") v.wanted++;
      if (lv === "strong") v.strong++;
      topicN.set(t, v);
    }
  }
  console.log(`\n■ ${title}（${ms.length}通）: 訴求した回｜採点が選んだ物で見ていた｜採点に種類はあるが材料が無く見えていない｜お客様が希望（うち強い）`);
  for (const [t, v] of [...topicN].sort((a, b) => b[1].n - a[1].n)) {
    const f = topicFamily(t as never);
    console.log(`  ${TOPIC_LABEL[t as keyof typeof TOPIC_LABEL] ?? t}${f ? "" : "（採点に札なし）"}｜${v.n}｜${v.scored}（${pct(v.scored / v.n)}）｜${v.blind}｜${v.wanted}（強い ${v.strong}）`);
  }
  };
  const withText = metas.filter((m) => m.round.appealText);
  appealTable(withText, "送った文で訴求した点・全部の回");
  appealTable(withText.filter((m) => m.round.source === "pickup"), "〃 売上サポの回だけ（採点の材料が揃う）");

  // こだわりの強さの分布
  const klass = new Map<string, number>();
  const seenCust = new Set<string>();
  for (const m of metas) { if (seenCust.has(m.round.customerKey)) continue; seenCust.add(m.round.customerKey); const k = strengthOfRound.get(m.round.id)?.klass ?? "?"; klass.set(k, (klass.get(k) ?? 0) + 1); }
  console.log(`\n■ お客様のこだわりの強さ（最初の回の時点・${seenCust.size}人）: ${[...klass].map(([k, n]) => `${k} ${n}人`).join("・")}`);
  const byKlass = new Map<string, number[]>();
  for (const m of metas) { const o = roundOutcome(m.round); if (o.allTied || o.chosenPos == null || o.scored < 2) continue; const k = strengthOfRound.get(m.round.id)?.klass ?? "?"; (byKlass.get(k) ?? byKlass.set(k, []).get(k)!).push((o.chosenPos - 1) / (o.scored - 1)); }
  for (const [k, xs] of byKlass) console.log(`  ${k}: 比べられる ${xs.length}回・選んだ物の相対順位の平均 ${(xs.reduce((a, x) => a + x, 0) / xs.length).toFixed(3)}`);

  // 実例
  console.log(`\n■ 実例（👑 と違う物を選んだ回・点の差の大きい順）`);
  const ex = metas.map((m) => ({ m, o: roundOutcome(m.round) })).filter(({ o }) => o.crownChosen === false && o.gap != null && o.gap > 0)
    .sort((a, b) => (a.m.round.source === "pickup" ? 0 : 1) - (b.m.round.source === "pickup" ? 0 : 1) || (b.o.gap ?? 0) - (a.o.gap ?? 0)).slice(0, SHOW);
  for (const { m, o } of ex) {
    const st = strengthOfRound.get(m.round.id);
    const strong = Object.entries(st?.byFamily ?? {}).filter(([, v]) => v.level === "strong").map(([f, v]) => `${familyJa(f)}(${v.signals.join("/")})`);
    const chosen = m.round.cands.find((c) => c.key === o.mainKey)!;
    const crown = m.round.cands.find((c) => c.key === o.crownKey)!;
    console.log(`\n  [${m.round.source}] 会話 ${m.round.customerKey}…・${m.round.at.slice(0, 10)}・候補 ${o.n}件・こだわり ${st?.klass}（指数 ${st?.index}）`);
    console.log(`    強い条件: ${strong.join("、") || "なし"}`);
    console.log(`    👑 ${crown.key}（${crown.score}点）／ 選んだ物 ${chosen.key}（${chosen.score}点・点の順位 ${o.chosenPos}${o.chosenStoredRank != null ? `・保存の順位 ${o.chosenStoredRank}` : ""}）・差 ${o.gap}点`);
    for (const d of o.diffs) console.log(`      ${familyJa(d.family)}: 選んだ物 ${d.chosenState} ${d.chosenPts}点 ／ 👑 ${d.crownState} ${d.crownPts}点（差 ${d.delta > 0 ? "+" : ""}${d.delta}・${d.kind === "material" ? "材料の欠け" : "重み"}）`);
    if (m.round.appealText) { const av = appealVsScore(m.round.appealText, chosen.codes); console.log(`    訴求（${m.appealChannel}）: ${av.topics.map((t) => TOPIC_LABEL[t]).join("・") || "-"}／採点が見ていない訴求: 材料なし ${av.blindTopics.map((t) => TOPIC_LABEL[t]).join("・") || "-"}・札なし ${av.noFamilyTopics.map((t) => TOPIC_LABEL[t]).join("・") || "-"}`); }
  }

  if (args.out) {
    writeFileSync(String(args.out), JSON.stringify({
      days: DAYS, counts, summary: Object.fromEntries(["pickup", "snapshot", "pool"].map((s) => [s, summarizeRounds(rounds.filter((r) => r.source === s))])),
      drift, rounds: metas.map((m) => ({ ...roundOutcome(m.round), customer: m.round.customerKey, at: m.round.at, strength: strengthOfRound.get(m.round.id)?.klass, families: m.round.cands.filter((c) => c.chosen).map((c) => familiesOf(c.codes)) })),
    }, null, 1));
    console.log(`\n→ ${args.out}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
