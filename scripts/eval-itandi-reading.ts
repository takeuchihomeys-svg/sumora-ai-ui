// scripts/eval-itandi-reading.ts
// itandi の資料の読み取りを正解表（目で作った物）で採点する。本番と同じ関数（pdf-sheet-crop → sheet-read-server.readSheetCanvas）で
// DeepSeek（deepseek-flash・推論なし・型ごとの固定の前置き）に読ませ、項目ごとの正答率・誤りの一覧・llm_usage_logs の使用量と費用を出す。
//
// 2026-09-25 竹内「なんで itandi のやつできなかったのか。原因見つけて改善する。テストを行う。ちゃんと読み取れるようになるまで。プロンプトキャッシュで」
//   - 正解表: truth.json（itandi の資料画像 26件）＋ truth_pdf.json（本物の PDF・property_pickups 50〜67 の18件）。「不明」は採点しない
//   - 採点では保存した読み取り（property_sheet_facts）を使わない（readSheetCanvas に lookup を渡さない＝毎回読み直す・DB にも保存しない）
//   - 使用量は本番と同じ recordSheetUsage で llm_usage_logs に書き、走らせ始めてからの行を読み直して表にする（cache_read が2件目から出ているか）
//
// 使い方:
//   npx tsx --env-file=.env.local scripts/eval-itandi-reading.ts --dir=<正解表のフォルダ> [--round=r1] [--only=it_002,pdf_55] [--kind=img|pdf]
//   正解表のフォルダには truth.json・<id>.jpg（画像）と truth_pdf.json（各 item の pdf はフォルダからの相対パス）を置く
//   お客様の画像・本人確認書類は入れない（物件資料だけ）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadImageCanvas, readSheetPdf } from "../app/lib/pdf-sheet-crop";
import { readSheetCanvas, type SheetUsage } from "../app/lib/sheet-read-server";
import { recordSheetUsage } from "../app/lib/pickup-analyze-server";
import { parseSheetText } from "../app/lib/sheet-facts";
import { SHEET_PROMPT_VERSION, type SheetImageFacts } from "../app/lib/sheet-prompt";
import { supabase } from "../app/lib/supabase";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const DIR = resolve(arg("dir") ?? process.env.IT_DIR ?? ".");
const ROUND = arg("round") ?? "r1";
const ONLY = arg("only") ? new Set(arg("only")!.split(",")) : null;
const KIND = arg("kind");
/** DeepSeek 公式の単価（USD / 1M トークン）と円換算 */
const PRICE = { miss: 0.28, hit: 0.028, out: 0.42 }, YEN = 150;

type Unk = { v: "不明"; why?: string };
type Truth = Record<string, unknown>;
type Item = { id: string; kind: "img" | "pdf"; file: string; truth: Truth };
const isUnk = (v: unknown): v is Unk => v != null && typeof v === "object" && !Array.isArray(v) && "v" in (v as object);
const core = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/[★☆\s　()（）)]/g, "").replace(/Ⅱ/g, "II").replace(/Ⅳ/g, "IV").replace(/Ⅵ/g, "VI").toLowerCase();
const roomNo = (s: unknown) => String(s ?? "").normalize("NFKC").trim().replace(/^0+/, "").toUpperCase();
const madori = (s: unknown) => String(s ?? "").normalize("NFKC").toUpperCase().replace(/^([1-9])S(?=.)/, "$1");

export const KEYS = ["fp", "name", "room", "layout", "rooms_jo", "kitchen", "relation", "wic", "storage", "bt", "wb", "washer", "balcony"] as const;
type Key = typeof KEYS[number];
type Grade = { ok: boolean | null; want: string; got: string };

