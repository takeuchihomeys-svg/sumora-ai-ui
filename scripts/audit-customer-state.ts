// お客様の状況の材料（status・viewing_history・viewings・calendar_events・sent_facts・AIX・送った物件）の食い違いと、お部屋の結び付き・段階の流れを数える
// 読み取りのみ・LLM なし。出力は件数と会話ID先頭8桁・物件名だけ（お客様の名前は伏せる）
// 2026-09-26 竹内「気に入ったお部屋の内覧前の状態も認識できるように。ステータスや内覧予定もブレインに持たせる／トークの上に今の状況を表示してズレを分かりやすく」
//   の下調べ。結論は設計知見「お客様の状況は5か所に別々にある…」（tags: ブレイン診断／内覧／ステータス）
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-state.ts   （DAYS=90・SHOW=M4 で M4 の例を全部）
import { createClient } from "@supabase/supabase-js";
import { normalizePropertyName, similarity } from "../app/lib/property-name-match";
import { customerSharedPropertyNames } from "../app/lib/customer-property-names";
import { extractViewingAppointment, appointmentYmd } from "../app/lib/action-ledger";
import { STAFF_VIEWING_DONE_RE } from "../app/lib/viewing-thread";
import { isApplicationFormMessage } from "../app/lib/application-form-detect";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 90);
const SHOW = process.env.SHOW ?? "";
async function all(t: string, cols: string, f?: (q: any) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { let q = sb.from(t).select(cols).range(i, i + 999); if (f) q = f(q); const { data, error } = await q; if (error) throw new Error(t + " " + error.message); out.push(...(data ?? [])); if ((data ?? []).length < 1000) break; } return out; }
const cnt = (a: string[]) => { const m: Record<string, number> = {}; for (const v of a) m[v] = (m[v] ?? 0) + 1; return Object.entries(m).sort((x, y) => y[1] - x[1]); };
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const TODAY = jst(new Date().toISOString());
const id8 = (s: string) => s.slice(0, 8);
const mask = (s: string) => (s ?? "").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ").slice(0, 70);

// 物件名: 建物と部屋に分ける
const ROOM_RE = /\s*(?:([0-9０-９]{1,4})\s*号室|([0-9０-９]{1,2}\s*[FＦ階]\s*[-－]?\s*[A-Za-zＡ-Ｚ0-9]*))\s*$/;
function splitProp(raw: string): { b: string; room: string | null; raw: string } {
  const r = (raw ?? "").trim();
  const m = r.match(ROOM_RE);
  const room = m ? (m[1] ?? m[2] ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/^0+/, "") : null;
  const b = normalizePropertyName(m ? r.slice(0, m.index) : r);
  return { b, room, raw: r };
}
const LABEL_RE = /(?:🌟|【)\s*([^\n【】🌟]{2,40}?)\s*([0-9０-９]{1,4})\s*号室/g;
const labels = (t: string) => [...(t ?? "").matchAll(LABEL_RE)].map((m) => `${m[1].trim()} ${m[2]}号室`);

type Ev = { t: number; st: string; prop?: string | null; src: string };
const ST_ORDER = ["初回", "物件検索中", "提案中", "気に入った物件あり", "見積書送付", "内覧打診", "内覧予定", "内覧後", "申込案内", "申込中", "審査", "成約", "失注"];
const ST_JA: Record<string, string> = { "初回": "初", "物件検索中": "探", "提案中": "提", "気に入った物件あり": "気", "見積書送付": "見", "内覧打診": "打", "内覧予定": "予", "内覧後": "後", "申込案内": "案", "申込中": "申", "審査": "審", "成約": "成", "失注": "失" };

