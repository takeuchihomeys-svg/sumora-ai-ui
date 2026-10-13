// 読むだけ（LLM なし）: 竹内さん（staff_writer='takeuchi'）が送った🌟（AIX 物件オススメ）の訴求の話題と、
//   ①その時の生成文（aix_generate_log の直前の版＝今の作り方）②訴求の材料（recommend-appeal-points.buildAppealPoints）の話題を比べる。
//   物差しは竹内さんの🌟の本文だけ（P1 3b508208）。資料の事実は sent_image_properties.facts（同じ会話・同じ建物・🌟の前 3日）。
// 使い方: npx tsx --env-file=.env.local scripts/audit-appeal-points.ts [--days=120] [--samples=10]
import { createClient } from "@supabase/supabase-js";
import { appealTopics, customerWants, starHeadOf, TOPIC_LABEL, type TopicKey } from "../app/lib/recommendation-gaps";
import { buildAppealPoints, factContradictions, claimContradicts } from "../app/lib/recommend-appeal-points";
import { factTopics } from "../app/lib/recommendation-gaps";
const prof = (pc: any) => ({ rentMax: pc?.rent_max ?? null, walkMax: pc?.walk_minutes ?? null, ageMax: pc?.building_age ?? null, sqmMin: pc?.floor_area_min ?? null });
const factYes = (f: any, pc: any) => factTopics(f, prof(pc)).yes;
// 食い違い＝その話題を「強み」と言うと資料の事実と合わない（新築なのに築8年・敷礼0なのに敷金あり・駅近なのに徒歩15分）。希望の線は使わない
const factNo = (f: any, _pc: any) => factContradictions(f);
import { normalizeBuildingName } from "../app/lib/property-brain";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DAYS = Number(arg("days") ?? 120), SAMPLES = Number(arg("samples") ?? 8);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function all<T>(q: (from: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await q(f); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
  return out;
}
const bk = (n: string | null | undefined) => normalizeBuildingName(String(n ?? "").replace(/\s*\d{2,4}\s*号?室?$/, "")).slice(0, 12);
// 事実で決められる話題だけ比べる（審査・入居時期・周辺・通勤は資料の事実ではない）
const FACTUAL = new Set<TopicKey>(["zero_deposit", "free_rent", "station_near", "new_build", "spacious", "floor2", "rent", "washbasin", "bath_toilet", "internet", "autolock", "storage", "sunny", "laundry_in", "delivery_box", "reheating", "bath_dryer", "kitchen", "pet", "parking", "corner"]);

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const stars = (await all<any>((f) => sb.from("messages").select("conversation_id,text,created_at").eq("staff_writer", "takeuchi").neq("sender", "customer").like("text", "🌟%").gte("created_at", since).order("created_at").range(f, f + 999)));
  const convs = [...new Set(stars.map((s) => s.conversation_id))];
  const imgs: any[] = [], gens: any[] = [], custMsgs: any[] = [];
  for (let i = 0; i < convs.length; i += 100) {
    const ids = convs.slice(i, i + 100);
    imgs.push(...(await all<any>((f) => sb.from("sent_image_properties").select("conversation_id,property_name,facts,created_at").in("conversation_id", ids).not("facts", "is", null).range(f, f + 999))));
    gens.push(...(await all<any>((f) => sb.from("aix_generate_log").select("conversation_id,action_type,generated_text,generated_at").in("conversation_id", ids).eq("action_type", "property_recommendation").not("generated_text", "is", null).range(f, f + 999))));
    custMsgs.push(...(await all<any>((f) => sb.from("messages").select("conversation_id,text,created_at").in("conversation_id", ids).eq("sender", "customer").range(f, f + 999))));
  }
  const sp = await all<any>((f) => sb.from("sent_properties").select("conversation_id,property_customer_id").in("conversation_id", convs.slice(0, 300)).not("property_customer_id", "is", null).range(f, f + 999));
  const conv2pc = new Map<string, string>(); for (const r of sp) conv2pc.set(r.conversation_id, r.property_customer_id);
  const pcs = new Map<string, any>();
  const pcIds = [...new Set(conv2pc.values())];
  for (let i = 0; i < pcIds.length; i += 200) {
    const { data } = await sb.from("property_customers").select("id,rent_max,floor_plan,walk_minutes,building_age,initial_cost_limit,pet,move_in_time,floor_area_min,preferences,ng_points,other_requests,additional_conditions").in("id", pcIds.slice(i, i + 200));
    for (const p of data ?? []) pcs.set(p.id, p);
  }
  let n = 0, nGen = 0;
  const cov = { gen: { hit: 0, of: 0, said: 0, saidHit: 0 }, pts: { hit: 0, of: 0, said: 0, saidHit: 0 }, ptsTop2: { hit: 0, of: 0, said: 0, saidHit: 0 } };
  const takeTopics: Record<string, number> = {};
  const samples: string[] = [];
  const bulletCls: Record<string, { kept: number; removed: number }> = {};
  const bulletEx: string[] = [];
  for (const s of stars) {
    const head = starHeadOf(s.text); if (!head) continue;
    const t = Date.parse(s.created_at);
    const cand = imgs.filter((r) => r.conversation_id === s.conversation_id && bk(r.property_name) && bk(r.property_name) === bk(head.name) && Date.parse(r.created_at) <= t + 60_000 && t - Date.parse(r.created_at) < 3 * 864e5)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (!cand) continue;
    const take = appealTopics(s.text).filter((k) => FACTUAL.has(k));
    if (!take.length) continue;
    n++;
    for (const k of take) takeTopics[TOPIC_LABEL[k]] = (takeTopics[TOPIC_LABEL[k]] ?? 0) + 1;
    const pc = pcs.get(conv2pc.get(s.conversation_id) ?? "") ?? null;
    const msgs = custMsgs.filter((m) => m.conversation_id === s.conversation_id && Date.parse(m.created_at) < t).map((m) => m.text);
    const wants = customerWants({ conditions: pc, messages: msgs });
    const ap = buildAppealPoints(cand.facts, wants, { rentMax: pc?.rent_max ?? null, walkMax: pc?.walk_minutes ?? null, ageMax: pc?.building_age ?? null, sqmMin: pc?.floor_area_min ?? null });
    const ptsAll = ap.points.map((p) => p.key), pts2 = ptsAll.slice(0, 2);
    const score = (pred: TopicKey[], acc: { hit: number; of: number; said: number; saidHit: number }) => {
      acc.of += take.length; acc.hit += take.filter((k) => pred.includes(k)).length;
      const fp = pred.filter((k) => FACTUAL.has(k)); acc.said += fp.length; acc.saidHit += fp.filter((k) => take.includes(k)).length;
    };
    score(ptsAll, cov.pts); score(pts2, cov.ptsTop2);
    const g = gens.filter((x) => x.conversation_id === s.conversation_id && Date.parse(x.generated_at) <= t && t - Date.parse(x.generated_at) < 3600_000).sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at))[0];
    let genT: TopicKey[] = [];
    if (g) { nGen++; genT = appealTopics(g.generated_text).filter((k) => FACTUAL.has(k)); score(genT, cov.gen); }
    // 箇条書きの1行ずつ: 生成文にあって竹内さんが消した行／残した行。資料の事実と食い違う行（新築なのに築8年 等）・希望に無い行か
    if (g) {
      const bullets = (x: string) => String(x).split("\n").map((l) => l.trim()).filter((l) => /^[・･]/.test(l));
      const norm = (l: string) => l.replace(/[\s　・･、。！!]/g, "");
      const sentB = new Set(bullets(s.text).map(norm));
      const fYes = new Set(factYes(cand.facts, pc)), fNo = new Set(factNo(cand.facts, pc));
      const wantSet = new Set(wants.map((w) => w.key));
      const ptSet = new Set(ap.points.map((p) => p.key));
      for (const b of bullets(g.generated_text)) {
        const kept = sentB.has(norm(b));
        const tk = appealTopics(`x\n${b}`).filter((k) => FACTUAL.has(k));
        const contra = !!claimContradicts(b, cand.facts) || tk.some((k) => fNo.has(k) && k !== "new_build" && k !== "zero_deposit");
        const supported = tk.some((k) => fYes.has(k));
        const wanted = tk.some((k) => wantSet.has(k));
        const inPts = tk.some((k) => ptSet.has(k));
        const cls = `${contra ? "資料と食い違う" : supported ? "資料で裏付け" : "資料で分からない"}・${wanted ? "希望" : "希望外"}${inPts ? "・材料の強み" : ""}`;
        const c = (bulletCls[cls] ??= { kept: 0, removed: 0 }); if (kept) c.kept++; else c.removed++;
        if (contra && bulletEx.length < 12) bulletEx.push(`${kept ? "残した" : "消した"}: ${b.slice(0, 40)}（事実 ${JSON.stringify({ age: cand.facts.building_age, walk: cand.facts.walk_minutes, dep: cand.facts.deposit_months, key: cand.facts.key_money_months, floor: cand.facts.floor })}）`);
      }
    }
    if (samples.length < SAMPLES) samples.push(`竹内[${take.map((k) => TOPIC_LABEL[k]).join("・")}] 生成[${g ? genT.map((k) => TOPIC_LABEL[k]).join("・") : "なし"}] 材料[${ap.points.map((p) => p.fact).join("・")}] 希望[${wants.map((w) => TOPIC_LABEL[w.key]).join("・")}]`);
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%（${a}/${b}）` : "-");
  console.log(JSON.stringify({
    days: DAYS, takeuchiStarsWithFacts: n, withGeneratedBefore: nGen,
    recall_竹内さんの訴求を拾えた: { 生成文_前: pct(cov.gen.hit, cov.gen.of), 材料3つ_後: pct(cov.pts.hit, cov.pts.of), 材料上位2つ_後: pct(cov.ptsTop2.hit, cov.ptsTop2.of) },
    precision_出した話題が竹内さんと同じ: { 生成文_前: pct(cov.gen.saidHit, cov.gen.said), 材料3つ_後: pct(cov.pts.saidHit, cov.pts.said), 材料上位2つ_後: pct(cov.ptsTop2.saidHit, cov.ptsTop2.said) },
    竹内さんの訴求の話題: Object.entries(takeTopics).sort((a, b) => b[1] - a[1]),
    samples,
    箇条書き_生成文の行を竹内さんが残した消した: bulletCls, 食い違いの例: bulletEx,
  }, null, 1));
})();
