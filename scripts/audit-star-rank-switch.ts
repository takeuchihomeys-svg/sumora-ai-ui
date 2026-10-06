// scripts/audit-star-rank-switch.ts
// 👑（売上サポの一番オススメ）の決め方を🌟の並べ方（recommend-star-rank・合い方が主軸）に切り替えた後の確かめ（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-10-06 竹内さん（A: 今切り替える・いつでも戻せる・2〜3週間後にスタッフの🌟と合っているか確かめる）。
//   確かめ日: 2026-10-20〜10-27（--since=2026-10-06 で切り替えの後だけ）。
//
// ■ 正解: スタッフが実際に AIX【物件オススメ】で送った部屋（sent_properties channel=recommendation・お客様に届いた行）。お客様の返信は使わない
// ■ 回: その部屋が売上サポの行（property_pickups・同じお客様・送信の14日前〜送信）にある時、その行のまとめ（complete_group_id・無ければ batch_id）の全件
//        （送った後の行も候補に戻す＝送る前に 👑 を決めた時の束。外す候補・資料の現況が審査中/商談中は今まで通り 👑 にしない）
// ■ 出す物
//   ① 同じ回に2つの決め方を当て直した1位一致: 今まで（legacy＝合計の1位）／新しい（fit）／ランダム。対の比べ（片方だけ当たった数）
//   ② 実際に画面に出した 👑（まとめの best_id）とスタッフの🌟の一致を、まとめに残した決め方（result.star_rank_mode・無い＝切り替え前＝legacy）ごとに
//   ③ 新しい決め方で 👑 が変わる回の例（物件名・点・理由。お客様の名前・会話は出さない）
// ■ YUMA（竹内さんのテスト用の会話）は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-star-rank-switch.ts [--days=30] [--since=2026-10-06] [--show=8]
import { createClient } from "@supabase/supabase-js";
import { pickCustomerBest, type BestCandidateRow } from "../app/lib/pickup-best";
import { dropDiscountFromRow } from "../app/lib/property-brain";
import { sameBuildingName } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "30"), 10);
const SINCE = args.since ? new Date(String(args.since)).toISOString() : new Date(Date.now() - DAYS * 864e5).toISOString();
const SHOW = parseInt(String(args.show ?? "8"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const D = 864e5;
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "-");
const normRoom = (r: unknown) => String(r ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
  }
  return out;
}
const sameRoom = (r: Row, name: string, room: string) => sameBuildingName(String(r.property_name ?? ""), name) && (!room || !normRoom(r.room_no) || normRoom(r.room_no) === room);