async function main() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const convsAll = await all("conversations", "id,status,line_source_type,is_post_apply,applying_text_received,applying_image_received,updated_at,created_at,property_customer_id,conversation_direction,last_brain_meta,status_manual_back_at");
  const msgs = await all("messages", "conversation_id,sender,text,created_at,is_aix_generated,image_url", (q) => q.gte("created_at", new Date(Date.now() - (DAYS + 120) * 864e5).toISOString()).order("created_at"));
  const byConv = new Map<string, any[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const convs = convsAll.filter((c) => c.line_source_type !== "group" && c.id !== YUMA && (byConv.get(c.id) ?? []).some((m) => m.created_at >= since));
  const ids = new Set(convs.map((c) => c.id));
  const inC = (x: any) => ids.has(x.conversation_id);
  const sf = (await all("sent_facts", "conversation_id,sent_at,origin,aix_type,kind,status,detail")).filter(inC);
  const aix = (await all("aix_usage_logs", "conversation_id,aix_type,created_at,sent_at,property_names,prop_statuses,estimate_sent,generated_text,check_pattern")).filter(inC).filter((a) => a.sent_at);
  const vh = (await all("viewing_history", "*")).filter(inC);
  const vw = (await all("viewings", "*")).filter(inC);
  const cal = (await all("calendar_events", "conversation_id,event_type,start_at,notes,is_done,created_at")).filter(inC);
  const sp = (await all("sent_properties", "conversation_id,property_customer_id,property_name,room_no,sent_at,source,channel")).filter((x) => x.conversation_id && ids.has(x.conversation_id));
  const sh = (await all("conversation_stage_history", "conversation_id,from_status,to_status,changed_at,trigger")).filter(inC);
  const pcs = new Map((await all("property_customers", "id,status")).map((p) => [p.id, p.status]));
  const g = <T,>(arr: T[], k: (x: T) => string) => { const m = new Map<string, T[]>(); for (const x of arr) { const kk = k(x); if (!m.has(kk)) m.set(kk, []); m.get(kk)!.push(x); } return m; };
  const sfBy = g(sf, (x: any) => x.conversation_id), aixBy = g(aix, (x: any) => x.conversation_id), vhBy = g(vh, (x: any) => x.conversation_id), vwBy = g(vw, (x: any) => x.conversation_id), calBy = g(cal, (x: any) => x.conversation_id), spBy = g(sp, (x: any) => x.conversation_id), shBy = g(sh, (x: any) => x.conversation_id);
  console.log(`対象会話 ${convs.length}（${DAYS}日に発言あり・グループと YUMA を除く） msgs=${msgs.length} sf=${sf.length} aix=${aix.length} vh=${vh.length} viewings=${vw.length} cal=${cal.length} sp(conv)=${sp.length}`);

  const mism: Record<string, string[]> = {};
  const addM = (k: string, v: string) => { (mism[k] ??= []).push(v); };
  const link: Record<string, Record<string, number>> = {};
  const addL = (src: string, lv: string) => { (link[src] ??= {}); link[src][lv] = (link[src][lv] ?? 0) + 1; };
  const variants: string[] = [];
  const candDist: number[] = []; const candDistRecent: number[] = [];
  const paths: { outcome: string; path: string; maxSt: string; id: string }[] = [];
  const currentStages: string[] = []; const uiX: string[] = [];

  for (const c of convs) {
    const ms = byConv.get(c.id) ?? [];
    const staff = ms.filter((m) => m.sender === "staff" && m.text);
    const cust = ms.filter((m) => m.sender === "customer");
    const facts = sfBy.get(c.id) ?? []; const ax = aixBy.get(c.id) ?? []; const vhs = vhBy.get(c.id) ?? []; const vws = vwBy.get(c.id) ?? [];
    const cals = (calBy.get(c.id) ?? []).filter((e: any) => e.event_type === "viewing");
    const sps = spBy.get(c.id) ?? []; const hist = (shBy.get(c.id) ?? []).sort((a: any, b: any) => a.changed_at.localeCompare(b.changed_at));
    const ev: Ev[] = [];
    const T = (s: string) => Date.parse(s);
    if (ms[0]) ev.push({ t: T(ms[0].created_at), st: "初回", src: "msg" });

    // ─ 送った物件（名前の集合）
    const sentNames: { raw: string; t: number; src: string }[] = [];
    for (const x of sps) sentNames.push({ raw: `${x.property_name ?? ""}${x.room_no ? ` ${x.room_no}号室` : ""}`, t: T(x.sent_at), src: "sent_properties" });
    for (const f of facts) for (const n of (f.detail?.propertyNames ?? [])) if (f.kind === "properties_sent") sentNames.push({ raw: n, t: T(f.sent_at), src: "sent_facts" });
    for (const m of staff) for (const l of labels(m.text)) sentNames.push({ raw: l, t: T(m.created_at), src: "label" });
    for (const f of facts) {
      const t = T(f.sent_at);
      if (f.kind === "properties_sent") ev.push({ t, st: "提案中", src: "sf" });
      if (f.kind === "pickup_declared") ev.push({ t, st: "物件検索中", src: "sf" });
      if (f.kind === "estimate_sent") ev.push({ t, st: "見積書送付", src: "sf", prop: (f.detail?.estimateFor ?? [])[0] ?? null });
      if (f.kind === "viewing_invited") ev.push({ t, st: "内覧打診", src: "sf" });
      if (f.kind === "meeting_place_sent") ev.push({ t, st: "内覧予定", src: "sf", prop: f.detail?.appointment?.place ?? null });
      if (f.kind === "application_guided") ev.push({ t, st: "申込案内", src: "sf" });
    }
    for (const a of ax) {
      const t = T(a.sent_at);
      if (a.aix_type === "property_recommendation" || a.aix_type === "property_send") ev.push({ t, st: "提案中", src: "aix" });
      if (a.aix_type === "property_check_result") for (const n of (a.property_names ?? [])) ev.push({ t, st: "気に入った物件あり", src: "check", prop: n });
      if (a.aix_type === "property_check_result" && !(a.property_names ?? []).length) ev.push({ t, st: "気に入った物件あり", src: "check" });
      if (a.aix_type === "estimate_sheet") for (const l of (labels(a.generated_text ?? "").length ? labels(a.generated_text ?? "") : [null])) ev.push({ t, st: "見積書送付", src: "aix", prop: l });
      if (a.aix_type === "viewing_invite") ev.push({ t, st: "内覧打診", src: "aix" });
      if (a.aix_type === "meeting_place") ev.push({ t, st: "内覧予定", src: "aix", prop: labels(a.generated_text ?? "")[0] ?? extractViewingAppointment(a.generated_text, a.sent_at)?.place ?? null });
      if (a.aix_type === "application_push") ev.push({ t, st: "申込案内", src: "aix", prop: labels(a.generated_text ?? "")[0] ?? null });
    }
    const appts: { ymd: string; place: string | null; t: number; src: string }[] = [];
    for (const m of staff) {
      const t = T(m.created_at);
      const ap = extractViewingAppointment(m.text, m.created_at);
      if (ap?.dateMD) { const ymd = appointmentYmd(ap.dateMD, m.created_at); if (ymd) { appts.push({ ymd, place: ap.place, t, src: m.is_aix_generated ? "aix" : "text" }); ev.push({ t, st: "内覧予定", src: "text", prop: ap.place }); } }
      if (STAFF_VIEWING_DONE_RE.test(m.text)) ev.push({ t, st: "内覧後", src: "thanks" });
    }
    for (const a of appts) { const at = Date.parse(`${a.ymd}T20:00:00+09:00`); if (a.ymd < TODAY) ev.push({ t: at, st: "内覧後", src: "date_passed" }); }
    for (const v of vhs) { ev.push({ t: Date.parse(v.created_at), st: "内覧予定", src: "vh", prop: v.property_name }); if (v.status === "done") ev.push({ t: Date.parse(`${v.scheduled_date}T20:00:00+09:00`), st: "内覧後", src: "vh_done" }); }
    // お客様の関心（送った建物名に触れた・共有した物件・申込フォーム）
    const sentB = [...new Set(sentNames.map((s) => splitProp(s.raw).b).filter((b) => b.length >= 3))];
    let appFormAt: number | null = null;
    for (const m of cust) {
      const t = T(m.created_at); const txt = m.text ?? "";
      const nt = normalizePropertyName(txt);
      const hit = sentB.find((b) => nt.includes(b));
      if (hit) ev.push({ t, st: "気に入った物件あり", src: "cust_mention", prop: hit });
      for (const cand of customerSharedPropertyNames([{ sender: "customer", text: txt, createdAt: m.created_at }] as any)) ev.push({ t, st: "気に入った物件あり", src: "cust_shared", prop: cand.name });
      if (!appFormAt && txt.length > 40 && isApplicationFormMessage(txt).detected) { appFormAt = t; ev.push({ t, st: "申込中", src: "form" }); }
    }
    for (const h of hist) {
      const t = T(h.changed_at);
      if (["applying", "application"].includes(h.to_status)) ev.push({ t, st: "申込中", src: "hist" });
      if (h.to_status === "screening") ev.push({ t, st: "審査", src: "hist" });
      if (h.to_status === "closed_won") ev.push({ t, st: "成約", src: "hist" });
      if (["closed_lost", "lost"].includes(h.to_status)) ev.push({ t, st: "失注", src: "hist" });
    }
    const lastT = ms.length ? T(ms[ms.length - 1].created_at) : 0;
    if (c.status === "closed_won" && !ev.some((e) => e.st === "成約")) ev.push({ t: lastT, st: "成約", src: "status" });
    if (["applying", "application"].includes(c.status) && !ev.some((e) => e.st === "申込中")) ev.push({ t: lastT, st: "申込中", src: "status" });
    if (c.status === "screening" && !ev.some((e) => e.st === "審査")) ev.push({ t: lastT, st: "審査", src: "status" });
    ev.sort((a, b) => a.t - b.t);

    // ─ 段階の並び（初めて到達した順・同じ段階は1回）
    const seen: string[] = []; for (const e of ev) if (!seen.includes(e.st)) seen.push(e.st);
    const idle = (Date.now() - lastT) / 864e5;
    const outcome = seen.includes("成約") || c.status === "closed_won" ? "成約" : ["applying", "application", "screening"].includes(c.status) ? "申込・審査中" : idle > 14 ? "止まった(14日以上)" : "進行中";
    const maxSt = seen.reduce((mx, s) => (ST_ORDER.indexOf(s) > ST_ORDER.indexOf(mx) && s !== "失注" ? s : mx), "初回");
    paths.push({ outcome, path: seen.map((s) => ST_JA[s]).join(""), maxSt, id: id8(c.id) });

    // ─ 今の段階（最後のイベントの段階・ただし戻りを考えず最新の出来事）
    const lastEv = [...ev].reverse().find((e) => e.st !== "初回");
    currentStages.push(lastEv?.st ?? "初回"); if (idle <= 14) uiX.push(`${({hearing:"初回対応",condition_hearing:"初回対応",first_reply:"初回対応",property_search:"初回対応",applying:"申込・審査中",application:"申込・審査中",screening:"申込・審査中",closed_won:"成約"} as any)[c.status] ?? "物件提案中"}→${lastEv?.st ?? "初回"}`);

    // ─ 食い違い
    const st = c.status as string;
    const futureVh = vhs.filter((v) => v.scheduled_date >= TODAY && v.status === "scheduled");
    const recentAppt = appts.filter((a) => a.ymd >= TODAY);
    const phase = c.conversation_direction?.current_phase ?? null;
    const cp = c.last_brain_meta?.checkpoint_stage ?? null;
    // M1 予定表（viewing_history）の内覧に対し、待ち合わせの案内（本文・sent_facts）が無い（14日前〜当日）
    for (const v of vhs) {
      const d = Date.parse(`${v.scheduled_date}T23:59:00+09:00`);
      const has = appts.some((a) => a.ymd === v.scheduled_date) || facts.some((f) => f.kind === "meeting_place_sent" && Date.parse(f.sent_at) <= d && Date.parse(f.sent_at) > d - 14 * 864e5);
      if (!has) addM("M1 予定表に内覧があるのに待ち合わせの案内が無い", `${id8(c.id)} ${v.scheduled_date} ${v.status} notes=${mask(v.notes ?? "").slice(0, 20)}`);
    }
    // M2 待ち合わせを案内したのに予定表に無い（9/14 以降の案内）
    for (const a of appts) if (a.t >= Date.parse("2026-09-14T00:00:00+09:00") && !vhs.some((v) => v.scheduled_date === a.ymd)) addM("M2 待ち合わせを案内したのに予定表(viewing_history)に無い(9/14以降)", `${id8(c.id)} ${a.ymd} ${a.src}`);
    for (const a of appts) if (a.t < Date.parse("2026-09-14T00:00:00+09:00") && !vhs.some((v) => v.scheduled_date === a.ymd) && !vws.some((v: any) => v.viewing_date === a.ymd)) addM("M2b 待ち合わせを案内したのに予定表どちらにも無い(9/14より前)", `${id8(c.id)} ${a.ymd}`);
    // M3 カレンダーの内覧（人が入れた・ブレインの未確定でない）に予定表・待ち合わせが無い
    for (const e of cals) {
      const ymd = jst(e.start_at); const n = String(e.notes ?? "");
      const brainGuess = /（未確定）/.test(n) || n.startsWith("[Brain");
      if (brainGuess) { addM("M3a カレンダーにブレインの推測の内覧（物件未確定）", `${id8(c.id)} ${ymd} done=${e.is_done}`); continue; }
      if (n.startsWith("【時間確保】")) continue;
      const has = vhs.some((v) => v.scheduled_date === ymd) || appts.some((a) => a.ymd === ymd) || vws.some((v: any) => v.viewing_date === ymd);
      if (!has) addM("M3b カレンダーの内覧に予定表・待ち合わせが無い", `${id8(c.id)} ${ymd} ${mask(n).slice(0, 30)}`);
    }
    // M4 ステータス=内覧(viewing) なのに、これからの内覧が無い
    if (st === "viewing" && !futureVh.length && !recentAppt.length) addM("M4 status=viewing なのにこれからの内覧が無い", `${id8(c.id)} 最後の内覧=${[...appts.map((a) => a.ymd), ...vhs.map((v) => v.scheduled_date)].sort().at(-1) ?? "なし"} idle=${idle.toFixed(0)}d`);
    // M5 これからの内覧があるのにステータスが提案中以前（画面は「物件提案中」のまま）
    if ((futureVh.length || recentAppt.length) && ["hearing", "proposing", "property_recommendation", "condition_hearing", "first_reply", "availability_check", "estimate_request", "property_search"].includes(st)) addM("M5 これからの内覧があるのに status は提案中以前（画面で見分けられない）", `${id8(c.id)} st=${st} 内覧=${[...recentAppt.map((a) => a.ymd), ...futureVh.map((v) => v.scheduled_date)].sort()[0]}`);
    // M6 内覧の日付が過ぎたのに予定表が lapsed のまま、実際は内覧後のお礼を送っている＝済んだのに未確認扱い
    for (const v of vhs) if (v.status === "lapsed") { const done = staff.some((m) => STAFF_VIEWING_DONE_RE.test(m.text) && jst(m.created_at) >= v.scheduled_date && jst(m.created_at) <= v.scheduled_date.replace(/\d\d$/, (d: string) => String(Number(d) + 1).padStart(2, "0"))); addM(done ? "M6 予定表 lapsed だが内覧後のお礼あり（実施済み）" : "M6x 予定表 lapsed・お礼なし（実施不明）", `${id8(c.id)} ${v.scheduled_date}`); }
    // M7 viewings（旧テーブル）だけがあり viewing_history が無い → ブレインはフォールバックで viewings（全件 done）を「完了」として読む
    if (vws.length && !vhs.length) addM("M7 旧 viewings だけ（ブレインは『完了・対面済み』と読む）", `${id8(c.id)} ${vws.map((v: any) => v.viewing_date).join(",")} 待ち合わせ本文=${appts.length}`);
    for (const v of vws) { const d = v.viewing_date; const hasAppt = appts.some((a) => a.ymd === d); const thanks = staff.some((m) => STAFF_VIEWING_DONE_RE.test(m.text) && jst(m.created_at) >= d); if (!hasAppt && !thanks) addM("M7b 旧 viewings の done に待ち合わせもお礼も無い", `${id8(c.id)} ${d}`); }
    // M8 申込の証拠があるのに status が提案中以前
    const preApply = ["hearing", "proposing", "property_recommendation", "condition_hearing", "first_reply", "availability_check", "estimate_request", "property_search", "viewing"];
    const backToProposing = hist.length && ["proposing", "property_recommendation"].includes(hist[hist.length - 1].to_status) && ["applying", "screening", "application"].includes(hist[hist.length - 1].from_status);
    if (preApply.includes(st) && (c.is_post_apply || appFormAt) && !backToProposing) addM("M8 申込の証拠（is_post_apply/申込フォーム）があるのに status 提案中以前", `${id8(c.id)} st=${st} post=${c.is_post_apply} form=${appFormAt ? jst(new Date(appFormAt).toISOString()) : "-"} idle=${idle.toFixed(0)}d`);
    if (preApply.includes(st) && backToProposing) addM("M8b 申込→提案中に手で戻した（否決・見送り等）", `${id8(c.id)} post=${c.is_post_apply}`);
    // M9 ブレインの phase（conversation_direction.current_phase）と status の段階がずれる
    const stGroup = (s: string | null) => !s ? null : ["applying", "application", "screening", "contract"].includes(s) ? "applying" : s === "closed_won" ? "won" : s === "viewing" ? "viewing" : ["hearing", "condition_hearing", "first_reply", "property_search"].includes(s) ? "hearing" : "proposing";
    if (phase && stGroup(st) !== "won" && stGroup(phase) !== stGroup(st)) addM(`M9 ブレインの phase≠status`, `${id8(c.id)} status=${st} phase=${phase}`);
    // M10 物件出し（property_customers.status）と会話 status
    const ps = c.property_customer_id ? pcs.get(c.property_customer_id) : null;
    if (ps === "applying" && preApply.includes(st)) addM("M10 物件出しは applying・会話は提案中以前", `${id8(c.id)} st=${st}`);
    if (ps && ["property_search", "hot", "new_inquiry"].includes(ps) && ["applying", "screening", "closed_won"].includes(st)) addM("M10b 会話は申込以降・物件出しはまだ探す状態", `${id8(c.id)} st=${st} pc=${ps}`);
    // M11 checkpoint_stage（セーブデータ）と status
    if (cp && stGroup(cp) && stGroup(st) !== "won" && stGroup(cp) !== stGroup(st)) addM("M11 セーブデータの checkpoint_stage≠status", `${id8(c.id)} status=${st} cp=${cp}`);

    // ─ お部屋の結び付き
    const sentSplit = sentNames.map((s) => ({ ...splitProp(s.raw), src: s.src }));
    const linkLevel = (raw: string): string => {
      const p = splitProp(raw); if (!p.b) return "名前なし";
      if (sentSplit.some((s) => s.b === p.b && p.room && s.room === p.room)) return "L1 建物+部屋一致";
      if (sentSplit.some((s) => s.b === p.b)) return p.room ? "L2 建物一致・部屋違い/送付側に部屋なし" : "L2' 建物一致（こちらに部屋なし）";
      if (sentSplit.some((s) => s.b.length >= 3 && p.b.length >= 3 && (s.b.includes(p.b) || p.b.includes(s.b)))) return "L3 片方が含む（略称）";
      if (sentSplit.some((s) => similarity(s.b, p.b) >= 0.7)) return "L4 似ている(≥0.7)";
      return sentSplit.length ? "× 送付記録に無い" : "× 送付記録ゼロ";
    };
    const interestProps: { b: string; t: number; st: string }[] = [];
    for (const e of ev) if (e.prop && ["気に入った物件あり", "見積書送付", "内覧予定", "申込案内"].includes(e.st)) {
      const lv = linkLevel(e.prop); addL(`${e.st}/${e.src}`, lv);
      const p = splitProp(e.prop);
      if (lv.startsWith("L2") || lv.startsWith("L3") || lv.startsWith("L4")) { const s = sentSplit.find((s) => s.b === p.b || s.b.includes(p.b) || p.b.includes(s.b) || similarity(s.b, p.b) >= 0.7); if (s && variants.length < 400) variants.push(`${lv.slice(0, 3)} [${e.st}/${e.src}] 「${p.raw}」 ↔ 送付「${s.raw}」`); }
      if (p.b) interestProps.push({ b: p.b, t: e.t, st: e.st });
    }
    for (const e of ev) if (["見積書送付", "内覧予定", "申込案内"].includes(e.st) && !e.prop) addL(`${e.st}/${e.src}`, "物件名が記録に無い");
    // 同じ建物をまとめる（含む関係も同じ扱い）
    const uniq: string[] = []; for (const p of interestProps.sort((a, b) => a.t - b.t)) if (!uniq.some((u) => u === p.b || u.includes(p.b) || p.b.includes(u) || similarity(u, p.b) >= 0.7)) uniq.push(p.b);
    candDist.push(uniq.length);
    const recent = interestProps.filter((p) => p.t > lastT - 14 * 864e5); const ur: string[] = []; for (const p of recent) if (!ur.some((u) => u === p.b || u.includes(p.b) || p.b.includes(u))) ur.push(p.b);
    candDistRecent.push(ur.length);
  }

  console.log("\n=== 2. 食い違い（件数・例） ===");
  for (const [k, v] of Object.entries(mism).sort()) { console.log(`\n■ ${k}: ${v.length}件（会話 ${new Set(v.map((x) => x.slice(0, 8))).size}）`); for (const x of v.slice(0, SHOW === k.slice(0, 3).trim() ? 60 : 8)) console.log("   ", x); }
  console.log("\n=== 3. お部屋の結び付き（送った物件の記録との一致） ===");
  for (const [k, v] of Object.entries(link).sort()) { const tot = Object.values(v).reduce((a, b) => a + b, 0); console.log(`■ ${k} (${tot}) ` + Object.entries(v).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}=${n}(${((n / tot) * 100).toFixed(0)}%)`).join(" / ")); }
  console.log("\n表記ゆれの例:"); for (const x of variants.slice(0, 40)) console.log("  ", x);
  const dist = (a: number[]) => cnt(a.map((n) => (n >= 5 ? "5+" : String(n)))).sort();
  console.log("\n候補の物件数（会話全体）", dist(candDist)); console.log("候補の物件数（最後の発言から14日以内）", dist(candDistRecent));
  console.log("\n=== 4. 段階の並び ===");
  const byOut = g(paths, (p) => p.outcome);
  for (const [o, ps] of byOut) {
    console.log(`\n■ ${o} ${ps.length}件  最大到達: ${cnt(ps.map((p) => p.maxSt)).map(([k, n]) => `${k}${n}`).join(" ")}`);
    console.log("  並び上位:", cnt(ps.map((p) => p.path)).slice(0, 12).map(([k, n]) => `${k}×${n}`).join("  "));
    const has = (s: string) => ps.filter((p) => p.path.includes(ST_JA[s])).length;
    console.log("  到達率:", ST_ORDER.map((s) => `${ST_JA[s]}${s}=${has(s)}`).join(" "));
  }
  console.log("\n今の段階（最後の出来事）", cnt(currentStages));
  console.log("\n画面の区分→細かい段階（14日以内に発言）", cnt(uiX));
  console.log("\n凡例:", Object.entries(ST_JA).map(([k, v]) => `${v}=${k}`).join(" "));
}
main().catch((e) => { console.error(e); process.exit(1); });
