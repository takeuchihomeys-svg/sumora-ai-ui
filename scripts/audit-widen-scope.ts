// 読むだけ（LLM なし）: 直近90日に送った物件（画像の読み取り sent_image_properties.facts）× お客様の条件で、
//   「今の広げての網（拡張の resolution-core.js を node で動かす・前後1駅）」と「提案してよい範囲の段の網の案（proposal-range.ts netExtrasFor・未接続）」に入るかを数える。
//   点は付くのに網の外（2駅・2km・範囲・4km/隣の区）だった物件のうち新しい網で取れる数・新しい網で点の付かない物件（AREA_FAR）を拾う数（広げすぎ）。
// 使い方: npx tsx --env-file=.env.local scripts/audit-widen-scope.ts [--days=90] [--json=out.json]
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { createClient } from "@supabase/supabase-js";
import { parseAreaWant, buildPropertyLocation, matchArea, matchAnchors } from "../app/lib/area-want";
import { decideProposalRange, netExtrasFor, type ProposalLevel, type ProposalMaterials } from "../app/lib/proposal-range";
import { normStation } from "../app/lib/osaka-geo";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DAYS = Number(arg("days") ?? 90);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);

// 拡張の網（resolution-core.js）を node で
const ctx: Record<string, unknown> = { console: { log() {}, warn() {} } };
ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ["area-token.js", "wide-rent.js", "resolution-core.js"]) vm.runInContext(readFileSync(`chrome-extension/${f}`, "utf8"), ctx, { filename: f });
const R = (ctx as any).SUMORA_RESOLUTION;

