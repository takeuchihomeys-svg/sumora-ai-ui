// app/lib/image-read-ledger.ts
// 物件の資料の画像を「1回だけ読んで台帳に残す」（2026-10-17 竹内さん「順に改善おねがい」②・物件検索ブレインの調べの直し）。
//
// 【なぜ】AIX【物件オススメ】の1回で同じ画像を4〜5回別々に読んでいた:
//   1通目の本文（DeepSeek vision）・送った後の物件名の読み（property_image_read）・書き写し（property_image_transcribe）＋文字の読み（property_text_detail）・
//   生成ログの OpenAI gpt-5.4-nano（extractPropertyDetailsFromImage・llm_usage_logs に残らない・結果はほぼ捨て）。
//   読みごとに事実が食い違った（KAORI さん 10/12 グランノーブルⅡ: 1通目「近鉄大阪線 河内山本 徒歩15分・管理費7,700（＝駐車場の欄）」／
//   物件名の読み「四条畷・管理費4,100」／nano「管理費0」。資料の交通は「近鉄奈良線 瓢箪山駅 徒歩18分」・共益費 4,100円）。
// 【形】
//   ① 書き写し（vision 1回・推論なし・温度0。台帳用の指示＝交通の欄の小さい字・金額の欄の取り違え・繰り返し・間取り図の洗面の1行を足す）
//   ② 写した文字から物件名・号室・家賃…（text・PROPERTY_IMAGE_PROMPT と同じ形の JSON）と条件の行（readPropertyDetailFromText）を並べて読む
//   ③ 台帳＝{指紋, URL, 写した文字, 物件の一覧, 条件の行, 間取り図の洗面}。1通目の出口（recommend-fact-guard）・送った後の記録
//     （recordSentImageProperty → sharedPropertyImageRead）・資料の中身（image_details）・ブレイン（sent_image_properties.facts）が同じ読みを使う
// 【置き場】専用の表はまだ無い（設計 scripts/image-read-ledger-migration.sql・竹内さんの OK まで作らない）。
//   今は ①処理の中の覚え（URL・指紋）②生成ログ aix_generate_log.property_details.ledger（既にある JSONB 列・旧は nano の読みを入れていた）。
//   送った後の記録は同じ会話の生成ログから URL か指紋で引く。
// 【指紋】URL は再アップロードで変わる（設計知見 671821e3）→ 画像の中身の SHA-256 の先頭 32 字。
// 【線】申込中の会話・線より前は DeepSeek に渡さない（loadDeepseekCutoff・ensureImageDetail と同じ）。こちらが送る資料の画像だけに使う
// 戻す: IMAGE_READ_LEDGER=off（AIX は台帳を作らない・送った後は今まで通り読む）
import { createHash } from "node:crypto";
import { supabase } from "@/app/lib/supabase-server";
import { PROPERTY_IMAGE_TRANSCRIBE_PROMPT, PROPERTY_IMAGE_PROMPT, parseReadResult, parseTranscript, type ReadResult, type ReadItem, type ImageKind } from "@/app/lib/property-image-read";
import { JA_KANJI_INSTRUCTION, jaKanji } from "@/app/lib/ja-kanji";
import { parseLedgerFacts, trimTranscriptRepetition, type LedgerFacts } from "@/app/lib/recommend-fact-guard";
export { trimTranscriptRepetition };

export function imageReadLedgerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.IMAGE_READ_LEDGER ?? "on").trim().toLowerCase() !== "off";
}

export type ImageLedger = {
  v: 1;
  hash: string | null;
  url: string;
  kind: ImageKind;
  /** 写した文字（繰り返しを切った物・4,000字まで） */
  transcript: string;
  /** 書き写しが上限で切れた */
  truncated: boolean;
  items: ReadItem[];
  isProperty: boolean;
  lines: string[];
  facts: LedgerFacts;
  model: string;
  at: string;
};