function loadItems(): Item[] {
  const out: Item[] = [];
  const img = join(DIR, "truth.json"), pdf = join(DIR, "truth_pdf.json");
  if (existsSync(img)) {
    for (const it of (JSON.parse(readFileSync(img, "utf8")).items as Array<{ id: string; truth: Truth; dup_of?: string }>)) {
      if (it.dup_of) continue;   // 同じ資料の重複（006＝005）は1回だけ数える
      out.push({ id: it.id, kind: "img", file: join(DIR, `${it.id}.jpg`), truth: it.truth });
    }
  }
  if (existsSync(pdf)) {
    for (const it of (JSON.parse(readFileSync(pdf, "utf8")).items as Array<{ id: string; pdf: string; truth: Truth }>)) {
      out.push({ id: it.id, kind: "pdf", file: resolve(DIR, it.pdf), truth: it.truth });
    }
  }
  return out.filter((it) => (!ONLY || ONLY.has(it.id)) && (!KIND || it.kind === KIND));
}

/** 正解1件と読み取りを項目ごとに照らす（null＝採点しない） */
function grade(it: Item, f: SheetImageFacts | null, text: { name: string | null; room: string | null; madori: string | null }): Record<Key, Grade> {
  const t = it.truth;
  const g = {} as Record<Key, Grade>;
  const fpTruth = (it.kind === "img" ? t.floorplan_in_first_frame : t.fp) as boolean | undefined;
  const set = (k: Key, tv: unknown, got: string, ok: () => boolean) => {
    const skip = tv === undefined || tv === null || isUnk(tv);
    g[k] = { ok: skip ? null : (f || k === "name" || k === "room" ? ok() : false), want: skip ? "" : JSON.stringify(tv), got };
  };
  set("fp", fpTruth, String(f?.fp_ok ?? "-"), () => f!.fp_ok === fpTruth);
  set("name", t.name, String(text.name ?? ""), () => core(text.name) === core(t.name));
  set("room", /^[0-9A-Za-z]+$/.test(String(t.room ?? "").normalize("NFKC")) ? t.room : null, String(text.room ?? ""), () => roomNo(text.room) === roomNo(t.room));
  // 間取りは間取り図から読んだ物（図が無い資料は採点しない＝表・文字層の間取りは別に文字で持つ）
  set("layout", fpTruth ? t.layout : null, String(f?.madori ?? ""), () => madori(f!.madori) === madori(t.layout));
  const tj = fpTruth && Array.isArray(t.rooms) ? (t.rooms as Array<{ jo: number | null }>).map((r) => r.jo).filter((x): x is number => x != null) : [];
  const pool0 = (f?.rooms ?? []).map((r) => r.jo).filter((x): x is number => x != null);
  set("rooms_jo", tj.length ? tj : null, JSON.stringify(pool0), () => {
    const pool = pool0.slice();
    return tj.every((j) => { const i = pool.findIndex((p) => Math.abs(p - j) < 0.06); if (i < 0) return false; pool.splice(i, 1); return true; });
  });
  set("kitchen", t.kitchen, String(f?.kitchen.placement ?? ""), () => f!.kitchen.placement === t.kitchen);
  set("relation", t.relation, String(f?.living_bedroom ?? ""), () => f!.living_bedroom === (t.relation === "隣接で扉あり" ? "隣接" : t.relation));
  set("wic", t.wic, String(f?.storage.wic ?? ""), () => f!.storage.wic === (t.wic ? "あり" : "なし"));
  set("storage", t.storage, String(f?.storage.closets ?? "null"), () => f!.storage.closets === t.storage);
  set("bt", t.bt_sep, String(f?.water.bath_toilet ?? ""), () => f!.water.bath_toilet === (t.bt_sep ? "別" : "同室"));
  set("wb", t.wash_basin, String(f?.water.washbasin ?? ""), () => (t.wash_basin ? f!.water.washbasin === "独立" : f!.water.washbasin === "浴室内"));
  set("washer", t.washer, String(f?.water.laundry ?? ""), () => f!.water.laundry === (t.washer === "室外" ? "屋外" : t.washer));
  set("balcony", t.balcony, String(f?.balcony ?? ""), () => f!.balcony === (t.balcony ? "あり" : "なし"));
  return g;
}

