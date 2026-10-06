// scripts/audit-closing-target.ts
// 「決め手の条件」（app/lib/closing-target.ts）の線と裏付けを過去の会話で測る（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-10-07 竹内さん「家賃下げる事はできないので、このお部屋の間取りや条件を取り入れて、ここから家賃が更に5.000円程低いお部屋が見つかれば決まるって考えにする」
//   「次カウンターキッチンでお客さんの条件にあった物件があれば決まる」「このような他のパターンも改善する」
//
// ■ 場面 … スタッフの🌟（AIX 物件オススメ）の後 72時間以内のお客様の発言（続けて送った数通をつなぐ）に readClosingGaps の型がある番
//          気に入った部屋＝その発言の前 7日以内の一番新しい🌟（closingTargetFromConversation と同じ）
// ■ 出す物
//   1. 型ごとの件数（場面・像が作れた数）と当たった文の一覧（--show で目で読む・線の誤りを探す）
//   2. その後 14日にスタッフが送った🌟が像に合っていたか（fit／一番の点は合う／外れ／読めない）＝この考え方の裏付け
//      比べ: 同じお客様の発言の前 30日の🌟（気に入った部屋より前）が同じ像に合う率（スタッフがたまたま合う物を送る率）
//   3. 像に合う🌟の後 14日に、その物件名で内覧・見積・申込の文がスタッフから出た率（合う／合わない）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-closing-target.ts [--days=400] [--show=rent_lower]
import { createClient } from "@supabase/supabase-js";
import { readClosingGaps, buildClosingTarget, favoriteFromStarText, candidateFromStarText, fitOf, starNameRoom, STAR_RE, GAP_KIND_JA, type GapKind, type TargetFit, type CurrentConditions } from "../app/lib/closing-target";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { nameSimilarity } from "../app/lib/candidate-facts";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "400"), 10);
const SHOW = args.show ? String(args.show) : null;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");

type Msg = { conversation_id: string; created_at: string; text: string | null; sender: string };
async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) { const { data, error } = await q(i, i + 999); if (error) throw error; out.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  return out;
}
const H = 3600_000, D = 86400_000;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