/** 台帳用の書き写しの指示（送った後の書き写し PROPERTY_IMAGE_TRANSCRIBE_PROMPT に台帳の線を足す・指示は固定で先頭＝DeepSeek のキャッシュが効く） */
export const LEDGER_TRANSCRIBE_PROMPT = PROPERTY_IMAGE_TRANSCRIBE_PROMPT.replace(
  "【物件の資料】以外は1行目だけで終わる（中身は写さない）",
  `【物件の資料】の時は、2行目に「【間取り図の洗面】」に続けて、間取り図の洗面台（洗面化粧台）の置き場所を次のどれか1つで書く: 独立した洗面所／トイレと同じ部屋／浴室と同じ部屋／廊下・キッチンにある／間取り図なし・読めない
（設備の欄の文字ではなく間取り図の絵で決める。分からなければ「間取り図なし・読めない」）
台帳の線（必ず守る）:
- 物件名（建物名）は表の外の大きな見出しの文字でも「物件名: 〇〇」の形で写す（号室があれば「号室: 〇〇」）
- 交通・最寄り駅の欄は小さい文字でも全部写す（「近鉄奈良線 瓢箪山駅 徒歩18分」のように路線・駅・徒歩の分を字のまま。駅が2つ以上なら全部）
- 所在地は字のまま写す
- 賃料・管理費・共益費・駐車場・町内会費などの金額は、その金額の見出しと組で写す（駐車場の金額を管理費・共益費にしない）
- 設備の欄は書いてある項目を1回ずつ「設備: A・B・C」の1行に写す（○・✓などの印は画像に書いてある時だけ写す。印を足さない）
- 同じ言葉・同じ行を2回以上書かない（1回写したら次の欄へ）
【物件の資料】以外は1行目だけで終わる（中身は写さない）`,
);

/** 写した文字から物件の一覧を読む指示（PROPERTY_IMAGE_PROMPT と同じ JSON の形・画像ではなく写した文字から） */
export const LEDGER_ITEMS_SYSTEM = PROPERTY_IMAGE_PROMPT
  .replace("この画像から物件情報を読み取ってください。", "次の文字は物件の資料の画像を書き写した物です。この文字から物件情報を読み取ってください。")
  .replace("- items: 画像に出ている物件を全部。", "- items: 文字に出ている物件を全部。")
  .replace("- station: 一番近い駅の名前（「駅」は付けない。バス停は除く）。", "- station: 交通・最寄り駅の欄に書いてある一番近い駅の名前（「駅」は付けない。バス停は除く。交通の欄が無ければ \"\"）。")
  .replace("- 画像に書かれていない物件名・金額・日付を作らないこと（読めない項目は null か \"\" のまま）", "- 文字に書かれていない物件名・金額・駅・日付を作らないこと（無い項目は null か \"\" のまま）。admin_fee は「管理費」「共益費」の見出しの金額だけ（駐車場・町内会費は入れない）")
  + `\n${JA_KANJI_INSTRUCTION}`;

export const LEDGER_TRANSCRIBE_MAX_TOKENS = 3000;
export const LEDGER_ITEMS_MAX_TOKENS = 2000;

// ── 指紋 ───────────────────────────────────────────────────────────────
const hashByUrl = new Map<string, string>();
/** 画像の中身の指紋（SHA-256 の先頭32字）。取れなければ null（URL だけで引く） */
export async function imageContentHash(url: string, timeoutMs = 6_000): Promise<string | null> {
  if (!url) return null;
  const hit = hashByUrl.get(url);
  if (hit) return hit;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const h = createHash("sha256").update(buf).digest("hex").slice(0, 32);
    hashByUrl.set(url, h);
    if (hashByUrl.size > 500) hashByUrl.delete(hashByUrl.keys().next().value as string);
    return h;
  } catch { return null; }
}

