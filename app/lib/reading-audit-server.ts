// app/lib/reading-audit-server.ts（サーバー専用・DB 読むだけ・LLM なし・$0）
// 物件資料・画像の読み取りの誤りを週に1回数える見張り（/api/cron/reading-audit-weekly）。
//
// 2026-10-14 竹内さん「週1回、読み取りの誤り（文字の層・スタッフの入力・売上サポと照らす・中国の字形・号室・金額・退去日）を自動で数える仕組み」
//   数える物（直近 N日・既定 7日に書かれた行）:
//     kanji    … 読み取りの出力に中国の字形・互換漢字が残った行（ja-kanji.ts で直してから保存する＝0 が正）
//     names    … 照合できなかった読み取りの物件名（vision）のうち、帳簿と地名の表で直せる化けが残った数（property-name-fix.ts＝0 が正）
//                 ＋スタッフの AIX の物件名に化けがそのまま入った数（先入れの化けが送られた）
//     rooms    … 新しく書いた号室に先頭の0・化けが残った数（room-no.ts＝0 が正）
//     amounts  … 送った画像の読み取りの金額（賃料・管理費・敷金・礼金）を同じ部屋の売上サポの行（資料の文字の層）で答え合わせした誤り
//     vacancy  … 売上サポの行の読み取り（image_lines）で、入居時期の日付を退去予定にした行（sheet-vacancy.ts＝0 が正）
//   落ちた時（alerts が1つ以上）は cron_run_logs.result_json に残す（AIXツールの見張りが読む）。LINE には送らない（送る案は memory/dept_line_reply.md）
import { supabase } from "@/app/lib/supabase";
import { CHINESE_FORM_RE } from "@/app/lib/ja-kanji";
import { canonicalRoomNo, canonicalRoomLabel } from "@/app/lib/room-no";
import type { LlmSpendReport } from "@/app/lib/llm-spend-audit";
import { compareReadAmounts, type AmountFacts, type AmountTruth } from "@/app/lib/reading-amounts";

const COMPAT_RE = /[⺀-⿟豈-﫿]/u;
const hasForm = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v ?? ""); return CHINESE_FORM_RE.test(s) || [...s].some((c) => COMPAT_RE.test(c) && c.normalize("NFKC") !== c); };