(async () => {
  const since = new Date(Date.now() - DAYS * D).toISOString();
  const stars = await all<Msg>((a, b) => sb.from("messages").select("conversation_id, created_at, text, sender").eq("sender", "staff").like("text", "%🌟%").gte("created_at", since).order("created_at").range(a, b));
  const convs = [...new Set(stars.filter((s) => STAR_RE.test(s.text ?? "")).map((s) => s.conversation_id))].filter((c) => c !== YUMA_CONVERSATION_ID);
  const msgs: Msg[] = [];
  for (let i = 0; i < convs.length; i += 40) {
    const ids = convs.slice(i, i + 40);
    msgs.push(...await all<Msg>((a, b) => sb.from("messages").select("conversation_id, created_at, text, sender").in("conversation_id", ids).gte("created_at", since).order("created_at").range(a, b)));
  }
  // 今の登録の条件（場所の目安と家賃の上限に使う。その時点の値ではないので比べの線だけ）
  const { data: convRows } = await sb.from("conversations").select("id, property_customer_id").in("id", convs);
  const pcIds = [...new Set(((convRows ?? []) as Array<{ property_customer_id: string | null }>).map((r) => r.property_customer_id).filter(Boolean) as string[])];
  const pcs: Record<string, CurrentConditions> = {};
  for (let i = 0; i < pcIds.length; i += 100) {
    const { data } = await sb.from("property_customers").select("id, rent_max, floor_plan, floor_area_min, walk_minutes, building_age, desired_area, preferences, area_mode").in("id", pcIds.slice(i, i + 100));
    for (const r of (data ?? []) as Array<CurrentConditions & { id: string }>) pcs[r.id] = r;
  }
  const curOf = new Map(((convRows ?? []) as Array<{ id: string; property_customer_id: string | null }>).map((r) => [r.id, r.property_customer_id ? pcs[r.property_customer_id] ?? {} : {}]));

  const by = new Map<string, Msg[]>();
  for (const m of msgs) { const a = by.get(m.conversation_id) ?? []; a.push(m); by.set(m.conversation_id, a); }
  type Row = { kind: GapKind; conv: string; at: string; ev: string; fav: string; rationale: string; after: TargetFit | "none"; afterName: string | null; before: TargetFit[]; outcome: boolean | null };
  const rows: Row[] = [];
  let turnsAfterStar = 0;
  for (const [conv, list] of by) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    // 番（続けて送ったお客様の発言をつなぐ）
    const turns: Array<{ text: string; at: string; idx: number }> = [];
    list.forEach((m, i) => {
      if (m.sender !== "customer" || !m.text) return;
      const prev = turns[turns.length - 1];
      if (prev && list[i - 1]?.sender === "customer") { prev.text += `\n${m.text}`; prev.at = m.created_at; prev.idx = i; }
      else turns.push({ text: m.text, at: m.created_at, idx: i });
    });
    for (const t of turns) {
      const tAt = Date.parse(t.at);
      const star = list.slice(0, t.idx).reverse().find((m) => m.sender === "staff" && STAR_RE.test(m.text ?? ""));
      if (!star || tAt - Date.parse(star.created_at) > 72 * H) continue;
      turnsAfterStar++;
      const gaps = readClosingGaps(t.text);
      if (!gaps.length) continue;
      const fav = favoriteFromStarText(star.text, star.created_at, t.at);
      const cur = curOf.get(conv) ?? {};
      const target = buildClosingTarget({ gaps, favorite: fav, current: { ...cur, rent_max: null }, text: t.text, at: t.at });
      if (!target) { rows.push({ kind: gaps[0].kind, conv, at: t.at, ev: gaps[0].evidence, fav: fav?.name ?? "", rationale: "（像を作れない＝気に入った部屋の事実が足りない）", after: "none", afterName: null, before: [], outcome: null }); continue; }
      // その後 14日の🌟（次の1件）
      const next = list.slice(t.idx + 1).find((m) => m.sender === "staff" && STAR_RE.test(m.text ?? "") && Date.parse(m.created_at) - tAt <= 14 * D);
      let after: Row["after"] = "none", afterName: string | null = null, outcome: boolean | null = null;
      if (next) {
        const cand = candidateFromStarText(next.text ?? "", next.created_at);
        after = cand ? fitOf(target, cand).fit : "unknown";
        const nr = starNameRoom(next.text);
        afterName = nr ? `${nr.name}${nr.room ? ` ${nr.room}` : ""}` : null;
        if (nr) {
          const tNext = Date.parse(next.created_at);
          outcome = list.some((m) => m.sender === "staff" && Date.parse(m.created_at) > tNext && Date.parse(m.created_at) - tNext <= 14 * D
            && /内覧|内見|ご案内|待ち合わせ|御見積|見積書|お申込|申込/.test(m.text ?? "")
            && String(m.text ?? "").split(/\n/).some((l) => nameSimilarity(nr.name, l.slice(0, 40)) >= 0.5 || l.includes(nr.name.slice(0, 5))));
        }
      }
      // 比べ: 気に入った部屋より前 30日の🌟（同じ像に当てる）
      const before: TargetFit[] = list.filter((m) => m.sender === "staff" && STAR_RE.test(m.text ?? "") && Date.parse(m.created_at) < Date.parse(star.created_at) && Date.parse(star.created_at) - Date.parse(m.created_at) <= 30 * D)
        .map((m) => { const c = candidateFromStarText(m.text ?? "", m.created_at); return c ? fitOf(target, c).fit : "unknown"; });
      rows.push({ kind: target.kind, conv, at: t.at, ev: target.evidence, fav: fav ? `${fav.name} ${fav.room ?? ""}`.trim() : "", rationale: target.rationale, after, afterName, before, outcome });
    }
  }

  console.log(`=== 決め手の条件の監査（${DAYS}日・🌟のある会話 ${by.size}・🌟の後 72時間のお客様の番 ${turnsAfterStar}）===`);
  const kinds = [...new Set(rows.map((r) => r.kind))];
  console.log("型 | 場面 | 像あり | 次の🌟あり | 合う(fit) | 一番の点は合う | 外れ | 読めない | 前の🌟で合う率 | 合う🌟→内覧/見積/申込 | 外れ🌟→内覧/見積/申込");
  for (const k of kinds) {
    const rs = rows.filter((r) => r.kind === k);
    const withT = rs.filter((r) => !r.rationale.startsWith("（"));
    const nx = withT.filter((r) => r.after !== "none");
    const fit = nx.filter((r) => r.after === "fit").length, mok = nx.filter((r) => r.after === "main_ok").length, miss = nx.filter((r) => r.after === "main_miss").length, unk = nx.filter((r) => r.after === "unknown").length;
    const bAll = withT.flatMap((r) => r.before.filter((b) => b !== "unknown"));
    const bOk = bAll.filter((b) => b === "fit" || b === "main_ok").length;
    const okRows = nx.filter((r) => r.after === "fit" || r.after === "main_ok"), missRows = nx.filter((r) => r.after === "main_miss");
    console.log(`${GAP_KIND_JA[k]} | ${rs.length} | ${withT.length} | ${nx.length} | ${fit} | ${mok} | ${miss} | ${unk} | ${pct(bOk, bAll.length)}（${bOk}/${bAll.length}） | ${pct(okRows.filter((r) => r.outcome).length, okRows.length)}（${okRows.filter((r) => r.outcome).length}/${okRows.length}） | ${pct(missRows.filter((r) => r.outcome).length, missRows.length)}（${missRows.filter((r) => r.outcome).length}/${missRows.length}）`);
  }
  const show = SHOW ? rows.filter((r) => SHOW === "all" || r.kind === SHOW) : [];
  for (const r of show) {
    const jst = new Date(Date.parse(r.at) + 9 * H).toISOString().slice(0, 16).replace("T", " ");
    console.log(`\n[${GAP_KIND_JA[r.kind]}] ${r.conv.slice(0, 8)} ${jst}\n  発言: ${r.ev}\n  気に入った: ${r.fav}\n  像: ${r.rationale}\n  次の🌟: ${r.afterName ?? "-"} → ${r.after}${r.outcome ? "（内覧/見積/申込あり）" : ""}`);
  }
})();