// ── 覚え（処理の中）──────────────────────────────────────────────────────
const MEM_TTL_MS = 30 * 60_000;
const memByKey = new Map<string, { at: number; ledger: ImageLedger }>();
function memGet(key: string | null): ImageLedger | null {
  if (!key) return null;
  const e = memByKey.get(key);
  if (!e) return null;
  if (Date.now() - e.at > MEM_TTL_MS) { memByKey.delete(key); return null; }
  return e.ledger;
}
function memPut(ledger: ImageLedger): void {
  const now = Date.now();
  memByKey.set(`u:${ledger.url}`, { at: now, ledger });
  if (ledger.hash) memByKey.set(`h:${ledger.hash}`, { at: now, ledger });
  if (memByKey.size > 400) memByKey.delete(memByKey.keys().next().value as string);
}
const inflight = new Map<string, Promise<ImageLedger | null>>();

/**
 * 2026-10-18 竹内さん 10/16「1通目の前に資料を AI で読み直すのはやめ、売上サポの保存済みの事実（台帳・sheet-facts）とつなぐ（費用0）」:
 *   売上サポから来た物件オススメ（行 ID がある1件）は、行に保存してある資料の文字（文字層 pdf_text の1ページ目・条件の行 image_lines）から台帳を作る（LLM なし）。
 *   文字層の「共益費・管理費 14,000円」「専有面積 31.01㎡」「所在地⏎大阪府…」は見出しと値をつないで台帳の読み（parseLedgerFacts）にかける。
 *   2ページ目（まとめ PDF・元付の控え）は足さない＝管理費を2回足さない。駅・管理費・面積のどれも読めない時は null（呼び出し側は今まで通り読む）。
 *   戻す REC_LEDGER_FROM_PICKUP=off（売上サポの行があっても画像を読む＝10/17 の形）
 */
export function savedLedgerFromPickupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.REC_LEDGER_FROM_PICKUP ?? "").trim().toLowerCase() !== "off";
}
export function savedLedgerFromPickup(url: string, row: { property_name?: string | null; pdf_text?: string | null; image_lines?: string[] | null }): ImageLedger | null {
  const pdf = String(row.pdf_text ?? "").normalize("NFKC");
  // 1ページ目だけ（2回目の「出力日:」か「物件種目」の手前まで）
  const cutAt = (re: RegExp) => { const all = [...pdf.matchAll(re)]; return all.length >= 2 ? all[1].index ?? -1 : -1; };
  const cuts = [cutAt(/出力日\s*[:：]/g), cutAt(/物件種目/g)].filter((i) => i > 0);
  const page1 = cuts.length ? pdf.slice(0, Math.min(...cuts)) : pdf;
  const raw = page1.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    if (/^(?:所在地|住所)$/.test(l) && raw[i + 1]) { out.push(`所在地: ${raw[i + 1]}`); i++; continue; }
    const m = l.match(/^(共益費[・/／]管理費|管理費[・/／]共益費|管理費等?|共益費|専有面積)\s+(?![:：])(.+)$/);
    out.push(m ? `${m[1]}: ${m[2]}` : l);
  }
  const lines = (row.image_lines ?? []).map(String).filter(Boolean);
  const transcript = [...out, ...lines.filter((l) => !/^(?:管理費|共益費)/.test(l) || !out.some((o) => /^(?:管理費|共益費|共益費[・/／]管理費|管理費[・/／]共益費)\s*:/.test(o)))].join("\n").slice(0, 6000);
  const facts = parseLedgerFacts(transcript);
  if (!facts.stations.length && facts.adminFee == null && facts.areaSqm == null) return null;
  return { v: 1, hash: null, url, kind: "property", transcript, truncated: false, items: [], isProperty: true, lines, facts, model: "pickup_saved", at: new Date().toISOString() };
}

