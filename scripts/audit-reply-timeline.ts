// 返信生成の「時間とタイミング」の効果の上限を測る（読み取りのみ・本文は出さない）
// 2026-09-26 竹内「文生成する際に時間や日時と LINE のタイミング（さっきの LINE から何分経過したか）を先に分かるようにしたら質が高くなる？」
//
// 測ること（generate-reply の下書き × スタッフの実送信・ai_reply_examples entry_source=line_reply）:
//   stats : 時間の状況（お客様が返すまでの間・日またぎ・連投・直前にこちらが送った物・夜間・送信の遅れ）の層ごとの
//           そのまま送信率・似ている度。層の差が 6pt（材料を足す路線の天井）を超える軸があるか
//   detect: 時間の取り違えを決定論で全件数える（営業時間外の足し／消し・6時間以上前の「先程」・翌日送信の日付語・夜分の言い回し・直前の言い直し）
//
// 2026-09-26 の結論: 作らない。時間が分かっていれば防げた書き直しは 実物93件中 時間6件＋順序7件、単独原因は6件（そのまま送信の天井 ≈+4pt）。
//   層の差（21pt）は向きが逆（初回・何日も空いた方が良い）で、時間を知らないせいではなく定型の場面の差。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-reply-timeline.ts            （MODE=detect で取り違えの件数・DAYS=60・SRC=line_reply|aix_action|all）
import { createClient } from "@supabase/supabase-js";
import { textSimilarity } from "../app/lib/knowledge-utils";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type Msg = { conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; t: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page<T>(table: string, cols: string, since: string, extra?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 200; p++) {
    let q = sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (extra) q = extra(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const jstDate = (t: number) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const jstHour = (t: number) => new Date(t + 9 * 3600e3).getUTCHours();

async function main() {
  const DAYS = Number(process.env.DAYS ?? 60);
  const MODE = process.env.MODE ?? "stats";
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const since2 = new Date(Date.now() - (DAYS + 30) * 86400e3).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ex = await page<any>("ai_reply_examples", "id, conversation_id, customer_message, sent_reply, ai_draft, was_ai_used, ai_similarity, entry_source, aix_action, conversation_state, sent_at, created_at", since, (q) => q.not("ai_draft", "is", null));
  const msgs = (await page<Msg>("messages", "conversation_id, sender, text, image_url, created_at, is_aix_generated", since2)).map((m) => ({ ...m, t: Date.parse(m.created_at) }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aix = await page<any>("aix_usage_logs", "conversation_id, aix_type, created_at", since2);
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const aixBy = new Map<string, Array<{ type: string; t: number }>>();
  for (const a of aix) { if (!aixBy.has(a.conversation_id)) aixBy.set(a.conversation_id, []); aixBy.get(a.conversation_id)!.push({ type: a.aix_type ?? "?", t: Date.parse(a.created_at) }); }
  const rowsAll = ex.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim() && r.conversation_id);
  const src = process.env.SRC ?? "line_reply";
  const rows = rowsAll.filter((r) => src === "all" || r.entry_source === src);
  console.log(`直近${DAYS}日 下書き＋実送信 ${rowsAll.length}件（${src}: ${rows.length}件）／メッセージ ${msgs.length}通`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type F = { r: any; sim: number; used: boolean; ok: boolean; gapCust?: number; burstN?: number; burstSpan?: number; prevKind?: string; crossDay?: boolean; night?: boolean; delay?: number; firstContact?: boolean; hist?: Msg[]; anchor?: number; sendNextDay?: boolean };
  const feats: F[] = [];
  for (const r of rows) {
    const list = byConv.get(r.conversation_id) ?? [];
    const sentT = Date.parse(r.sent_at ?? r.created_at);
    const head = String(r.sent_reply).replace(/\s+/g, "").slice(0, 12);
    let anchor = sentT;
    const hit = list.find((m) => m.sender !== "customer" && Math.abs(m.t - sentT) < 15 * 60e3 && (m.text ?? "").replace(/\s+/g, "").startsWith(head));
    if (hit) anchor = hit.t;
    const before = list.filter((m) => m.t < anchor - 1000);
    const sim = typeof r.ai_similarity === "number" ? r.ai_similarity : textSimilarity(String(r.ai_draft).trim(), String(r.sent_reply).trim());
    const f: F = { r, sim, used: !!r.was_ai_used, ok: false };
    if (!before.length || before[before.length - 1].sender !== "customer") { feats.push(f); continue; }
    let i = before.length - 1; while (i >= 0 && before[i].sender === "customer") i--;
    const burst = before.slice(i + 1);
    const lastCust = burst[burst.length - 1];
    f.burstN = burst.length; f.burstSpan = (lastCust.t - burst[0].t) / 60e3;
    f.delay = (anchor - lastCust.t) / 60e3;
    f.night = jstHour(lastCust.t) >= 22 || jstHour(lastCust.t) < 9;
    f.sendNextDay = jstDate(anchor) !== jstDate(lastCust.t);
    f.hist = before.slice(-12); f.anchor = anchor;
    if (i < 0) { f.firstContact = true; f.ok = true; feats.push(f); continue; }
    let j = i; while (j >= 0 && before[j].sender !== "customer") j--;
    const block = before.slice(j + 1, i + 1);
    const lastStaff = block[block.length - 1];
    f.gapCust = (burst[0].t - lastStaff.t) / 60e3;
    f.crossDay = jstDate(lastStaff.t) !== jstDate(lastCust.t);
    const aixHit = (aixBy.get(r.conversation_id) ?? []).find((a) => a.t >= block[0].t - 3 * 60e3 && a.t <= lastStaff.t + 3 * 60e3);
    const hasImg = block.some((m) => m.image_url || m.text === "[画像]");
    f.prevKind = aixHit ? `AIX:${aixHit.type}` : block.some((m) => m.is_aix_generated) ? "AIX:?" : hasImg ? "画像(手)" : "手打ち";
    f.ok = true; feats.push(f);
  }
  const all = feats.filter((f) => f.ok);
  console.log(`時間の状況が付いた ${all.length}件（付かない ${feats.length - all.length}件）`);
  const line = (label: string, xs: F[]) => {
    const u = xs.filter((x) => x.used).length; const s = xs.map((x) => x.sim);
    const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
    const heavy = xs.filter((x) => x.sim < 0.5).length;
    return `   ${label.padEnd(30)} ${String(xs.length).padStart(5)}件  そのまま ${pct(u, xs.length).padStart(6)}  似ている度 ${mean.toFixed(3)}  大書き直し(<0.5) ${pct(heavy, xs.length).padStart(6)}`;
  };
  const axis = (title: string, buckets: Array<[string, (f: F) => boolean]>) => {
    console.log(`\n■ ${title}`);
    const rates: number[] = [];
    for (const [l, fn] of buckets) { const xs = all.filter(fn); console.log(line(l, xs)); if (xs.length >= 30) rates.push(xs.filter((x) => x.used).length / xs.length); }
    if (rates.length > 1) console.log(`   → 層の差（30件以上の層の最大−最小）: ${((Math.max(...rates) - Math.min(...rates)) * 100).toFixed(1)}pt`);
  };
  const g = (f: F) => f.gapCust ?? -1;
  if (MODE === "stats") {
    console.log(line("全体", all));
    axis("お客様が返すまでの間（直前のこちらの発言→お客様の最初の発言）", [
      ["初回（こちらの発言なし）", (f) => !!f.firstContact],
      ["5分以内の続き", (f) => g(f) >= 0 && g(f) <= 5],
      ["5〜60分", (f) => g(f) > 5 && g(f) <= 60],
      ["1〜6時間", (f) => g(f) > 60 && g(f) <= 360],
      ["6〜24時間", (f) => g(f) > 360 && g(f) <= 1440],
      ["1〜3日", (f) => g(f) > 1440 && g(f) <= 4320],
      ["3日以上空いた", (f) => g(f) > 4320],
    ]);
    axis("日をまたいだか（直前のこちら→最後のお客様）", [["同じ日", (f) => f.crossDay === false], ["日をまたいだ", (f) => f.crossDay === true]]);
    axis("お客様の連投", [
      ["1通", (f) => f.burstN === 1], ["2通", (f) => f.burstN === 2], ["3通以上", (f) => (f.burstN ?? 0) >= 3],
      ["連投が10分超に散らばる", (f) => (f.burstSpan ?? 0) > 10],
    ]);
    axis("直前にこちらが送った物", [
      ["手打ちの文", (f) => f.prevKind === "手打ち"],
      ["手打ち＋画像", (f) => f.prevKind === "画像(手)"],
      ["AIX（何か）", (f) => !!f.prevKind?.startsWith("AIX")],
    ]);
    const kinds = new Map<string, F[]>(); for (const f of all) if (f.prevKind?.startsWith("AIX")) { const k = f.prevKind; if (!kinds.has(k)) kinds.set(k, []); kinds.get(k)!.push(f); }
    for (const [k, xs] of [...kinds].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) console.log(line("  " + k, xs));
    axis("お客様の発言の時間帯（JST）", [["9〜22時", (f) => f.night === false], ["夜間 22〜9時", (f) => f.night === true]]);
    axis("スタッフが送るまでの遅れ（最後のお客様発言→送信）", [
      ["10分以内", (f) => (f.delay ?? 0) <= 10], ["10〜60分", (f) => (f.delay ?? 0) > 10 && (f.delay ?? 0) <= 60],
      ["1〜6時間", (f) => (f.delay ?? 0) > 60 && (f.delay ?? 0) <= 360], ["6時間〜", (f) => (f.delay ?? 0) > 360],
    ]);
    axis("送信日が お客様の発言の翌日以降", [["同じ日に送信", (f) => f.sendNextDay === false], ["日付が変わってから送信", (f) => f.sendNextDay === true]]);
    const TW = /(本日|今日|明日|昨日|先ほど|先程|さきほど|今朝|今夜|今晩|夜分|遅くに|遅い時間|おはよう|こんばんは|こんにちは|朝早く|夜遅く|週末|土日|来週|今週|明後日|改めて|お久しぶり|ご無沙汰|お待たせ)/g;
    const words = (s: string) => new Set((s.match(TW) ?? []));
    const edited = all.filter((f) => !f.used);
    let changed = 0; const cnt = new Map<string, number>();
    for (const f of edited) {
      const d = words(f.r.ai_draft), s = words(f.r.sent_reply);
      const rm = [...d].filter((w) => !s.has(w)), ad = [...s].filter((w) => !d.has(w));
      if (rm.length || ad.length) { changed++; for (const w of rm) cnt.set(`消:${w}`, (cnt.get(`消:${w}`) ?? 0) + 1); for (const w of ad) cnt.set(`足:${w}`, (cnt.get(`足:${w}`) ?? 0) + 1); }
    }
    console.log(`\n■ 決定論: 書き直し ${edited.length}件のうち 時間語が消えた／足された ${changed}件（${pct(changed, edited.length)}）`);
    console.log("   " + [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 26).map(([k, v]) => `${k}${v}`).join(" ／ "));
  }
  if (MODE === "detect") {
    const edited = all.filter((f) => !f.used);
    console.log(`書き直し ${edited.length}件 ／ 全体 ${all.length}件`);
    const lastStaffOf = (f: F) => { const h = f.hist ?? []; let i = h.length - 1; while (i >= 0 && h[i].sender === "customer") i--; return i >= 0 ? h[i] : null; };
    const rules: Array<[string, (f: F) => boolean]> = [
      ["①営業時間外・明日確認をスタッフが足した", (f) => /営業時間外|明日(午前|一番|朝)?[^。！\n]{0,12}確認/.test(f.r.sent_reply) && !/営業時間外|明日(午前|一番|朝)?[^。！\n]{0,12}確認/.test(f.r.ai_draft)],
      ["②営業時間外・明日確認をスタッフが消した", (f) => !/営業時間外|明日(午前|一番|朝)?[^。！\n]{0,12}確認/.test(f.r.sent_reply) && /営業時間外|明日(午前|一番|朝)?[^。！\n]{0,12}確認/.test(f.r.ai_draft)],
      ["③下書きの『先程』が6時間以上前を指す", (f) => /先程|先ほど|さきほど/.test(f.r.ai_draft) && (() => { const s = lastStaffOf(f); return !!s && (f.anchor! - s.t) > 360 * 60e3; })()],
      ["④日付語（本日/明日/今日/今夜）があり送信が翌日以降・スタッフが消した", (f) => !!f.sendNextDay && ((f.r.ai_draft.match(/本日|明日|今日|今夜|今晩/g) ?? []) as string[]).some((w) => !f.r.sent_reply.includes(w))],
      ["⑤時間帯の挨拶・夜分の取り違え（下書きのみ）", (f) => { const h = jstHour(f.anchor!); return (/夜分|夜遅く|遅くに失礼/.test(f.r.ai_draft) && !/夜分|夜遅く|遅くに失礼/.test(f.r.sent_reply)) || (/おはよう/.test(f.r.ai_draft) && h >= 12) || (/こんばんは/.test(f.r.ai_draft) && h < 17); }],
      ["⑥夜分・遅くに をスタッフが足した", (f) => /夜分|夜遅く|遅くに失礼/.test(f.r.sent_reply) && !/夜分|夜遅く|遅くに失礼/.test(f.r.ai_draft)],
      ["⑦直前のこちらの発言（6時間以内）の言い直し（似0.45以上）", (f) => { const s = lastStaffOf(f); return !!s && (f.anchor! - s.t) < 360 * 60e3 && textSimilarity(f.r.ai_draft, s.text ?? "") >= 0.45; }],
    ];
    for (const [l, fn] of rules) {
      const inAll = all.filter(fn); const inEd = edited.filter(fn);
      console.log(`\n${l}: 書き直しの中 ${inEd.length}件（${pct(inEd.length, edited.length)}）／ 全体で当たる ${inAll.length}件・そのまま ${pct(inAll.filter((x) => x.used).length, inAll.length)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