type Result = { id: string; kind: Item["kind"]; ms: number; usage: SheetUsage[]; mode: string; image: SheetImageFacts | null; grade: Record<Key, Grade>; error: string | null };

async function readOne(it: Item): Promise<Result> {
  const t0 = Date.now();
  let r: Awaited<ReturnType<typeof readSheetCanvas>> | null = null;
  let text = { name: null as string | null, room: null as string | null, madori: null as string | null };
  let error: string | null = null;
  if (it.kind === "img") {
    const c = await loadImageCanvas(readFileSync(it.file));
    if (c) r = await readSheetCanvas("itandi", c, null, c.height / c.width);
    else error = "画像を読めない";
    const sh = r?.image?.sheet;
    if (sh) text = { name: sh.name, room: sh.room, madori: sh.madori };
  } else {
    const sheet = await readSheetPdf(new Uint8Array(readFileSync(it.file)), { render: true });
    if (sheet?.canvas) {
      const tf = parseSheetText(sheet.texts.join("\n"));
      text = { name: tf.name, room: tf.roomNo, madori: tf.madori };
      r = await readSheetCanvas("itandi", sheet.canvas, sheet.boxes, sheet.aspect, undefined, tf.features);
    } else error = "PDF を読めない";
  }
  for (const u of r?.usage ?? []) recordSheetUsage(u, null);
  const res: Result = { id: it.id, kind: it.kind, ms: Date.now() - t0, usage: r?.usage ?? [], mode: r?.plan.mode ?? "-", image: r?.image ?? null, grade: grade(it, r?.image ?? null, text), error: error ?? r?.error ?? null };
  const ng = KEYS.filter((k) => res.grade[k].ok === false);
  console.log(`${it.id.padEnd(8)} ${res.mode.padEnd(10)} ${res.usage.map((u) => `in${u.input}/hit${u.cacheHit}/out${u.output}/${u.ms}ms${u.retry ? "R" : ""}`).join(" ")}  NG: ${ng.join(",") || "-"}${res.error ? `  ⚠ ${res.error}` : ""}`);
  return res;
}