/** 生成ログに残した台帳の形 → 台帳（形が違えば null） */
export function ledgerFromStored(v: unknown): ImageLedger | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<ImageLedger>;
  if (o.v !== 1 || typeof o.url !== "string" || !Array.isArray(o.items)) return null;
  return {
    v: 1, hash: typeof o.hash === "string" ? o.hash : null, url: o.url, kind: (o.kind as ImageKind) ?? "other",
    transcript: String(o.transcript ?? ""), truncated: !!o.truncated, items: o.items as ReadItem[], isProperty: !!o.isProperty,
    lines: Array.isArray(o.lines) ? o.lines.map(String) : [], facts: (o.facts as LedgerFacts | undefined)?.adminFeeParts ? (o.facts as LedgerFacts) : parseLedgerFacts(String(o.transcript ?? "")),
    model: String(o.model ?? ""), at: String(o.at ?? ""),
  };
}

/** 生成ログ（aix_generate_log.property_details.ledger）に入れる形（写した文字は4,000字まで） */
export function ledgerForStore(l: ImageLedger): ImageLedger {
  return { ...l, transcript: l.transcript.slice(0, 4000), items: l.items.slice(0, 12), lines: l.lines.slice(0, 40) };
}

/** 同じ会話の生成ログから URL か指紋で台帳を引く（無ければ null・読み取りは起こさない） */
export async function findStoredLedger(opts: { url: string; conversationId?: string | null; hash?: string | null }): Promise<ImageLedger | null> {
  const mem = memGet(`u:${opts.url}`) ?? memGet(opts.hash ? `h:${opts.hash}` : null);
  if (mem) return mem;
  if (!opts.conversationId) return null;
  try {
    const { data, error } = await supabase.from("aix_generate_log").select("property_details, created_at")
      .eq("conversation_id", opts.conversationId).not("property_details", "is", null)
      .order("created_at", { ascending: false }).limit(40);
    if (error) return null;
    for (const r of (data ?? []) as Array<{ property_details: { ledger?: unknown } | null }>) {
      const l = ledgerFromStored(r.property_details?.ledger);
      if (!l) continue;
      if (l.url === opts.url || (opts.hash && l.hash === opts.hash)) { memPut(l); return l; }
    }
  } catch { /* 引けなければ読む側へ */ }
  return null;
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
function record(action: string, model: string, u: Usage | null, status: number, ms: number, errorType: string | null, conversationId: string | null, maxTokens: number, sysHead: string): void {
  void import("./llm-usage-recorder").then(({ recordAltUsage }) => {
    recordAltUsage({ model, action, conversationId, usage: u ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, status, errorType, durationMs: ms, sysHead: sysHead.slice(0, 200), sysKeyFull: null, maxTokens });
  }).catch(() => {});
}

/**
 * 台帳を引く（あれば）か、無ければ1回読んで作る。読めなければ null（呼び出し側は今まで通り）。
 * 読み取りは DeepSeek（書き写し vision 1回＋文字 2回）。申込中の会話・線より前は読まない
 */
export async function loadOrReadLedger(url: string, opts: { conversationId?: string | null; timeoutMs?: number } = {}): Promise<ImageLedger | null> {
  if (!url || !imageReadLedgerEnabled()) return null;
  const hash = await imageContentHash(url);
  const stored = await findStoredLedger({ url, conversationId: opts.conversationId ?? null, hash });
  if (stored) {
    if (stored.url !== url) { const copy = { ...stored, url }; memPut(copy); return copy; }
    return stored;
  }
  const key = hash ? `h:${hash}` : `u:${url}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = readLedger(url, hash, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function readLedger(url: string, hash: string | null, opts: { conversationId?: string | null; timeoutMs?: number }): Promise<ImageLedger | null> {
  const conversationId = opts.conversationId ?? null;
  try {
    if (conversationId) {
      const { loadDeepseekCutoff, isAfterCutoff } = await import("@/app/lib/post-apply");
      if (!isAfterCutoff(new Date().toISOString(), await loadDeepseekCutoff(supabase, conversationId))) {
        console.log(JSON.stringify({ tag: "deepseek-cutoff:skip-image-read", route: "image-ledger", conversationId }));
        return null;
      }
    }
    if (!(process.env.DEEPSEEK_API_KEY ?? "").trim()) return null;
    const { callDeepSeekRead, VISION_ALT_MODEL_DEFAULT } = await import("./vision-alt-provider");
    const model = (process.env.PROPERTY_IMAGE_MODEL ?? VISION_ALT_MODEL_DEFAULT).trim();
    const budget = opts.timeoutMs ?? 45_000;
    const t0 = Date.now();
    // ① 書き写し（vision 1回）
    const tr = await callDeepSeekRead(null, [
      { type: "text", text: LEDGER_TRANSCRIBE_PROMPT },
      { type: "image_url", image_url: { url } },
    ], { maxTokens: LEDGER_TRANSCRIBE_MAX_TOKENS, timeoutMs: Math.min(budget, 40_000), model },
    (t) => (t.trim() ? t : null),
    { retryIf: (elapsed) => budget - elapsed >= 15_000, retryTimeoutMs: (elapsed) => budget - elapsed });
    for (const a of tr.attempts) {
      record("property_ledger_read", a.res?.model ?? model, a.res ? { input_tokens: a.res.usage.cacheMiss, output_tokens: a.res.usage.output, cache_read_input_tokens: a.res.usage.cacheHit } : null,
        a.res ? 200 : 0, a.ms, a.ok ? null : a.res ? "empty" : "no_response", conversationId, LEDGER_TRANSCRIBE_MAX_TOKENS, LEDGER_TRANSCRIBE_PROMPT);
    }
    if (!tr.value) { console.warn(JSON.stringify({ tag: "image-ledger:read-failed", conversationId, url: url.slice(-40) })); return null; }
    const truncated = (tr.res?.usage.output ?? 0) >= LEDGER_TRANSCRIBE_MAX_TOKENS - 5;
    const rep = trimTranscriptRepetition(jaKanji(tr.value));
    const parsed = parseTranscript(rep.text);
    const kind: ImageKind = parsed.kind ?? "property";
    const base: Omit<ImageLedger, "items" | "isProperty" | "lines" | "facts"> = {
      v: 1, hash, url, kind, transcript: rep.text.slice(0, 6000), truncated: truncated || rep.trimmed, model, at: new Date().toISOString(),
    };
    if (kind !== "property" || parsed.body.replace(/\s+/g, "").length < 10) {
      const l: ImageLedger = { ...base, items: [], isProperty: kind === "property", lines: [], facts: parseLedgerFacts(kind === "property" ? rep.text : "") };
      memPut(l);
      return l;
    }
    // ② 写した文字から 物件の一覧（text）と条件の行（text）を並べて読む
    const left = Math.max(5_000, budget - (Date.now() - t0));
    const [itemsOut, detailOut] = await Promise.all([
      callDeepSeekRead(LEDGER_ITEMS_SYSTEM, parsed.body.slice(0, 6000), { maxTokens: LEDGER_ITEMS_MAX_TOKENS, timeoutMs: Math.min(left, 25_000), model },
        (t) => { const r = parseReadResult(t); return r.items.length || /"is_property"/.test(t) ? r : null; },
        { retryIf: (elapsed) => left - elapsed >= 4_000, retryTimeoutMs: (elapsed) => left - elapsed }),
      import("./property-detail-source").then(({ readPropertyDetailFromText, PROPERTY_TRANSCRIPT_DETAIL_SYSTEM }) =>
        readPropertyDetailFromText(parsed.body, { model, timeoutMs: left, conversationId, system: PROPERTY_TRANSCRIPT_DETAIL_SYSTEM })),
    ]);
    for (const a of itemsOut.attempts) {
      record("property_ledger_items", a.res?.model ?? model, a.res ? { input_tokens: a.res.usage.cacheMiss, output_tokens: a.res.usage.output, cache_read_input_tokens: a.res.usage.cacheHit } : null,
        a.res ? 200 : 0, a.ms, a.ok ? null : a.res ? "empty_or_unparsable" : "no_response", conversationId, LEDGER_ITEMS_MAX_TOKENS, LEDGER_ITEMS_SYSTEM);
    }
    const read: ReadResult = itemsOut.value ?? { items: [], isProperty: true, raw: "" };
    const ledger: ImageLedger = {
      ...base,
      items: read.items,
      isProperty: read.isProperty || read.items.length > 0,
      lines: detailOut.failed ? [] : detailOut.lines,
      facts: parseLedgerFacts(rep.text),
    };
    memPut(ledger);
    console.log(JSON.stringify({
      tag: "image-ledger:read", conversationId, ms: Date.now() - t0, kind, items: ledger.items.length, lines: ledger.lines.length,
      truncated: ledger.truncated, stations: ledger.facts.stations.map((s) => s.station), adminFee: ledger.facts.adminFee, washbasin: ledger.facts.washbasin,
    }));
    return ledger;
  } catch (e) {
    console.warn("[image-ledger] read failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 写した文字に物件名が無い（表の外の大きな見出し・ロゴを写さない資料・監査 30枚中7枚）時、送る1通目の見出し「🌟建物 号室」か
 * 売上サポの行の物件名を名前にして、値（管理費・㎡・駅）は台帳の物を付ける（送った後の照合は同じ見出しを辞書に持つ）
 */
export function withNameFallback(l: ImageLedger, firstMessage: string, pickupName?: string | null): ImageLedger {
  if (l.items.length > 0 || l.kind !== "property") return l;
  let name = (pickupName ?? "").trim();
  let room = "";
  if (!name) {
    const head = String(firstMessage ?? "").split("\n").map((s) => s.trim()).find((s) => s.startsWith("🌟"));
    const m = head?.match(/^🌟\s*(.+?)(?:\s+([0-9０-９]{2,5}|[A-Za-z]-?[0-9]{2,4})(?:号室)?)?\s*$/);
    if (m) { name = m[1].trim(); room = (m[2] ?? "").normalize("NFKC"); }
  }
  if (!name || name.length > 40) return l;
  const st = l.facts.stations[0] ?? null;
  const out: ImageLedger = {
    ...l, isProperty: true,
    items: [{ propertyName: name, roomNumber: room, adminFee: l.facts.adminFee, areaSqm: l.facts.areaSqm, station: st?.station ?? null, walkMinutes: st?.walk ?? null }],
  };
  memPut(out);
  return out;
}

/** 台帳 → 物件名などの読み（sharedPropertyImageRead と同じ形）。物件が無ければ isProperty=false */
export function readResultFromLedger(l: ImageLedger): ReadResult {
  return { items: l.items, isProperty: l.isProperty && l.kind === "property", raw: l.items.length ? "{\"ledger\":true}" : "{}" };
}

/** 生成ログの property_details（旧の nano の形を保つ: name 等は物件の学習の cron が読む）＋台帳 */
export function propertyDetailsFromLedger(l: ImageLedger): Record<string, unknown> | null {
  const it = l.items.length === 1 ? l.items[0] : null;
  return {
    name: it?.propertyName ?? null,
    room_no: it?.roomNumber || null,
    rent: it?.rent ?? null,
    admin_fee: l.facts.adminFee ?? it?.adminFee ?? null,
    floor_plan: it?.floorPlan ?? null,
    area_sqm: l.facts.areaSqm ?? it?.areaSqm ?? null,
    walk_minutes: l.facts.stations[0]?.walk ?? it?.walkMinutes ?? null,
    station: l.facts.stations[0]?.station ?? null,
    src: "ledger",
    ledger: ledgerForStore(l),
  };
}