async function rowsSince<T>(table: string, cols: string, col: string, since: string, extra?: (q: any) => any, cap = 5000): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; i < cap; i += 1000) {
    let q = supabase.from(table).select(cols).gte(col, since).range(i, i + 999);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export type ReadingAuditReport = {
  ok: boolean; days: number; since: string;
  kanji: { rows: number; byTable: Record<string, number> };
  names: { visionNames: number; fixable: number; uncertain: number; staffMisread: number; examples: string[] };
  rooms: { newRows: number; notCanonical: number; aixNotCanonical: number };
  amounts: Record<"rent" | "admin" | "deposit" | "key", { n: number; bad: number }> & { pairs: number };
  vacancy: { rows: number; moveInAsVacate: number };
  /** LLM の使った額（直近 days 日の日ごと・模型ごと・前の週との差）。LLM_SPEND_AUDIT=off で null（app/lib/llm-spend-audit.ts） */
  llmSpend: LlmSpendReport | null;
  alerts: string[]; errors: string[];
};

export async function weeklyReadingAudit(opts: { days?: number } = {}): Promise<ReadingAuditReport> {
  const days = opts.days ?? 7;
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const r: ReadingAuditReport = {
    ok: true, days, since, kanji: { rows: 0, byTable: {} }, names: { visionNames: 0, fixable: 0, uncertain: 0, staffMisread: 0, examples: [] },
    rooms: { newRows: 0, notCanonical: 0, aixNotCanonical: 0 },
    amounts: { pairs: 0, rent: { n: 0, bad: 0 }, admin: { n: 0, bad: 0 }, deposit: { n: 0, bad: 0 }, key: { n: 0, bad: 0 } },
    vacancy: { rows: 0, moveInAsVacate: 0 }, llmSpend: null, alerts: [], errors: [],
  };
  const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { r.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); } };

  // ── 漢字（中国の字形・互換漢字）
  await step("kanji", async () => {
    const sets: Array<[string, string, string, string[]]> = [
      ["image_details", "image_url, lines", "read_at", ["lines"]],
      ["sent_image_properties", "image_url, property_name, facts", "created_at", ["property_name", "facts"]],
      ["property_sheet_facts", "id, image_facts, text_facts", "updated_at", ["image_facts", "text_facts"]],
      ["property_pickups", "id, image_lines, image_facts", "created_at", ["image_lines", "image_facts"]],
    ];
    for (const [t, cols, col, fields] of sets) {
      const rows = await rowsSince<Record<string, unknown>>(t, cols, col, since);
      const n = rows.filter((x) => fields.some((f) => hasForm(x[f]))).length;
      r.kanji.byTable[t] = n; r.kanji.rows += n;
    }
  });

  // ── 物件名の化け
  await step("names", async () => {
    const { buildLedger, fixReadPropertyName } = await import("@/app/lib/property-name-fix");
    type Src = import("@/app/lib/property-name-fix").LedgerSource;
    const all = async <T,>(t: string, cols: string, f?: (q: any) => any): Promise<T[]> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const out: T[] = [];
      for (let i = 0; i < 60000; i += 1000) { let q = supabase.from(t).select(cols).range(i, i + 999); if (f) q = f(q); const { data, error } = await q; if (error) throw new Error(`${t}: ${error.message}`); out.push(...((data ?? []) as T[])); if (!data || data.length < 1000) break; }
      return out;
    };
    const rows: Array<{ name: string | null; source: Src }> = [];
    for (const x of await all<{ property_name: string | null }>("property_pickups", "property_name")) rows.push({ name: x.property_name, source: "text" });
    const ax = await all<{ property_names: string[] | null; line_message_id: string | null; created_at: string }>("aix_usage_logs", "property_names, line_message_id, created_at", (q) => q.not("property_names", "is", null));
    for (const x of ax) { if (String(x.line_message_id ?? "").startsWith("bexam")) continue; for (const n of x.property_names ?? []) rows.push({ name: n, source: "staff" }); }
    for (const x of await all<{ property_name: string | null; source: string | null }>("sent_properties", "property_name, source", (q) => q.neq("source", "vision"))) rows.push({ name: x.property_name, source: "shared" });
    const ledger = buildLedger(rows);
    const vis = new Set<string>();
    for (const x of await rowsSince<{ property_name: string | null }>("sent_image_properties", "property_name", "created_at", since, (q) => q.eq("source", "vision"))) if (x.property_name) vis.add(x.property_name);
    for (const x of await rowsSince<{ property_name: string | null }>("sent_properties", "property_name", "sent_at", since, (q) => q.eq("source", "vision"))) if (x.property_name) vis.add(x.property_name);
    r.names.visionNames = vis.size;
    for (const n of vis) {
      const f = fixReadPropertyName(n, ledger);
      if (f.status === "fixed") { r.names.fixable++; if (r.names.examples.length < 10) r.names.examples.push(`${n} → ${f.name}`); }
      if (f.status === "uncertain") r.names.uncertain++;
    }
    const staffNew = new Set(ax.filter((x) => x.created_at >= since && !String(x.line_message_id ?? "").startsWith("bexam")).flatMap((x) => x.property_names ?? []));
    for (const n of staffNew) if (fixReadPropertyName(n, ledger).status === "fixed") { r.names.staffMisread++; if (r.names.examples.length < 15) r.names.examples.push(`（スタッフ）${n}`); }
  });

  // ── 号室
  await step("rooms", async () => {
    const a = await rowsSince<{ room_no: string | null }>("sent_properties", "room_no", "sent_at", since, (q) => q.not("room_no", "is", null));
    const b = await rowsSince<{ room_no: string | null }>("sent_image_properties", "room_no", "created_at", since, (q) => q.not("room_no", "is", null));
    const xs = [...a, ...b].map((x) => String(x.room_no ?? "").trim()).filter(Boolean);
    r.rooms.newRows = xs.length;
    r.rooms.notCanonical = xs.filter((x) => canonicalRoomNo(x) !== x.replace(/\s*(?:号室|号)$/, "")).length;
    const ax = await rowsSince<{ property_names: string[] | null }>("aix_usage_logs", "property_names", "created_at", since, (q) => q.not("property_names", "is", null));
    r.rooms.aixNotCanonical = ax.flatMap((x) => x.property_names ?? []).filter((n) => canonicalRoomLabel(n) !== n).length;
  });

  // ── 金額（送った画像の読み取り × 同じ部屋の売上サポの行・前後30日）
  await step("amounts", async () => {
    const { parseListingTerms } = await import("@/app/lib/listing-terms");
    const { parseLoose } = await import("@/app/lib/property-name-loose");
    const sip = await rowsSince<{ property_name: string | null; room_no: string | null; facts: (AmountFacts & { src?: string }) | null; created_at: string }>("sent_image_properties", "property_name, room_no, facts, created_at", "created_at", since, (q) => q.not("facts", "is", null));
    const pkSince = new Date(Date.parse(since) - 30 * 86400_000).toISOString();
    const pk = await rowsSince<{ property_name: string | null; room_no: string | null; pdf_text: string | null; created_at: string }>("property_pickups", "property_name, room_no, pdf_text, created_at", "created_at", pkSince, (q) => q.not("pdf_text", "is", null).not("room_no", "is", null));
    const truthBy = new Map<string, Array<AmountTruth & { at: number }>>();
    for (const x of pk) {
      const p = parseLoose(x.property_name), room = canonicalRoomNo(x.room_no);
      if (!p || !room) continue;
      const t = parseListingTerms(x.pdf_text, { today: x.created_at });
      if (t.rentYen == null) continue;
      const k = `${p.key}|${room}`;
      truthBy.set(k, [...(truthBy.get(k) ?? []), { at: Date.parse(x.created_at), rent: t.rentYen, admin: t.adminFeeYen, depM: t.depositYen ? null : t.depositMonths, keyM: t.keyMoneyYen ? null : t.keyMoneyMonths, depY: t.depositYen ?? null, keyY: t.keyMoneyYen ?? null }]);
    }
    for (const x of sip) {
      if (x.facts?.src !== "image") continue;
      const p = parseLoose(x.property_name), room = canonicalRoomNo(x.room_no);
      if (!p || !room) continue;
      const at = Date.parse(x.created_at);
      const truth = (truthBy.get(`${p.key}|${room}`) ?? []).filter((y) => Math.abs(y.at - at) <= 30 * 86400_000).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
      if (!truth) continue;
      r.amounts.pairs++;
      const c = compareReadAmounts(x.facts, truth);
      for (const k of ["rent", "admin", "deposit", "key"] as const) if (c[k]) { r.amounts[k].n++; if (c[k] === "bad") r.amounts[k].bad++; }
    }
  });

  // ── 退去日（入居時期の日付を退去予定にした読み取りの行）
  await step("vacancy", async () => {
    const { parseListingTerms } = await import("@/app/lib/listing-terms");
    const { sheetDateKey } = await import("@/app/lib/sheet-vacancy");
    const pk = await rowsSince<{ pdf_text: string | null; image_lines: unknown; created_at: string }>("property_pickups", "pdf_text, image_lines, created_at", "created_at", since, (q) => q.not("pdf_text", "is", null).not("image_lines", "is", null));
    for (const x of pk) {
      const il = Array.isArray(x.image_lines) ? (x.image_lines as unknown[]).map(String) : [];
      const vac = il.filter((l) => /^退去予定\s*[:：]/.test(l)).map((l) => sheetDateKey(l.replace(/^[^:：]+[:：]\s*/, ""))).filter(Boolean) as string[];
      if (!vac.length) continue;
      r.vacancy.rows++;
      const m = parseListingTerms(x.pdf_text, { today: x.created_at }).moveIn as { date?: string; day?: number; part?: string };
      const ym = m?.date?.match(/^\d{4}-(\d{2})/);
      const key = ym ? (m.day ? `${+ym[1]}/${m.day}` : m.part ? `${+ym[1]}/${m.part}` : null) : null;
      if (key && vac.includes(key)) r.vacancy.moveInAsVacate++;
    }
  });

  // ── LLM の使った額（2026-10-15・llm_usage_logs を読むだけ・印は llm-spend-audit.ts の線）
  if (process.env.LLM_SPEND_AUDIT !== "off") await step("llmSpend", async () => {
    const { fetchLlmSpend } = await import("@/app/lib/llm-spend-audit");
    r.llmSpend = await fetchLlmSpend({ days });
    r.alerts.push(...r.llmSpend.alerts);
  });

  // ── 落ちた印（どれも直した後は 0 のはず・金額は 1割を超えたら）
  if (r.kanji.rows > 0) r.alerts.push(`中国の字形・互換漢字が残った読み取り ${r.kanji.rows}行`);
  if (r.names.fixable > 0) r.alerts.push(`直せる物件名の化けが残った ${r.names.fixable}種類`);
  if (r.names.staffMisread > 0) r.alerts.push(`スタッフの AIX の物件名に化け ${r.names.staffMisread}種類`);
  if (r.rooms.notCanonical + r.rooms.aixNotCanonical > 0) r.alerts.push(`号室の形がそろっていない ${r.rooms.notCanonical + r.rooms.aixNotCanonical}件`);
  for (const k of ["rent", "admin", "deposit", "key"] as const) { const a = r.amounts[k]; if (a.n >= 10 && a.bad / a.n > 0.1) r.alerts.push(`金額（${k}）の誤りが ${a.bad}/${a.n}`); }
  if (r.vacancy.moveInAsVacate > 0) r.alerts.push(`入居時期を退去予定にした読み取り ${r.vacancy.moveInAsVacate}行`);
  r.ok = r.errors.length === 0;
  return r;
}