async function main() {
  const items = loadItems();
  if (!items.length) { console.error("正解表が無い: --dir を確かめる"); process.exit(1); }
  const started = new Date().toISOString();
  console.log(`== ${ROUND} ${SHEET_PROMPT_VERSION}  ${items.length}件（画像 ${items.filter((i) => i.kind === "img").length}・PDF ${items.filter((i) => i.kind === "pdf").length}） ==`);
  const results: Result[] = [];
  // 型ごとに1件目を先に読んで前置きをキャッシュに乗せ、残りは5件ずつ並べて読む
  for (const kind of ["img", "pdf"] as const) {
    const list = items.filter((i) => i.kind === kind);
    if (!list.length) continue;
    results.push(await readOne(list[0]));
    const rest = list.slice(1);
    for (let i = 0; i < rest.length; i += 5) results.push(...await Promise.all(rest.slice(i, i + 5).map(readOne)));
  }
  results.sort((a, z) => a.id.localeCompare(z.id));

  // ── 項目ごとの正答率（不明を除く） ──
  const rows = KEYS.map((k) => {
    const graded = results.filter((r) => r.grade[k].ok !== null);
    const ok = graded.filter((r) => r.grade[k].ok).length;
    const byKind = (kind: Item["kind"]) => { const g = graded.filter((r) => r.kind === kind); return `${g.filter((r) => r.grade[k].ok).length}/${g.length}`; };
    return { k, ok, n: graded.length, pct: graded.length ? Math.round((ok / graded.length) * 1000) / 10 : null, img: byKind("img"), pdf: byKind("pdf"),
      wrong: results.filter((r) => r.grade[k].ok === false).map((r) => ({ id: r.id, want: r.grade[k].want, got: r.grade[k].got, see: r.image?.see ?? "" })) };
  });
  console.log(`\n項目       正答/件数  率      画像   PDF`);
  for (const r of rows) console.log(`${r.k.padEnd(9)} ${`${r.ok}/${r.n}`.padStart(6)}  ${String(r.pct ?? "-").padStart(5)}%  ${r.img.padStart(5)}  ${r.pdf.padStart(5)}`);
  const all = rows.reduce((a, r) => ({ ok: a.ok + r.ok, n: a.n + r.n }), { ok: 0, n: 0 });
  console.log(`全体      ${all.ok}/${all.n}  ${Math.round((all.ok / all.n) * 1000) / 10}%  （95% 未満: ${rows.filter((r) => r.pct != null && r.pct < 95).map((r) => r.k).join("・") || "なし"}）`);
  console.log(`\n誤りの一覧（件名・正解・読み・see）`);
  for (const r of rows) for (const w of r.wrong) console.log(`  ${r.k.padEnd(9)} ${w.id.padEnd(8)} 正解 ${w.want.padEnd(10)} 読み ${w.got.padEnd(10)} ${w.see}`);

  // ── 使用量（llm_usage_logs を読み直す） ──
  await new Promise((r) => setTimeout(r, 4000));
  const { data, error } = await supabase.from("llm_usage_logs")
    .select("created_at, sys_head, input_uncached, cache_read, output_tokens, duration_ms, status")
    .eq("action", "pickup_image_analysis").gte("created_at", started).order("created_at", { ascending: true }).limit(500);
  if (error) console.warn("llm_usage_logs を読めない:", error.message);
  const logs = (data ?? []) as Array<{ sys_head: string | null; input_uncached: number; cache_read: number; output_tokens: number; duration_ms: number }>;
  const secOf = (h: string | null) => (h ?? "").match(/画像で分析・([^】]+)】/)?.[1] ?? "?";
  const groups = new Map<string, typeof logs>();
  for (const l of logs) { const s = secOf(l.sys_head); groups.set(s, [...(groups.get(s) ?? []), l]); }
  console.log(`\n使用量（llm_usage_logs・${logs.length}行 / 読んだ回数 ${results.reduce((a, r) => a + r.usage.length, 0)}）`);
  console.log(`前置き           回数  cache_read  input_uncached  output  2件目以降で命中  1件の費用（円）  平均の時間`);
  let yenAll = 0;
  for (const [s, ls] of groups) {
    const sum = (f: (l: typeof ls[number]) => number) => ls.reduce((a, l) => a + f(l), 0);
    const hit = sum((l) => l.cache_read), miss = sum((l) => l.input_uncached), out = sum((l) => l.output_tokens);
    const yen = ((miss * PRICE.miss + hit * PRICE.hit + out * PRICE.out) / 1e6) * YEN;
    yenAll += yen;
    const laterHit = ls.slice(1).filter((l) => l.cache_read > 0).length;
    console.log(`${s.padEnd(16)} ${String(ls.length).padStart(4)}  ${String(hit).padStart(10)}  ${String(miss).padStart(14)}  ${String(out).padStart(6)}  ${`${laterHit}/${Math.max(0, ls.length - 1)}`.padStart(14)}  ${(yen / ls.length).toFixed(4).padStart(14)}  ${Math.round(sum((l) => l.duration_ms) / ls.length)}ms`);
  }
  console.log(`合計 ${yenAll.toFixed(3)}円（${results.length}件・1件平均 ${(yenAll / results.length).toFixed(4)}円）`);

  const out = join(DIR, `eval_${ROUND}.json`);
  writeFileSync(out, JSON.stringify({ round: ROUND, version: SHEET_PROMPT_VERSION, started, rows, results, usage: [...groups].map(([s, ls]) => ({ section: s, calls: ls.length, cache_read: ls.reduce((a, l) => a + l.cache_read, 0), input_uncached: ls.reduce((a, l) => a + l.input_uncached, 0), output: ls.reduce((a, l) => a + l.output_tokens, 0) })) }, null, 1));
  console.log(`\n保存: ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