(async () => {
  // 🌟（スタッフが送った物件オススメ）
  const stars = (await all((a, b) => sb.from("sent_properties").select("id, conversation_id, property_customer_id, property_name, room_no, channel, delivery, source, sent_at")
    .eq("channel", "recommendation").gte("sent_at", SINCE).order("id").range(a, b) as never))
    .filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && (s.delivery == null || s.delivery === "customer") && s.property_name);
  // 売上サポの行（同じお客様・会話）
  const pcs = [...new Set(stars.map((s) => s.property_customer_id).filter(Boolean))] as string[];
  const convs = [...new Set(stars.map((s) => s.conversation_id).filter(Boolean))] as string[];
  const cols = "id, created_at, batch_id, complete_group_id, property_customer_id, conversation_id, rank, property_name, room_no, status, sent_at, recommended, verdict, score, reason_codes, reasons_ja, summary_text, ad_yen, equipment, terms, image_analysis, search_override";
  const pk = new Map<number, Row>();
  const since14 = new Date(Date.parse(SINCE) - 14 * D).toISOString();
  for (const c of chunks(pcs, 60)) for (const r of await all((a, b) => sb.from("property_pickups").select(cols).in("property_customer_id", c).gte("created_at", since14).order("id").range(a, b) as never)) pk.set(r.id, r);
  for (const c of chunks(convs, 60)) for (const r of await all((a, b) => sb.from("property_pickups").select(cols).in("conversation_id", c).gte("created_at", since14).order("id").range(a, b) as never)) pk.set(r.id, r);
  const rows = [...pk.values()];
  const comps = new Map<string, Row>();
  const gids = [...new Set(rows.map((r) => r.complete_group_id).filter(Boolean))] as string[];
  for (const c of chunks(gids, 150)) { const { data } = await sb.from("property_pickup_completions").select("group_id, best_id, finished_at, result").in("group_id", c); for (const x of (data ?? []) as Row[]) comps.set(x.group_id, x); }

  const fix = (r: Row): BestCandidateRow => {
    const d = dropDiscountFromRow(r, null);
    return { ...(r as BestCandidateRow), status: "pending", ...(d ? { score: d.score, verdict: d.verdict, reason_codes: d.reason_codes } : {}) };
  };
  let n = 0, noRound = 0, single = 0, hitL = 0, hitF = 0, rand = 0, onlyF = 0, onlyL = 0, changed = 0;
  const shown: Record<string, [number, number]> = {}; // 決め方 → [回, 一致]
  const examples: string[] = [];
  for (const s of stars) {
    const t = Date.parse(s.sent_at);
    const name = String(s.property_name), room = normRoom(s.room_no);
    const mine = rows.filter((r) => (r.property_customer_id && r.property_customer_id === s.property_customer_id) || (r.conversation_id && r.conversation_id === s.conversation_id));
    const starRow = mine.filter((r) => Date.parse(r.created_at) <= t + 60_000 && Date.parse(r.created_at) >= t - 14 * D && sameRoom(r, name, room))
      .sort((a, z) => Date.parse(z.created_at) - Date.parse(a.created_at))[0];
    if (!starRow) { noRound++; continue; }
    const round = mine.filter((r) => starRow.complete_group_id ? r.complete_group_id === starRow.complete_group_id : r.batch_id === starRow.batch_id);
    // 同じ部屋の重複（別サイトの同じ部屋）は1件に
    const seen = new Set<string>();
    const cands = round.filter((r) => { const k = `${String(r.property_name)}#${normRoom(r.room_no)}`; if (seen.has(k)) return false; seen.add(k); return true; }).map(fix);
    if (cands.length < 2) { single++; continue; }
    const legacy = pickCustomerBest(cands, { basis: "score", windowHours: 24 * 365, starMode: "legacy" });
    const fit = pickCustomerBest(cands, { basis: "score", windowHours: 24 * 365, starMode: "fit" });
    if (!legacy || !fit) { single++; continue; }
    n++;
    const isStar = (id: number) => { const r = cands.find((x) => x.id === id); return !!r && sameRoom(r, name, room); };
    const l = isStar(legacy.id), f = isStar(fit.id);
    if (l) hitL++; if (f) hitF++; if (f && !l) onlyF++; if (l && !f) onlyL++;
    const eligible = cands.filter((r) => r.verdict !== "drop");
    rand += eligible.length ? 1 / eligible.length : 0;
    // 実際に画面に出した 👑（まとめの best_id）
    const comp = starRow.complete_group_id ? comps.get(starRow.complete_group_id) : null;
    if (comp?.best_id != null && comp.finished_at && Date.parse(comp.finished_at) <= t) {
      const mode = String(comp.result?.star_rank_mode ?? "legacy（切り替え前）");
      shown[mode] ??= [0, 0]; shown[mode][0]++; if (isStar(Number(comp.best_id))) shown[mode][1]++;
    }
    if (legacy.id !== fit.id) {
      changed++;
      if (examples.length < SHOW) {
        const lab = (id: number) => { const r = cands.find((x) => x.id === id)!; return `${r.property_name} ${r.room_no ?? ""}（点 ${r.score}・${(r.reason_codes ?? []).filter((c: string) => /^AD_/.test(c)).join("/") || "AD札なし"}）`; };
        examples.push(`  ${String(s.sent_at).slice(0, 10)} 候補${cands.length}: 今まで→${lab(legacy.id)}${l ? " ◎" : ""}\n      新しい→${lab(fit.id)}${f ? " ◎" : ""}［${(fit.star_reasons ?? []).join("・") || "理由なし（札の点）"}］\n      スタッフの🌟→${name} ${s.room_no ?? ""}`);
      }
    }
  }
  console.log(`=== 👑 の決め方（今まで＝合計の1位 ／ 新しい＝🌟の並べ方）とスタッフの🌟 — ${SINCE.slice(0, 10)} 以降 ===`);
  console.log(`スタッフの🌟 ${stars.length}通・売上サポの回に🌟の部屋がある回 ${n + single}（候補2件以上 ${n}）・回が見つからない ${noRound}`);
  console.log(`① 同じ回に当て直した1位一致: ランダム ${pct(rand, n)} ・今まで ${pct(hitL, n)}（${hitL}/${n}）・新しい ${pct(hitF, n)}（${hitF}/${n}）`);
  console.log(`   対の比べ: 新しいだけ当たり ${onlyF}・今までだけ当たり ${onlyL}・👑 が変わる回 ${changed}/${n}`);
  console.log(`② 画面に出した 👑（まとめの best_id・🌟より前に決まった物）とスタッフの🌟:`);
  for (const [k, [m, h]] of Object.entries(shown)) console.log(`   ${k.padEnd(14)} ${pct(h, m)}（${h}/${m}）`);
  if (!Object.keys(shown).length) console.log("   （まだ無い）");
  if (examples.length) { console.log(`③ 👑 が変わる回の例（◎＝スタッフの🌟と一致）:`); console.log(examples.join("\n")); }
})().catch((e) => { console.error(e); process.exit(1); });