async function all<T>(q: (from: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await q(f); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
  return out;
}
const inc = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };
const POINT_OUT = new Set(["AREA_STATION_2STOPS", "AREA_NEAR", "AREA_REGION_MATCH", "AREA_CLOSE"]);

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const imgs = await all<any>((f) => sb.from("sent_image_properties").select("conversation_id,property_name,facts,created_at").gte("created_at", since).not("facts", "is", null).range(f, f + 999));
  const sp = await all<any>((f) => sb.from("sent_properties").select("conversation_id,property_customer_id,sent_at").not("property_customer_id", "is", null).gte("sent_at", new Date(Date.now() - 200 * 864e5).toISOString()).range(f, f + 999));
  const conv2pc = new Map<string, string>();
  for (const r of sp.sort((a, b) => a.sent_at.localeCompare(b.sent_at))) conv2pc.set(r.conversation_id, r.property_customer_id);
  const ids = [...new Set(conv2pc.values())];
  const pcs = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("property_customers").select("id,desired_area,area_mode,preferences,other_requests,requirement_strength").in("id", ids.slice(i, i + 200));
    for (const p of data ?? []) pcs.set(p.id, p);
  }
  const convIds = [...conv2pc.keys()];
  const meta = new Map<string, any>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id,suggested_aix_meta").in("id", convIds.slice(i, i + 200));
    for (const c of data ?? []) meta.set(c.id, c.suggested_aix_meta ?? null);
  }
  const netCache = new Map<string, { st: Set<string>; wd: Set<string> }>();
  const curNet = (pc: any) => {
    const k = `${pc.desired_area}|${pc.area_mode}`;
    if (netCache.has(k)) return netCache.get(k)!;
    let st = new Set<string>(), wd = new Set<string>();
    try {
      const r = R.resolveConditionsLocal({ desired_area: pc.desired_area ?? "", area_mode: pc.area_mode || "auto" }, { isWide: true });
      st = new Set((r.station_names ?? []).map((s: string) => normStation(s)));
      wd = new Set(r.ward_names ?? []);
      // 難波・心斎橋の3区（popup の expandNambaCodes・地域の広げて）
      if ([...wd].some((w) => /大阪市(中央|浪速|西)区/.test(w))) for (const w of ["大阪市中央区", "大阪市浪速区", "大阪市西区"]) wd.add(w);
    } catch { /* 解けない＝空の網 */ }
    const v = { st, wd }; netCache.set(k, v); return v;
  };
  const scopeCache = new Map<string, any>();
  const seen = new Set<string>();
  const levelOf: Record<string, number> = {};
  const out = { n: 0, outOfNetWithPoints: 0, byCode: {} as Record<string, number> };
  const gain: Record<string, Record<string, number>> = { fixed_standard: {}, fixed_broad: {}, brain: {} };
  const far: Record<string, number> = { current: 0, fixed_standard: 0, fixed_broad: 0, brain: 0 };
  const farOutCur = { n: 0 };
  const extraSize: Record<string, number[]> = { fixed_standard: [], fixed_broad: [], brain: [] };
  const ex: string[] = [];
  const tightLoss: string[] = [];
  const missed: string[] = [];
  for (const r of imgs) {
    const f = r.facts; if (!f || typeof f !== "object") continue;
    if (/申込/.test(String(f.status ?? ""))) continue;
    const pcId = conv2pc.get(r.conversation_id); if (!pcId) continue;
    const pc = pcs.get(pcId); if (!pc) continue;
    const key = `${r.conversation_id}|${r.property_name ?? ""}|${f.room_no ?? ""}`; if (seen.has(key)) continue; seen.add(key);
    const sts: any[] = Array.isArray(f.stations) ? f.stations : [];
    const summary = "x\n" + sts.filter((s) => s?.station).map((s) => `${s.line ?? ""}「${String(s.station).replace(/駅$/, "")}」徒歩${s.walk ?? ""}分`).join("\n");
    const loc = buildPropertyLocation(summary, null);
    const free = [pc.preferences, pc.other_requests].filter(Boolean).join("\n");
    const want = parseAreaWant(pc.desired_area, free);
    if (!want.any) continue;
    const am = matchAnchors(want, loc) ?? matchArea(want, loc);
    const code = am?.code ?? "NONE";
    if (code === "AREA_UNKNOWN" || code === "NONE") continue;
    out.n++;
    const net = curNet(pc);
    const mode = pc.area_mode || "auto";
    const walkSt = loc.stations.filter((x) => x.walk == null || x.walk <= 15).map((x) => x.station);
    const inSt = (S: Set<string>) => mode !== "ward" && walkSt.some((s) => S.has(s));
    const inWd = (W: Set<string>) => mode !== "station" && !!loc.ward && W.has(loc.ward);
    const inCur = inSt(net.st) || inWd(net.wd);
    if (inCur && /FAR/.test(code)) far.current++;
    const m = meta.get(r.conversation_id) ?? {};
    let rs: any = pc.requirement_strength; if (typeof rs === "string") { try { rs = JSON.parse(rs); } catch { rs = null; } }
    const mats: ProposalMaterials = {
      brainState: m?.customer_mindset?.state ?? null,
      brainGap: m?.customer_mindset?.decideGap ?? null,
      conditionChangeType: m?.condition_change_type ?? null,
      areaStrength: rs?.area?.strength ?? null,
      rentStrength: rs?.rent_max?.strength ?? null,
    };
    const ks = `${pc.id}`;
    if (!scopeCache.has(ks)) {
      const brainD = decideProposalRange(mats, { wantStations: want.stations.map((s) => s.station), wantWards: want.wards });
      const mk = (lv: ProposalLevel) => netExtrasFor(want, lv);
      scopeCache.set(ks, { fixed_standard: mk("standard"), fixed_broad: mk("broad"), brain: netExtrasFor(want, brainD.level), level: brainD.level, reasons: brainD.reasons });
      inc(levelOf, brainD.level);
      for (const k of ["fixed_standard", "fixed_broad", "brain"]) extraSize[k].push(scopeCache.get(ks)[k].stations.length + scopeCache.get(ks)[k].wards.length);
    }
    const sc = scopeCache.get(ks);
    const pointOut = !inCur && POINT_OUT.has(code);
    if (pointOut) { out.outOfNetWithPoints++; inc(out.byCode, code); }
    if (!inCur && /FAR/.test(code)) farOutCur.n++;
    for (const k of ["fixed_standard", "fixed_broad", "brain"] as const) {
      const S = new Set<string>([...net.st, ...sc[k].stations]);
      const W = new Set<string>([...net.wd, ...sc[k].wards]);
      const inNew = inSt(S) || inWd(W);
      if (pointOut && inNew) inc(gain[k], code);
      if (!inCur && inNew && /FAR/.test(code)) far[k]++;
      if (k === "fixed_broad" && pointOut && !inNew && missed.length < 30) missed.push(`${code}[${mode}]: 希望「${String(pc.desired_area).slice(0, 30)}」→ ${walkSt.join("/")}・${loc.ward ?? "-"}（${am?.why ?? ""}）`);
      if (k === "brain" && pointOut && !inNew && sc.level === "tight" && tightLoss.length < 8) tightLoss.push(`${code} 希望「${String(pc.desired_area).slice(0, 24)}」→ ${walkSt.join("/")}（${sc.reasons.join("・")}）`);
      if (k === "brain" && pointOut && inNew && ex.length < 12) ex.push(`${code}/${sc.level}: 希望「${String(pc.desired_area).slice(0, 24)}」→ ${walkSt.join("/") || loc.ward}`);
    }
  }
  const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
  const avg = (a: number[]) => a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : 0;
  const res = {
    days: DAYS, sentWithAreaRead: out.n, outOfNetWithPoints: out.outOfNetWithPoints, byCode: out.byCode,
    gained: { fixed_standard: sum(gain.fixed_standard), fixed_broad: sum(gain.fixed_broad), brain: sum(gain.brain) }, gainedByCode: gain,
    farOutsideCurrentNet: farOutCur.n,
    farCapturedByNewNet_overreach: far,
    avgExtraPlaces: { fixed_standard: avg(extraSize.fixed_standard), fixed_broad: avg(extraSize.fixed_broad), brain: avg(extraSize.brain) },
    brainLevels: levelOf, examples: ex, tightLoss, missedByBroad: arg("missed") ? missed : missed.length,
  };
  console.log(JSON.stringify(res, null, 1));
  const j = arg("json"); if (j) writeFileSync(j, JSON.stringify(res, null, 1));
})();
