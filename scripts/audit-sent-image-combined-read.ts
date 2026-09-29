// scripts/audit-sent-image-combined-read.ts — 送った画像の読み取りを「1回・推論なし」（readPropertyImageBoth）にして漏れが無いかの監査
//
// 2026-09-29 竹内「更に節約できないか」: 送った画像1枚につき DeepSeek が property_image_read（推論 既定）と
//   property_image_detail（推論 low）を別々に読み、どちらも出力 2,000〜9,000・12〜38秒だった。
//   1回の読み取り（推論なし・温度0）で両方を返す形にする前に、**過去に本番で送った画像**を新しい読み方で読み、
//   保存済みの行（image_details.lines＝旧の読み方）と物件名・号室（sent_image_properties＝照合済み）を1行ずつ見比べる。
//   見る項目: 駐車場・ペット・保証会社・入居可能日・設備・現況・楽器・連帯保証人 ほか全部。可/不可・有/無の反転は別に数える。
//   --baseline を付けると旧の読み方（推論 low の条件の行）でも同じ画像を読み直し、旧どうしの揺れ（基準の揺れ）も出す。
//   ⚠ DB には書かない（読むだけ）。本番の読み取りは変えない。鍵は表示しない。
//   【結果 2026-09-29・30枚】物件名 17/17・号室 17/17・家賃 16/16 は同じ。条件の行は保存済み 353行のうち 55行落ち（洗濯機置場 17/25・設備 8/13＝120字超で捨てていた・
//     連帯保証人 7/12・退去予定 5/7）。続く audit-image-read-grounding.ts で「資料に無い可否を作る」も分かり、条件の行は推論 low のまま残した。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-sent-image-combined-read.ts [--n=30] [--baseline] [--days=14]
import { createClient } from "@supabase/supabase-js";
import { readPropertyImageDetail } from "../app/lib/property-image-read";
import { readPropertyImageBoth } from "./audit-image-both-prompt";
import { resolveReadProperty } from "../app/lib/property-name-match";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const N = Number(arg("n", "30"));
const DAYS = Number(arg("days", "14"));
const BASELINE = process.argv.includes("--baseline");
const FOCUS = ["駐車場", "ペット", "保証会社", "入居可能日", "設備", "現況", "楽器", "連帯保証人", "入居条件", "退去予定", "洗濯機置場", "フリーレント"];

const norm = (s: string) => s.replace(/\s+/g, "").replace(/[：]/g, ":").replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"));
const labelOf = (line: string) => norm(line).split(":")[0] ?? "";
const valueOf = (line: string) => norm(line).split(":").slice(1).join(":");
const byLabel = (lines: string[]) => { const m = new Map<string, string>(); for (const l of lines) { const k = labelOf(l); if (k && !m.has(k)) m.set(k, valueOf(l)); } return m; };
/** 可否・有無の向き（+1 可/有／-1 不可/無/なし／0 どちらとも言えない） */
function polarity(v: string): number {
  if (/不可|無し|なし|無$|空きなし|満車|不要/.test(v)) return -1;
  if (/可|有|あり|空有|空き有|要|必須/.test(v)) return 1;
  return 0;
}
const room = (s: string | null | undefined) => String(s ?? "").trim().replace(/^0+(?=\d)/, "").replace(/号室$/, "");

type Row = { image_url: string; lines: string[]; kind: string; model: string | null; conversation_id: string | null; name: string | null; room: string | null; source: string | null; rent: number | null };

async function sample(): Promise<Row[]> {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  // 送った画像（こちらが送った物）で、旧の読み方の行が残っている物
  const { data, error } = await sb.from("image_details").select("image_url, lines, kind, model, conversation_id, read_at")
    .gte("read_at", since).eq("kind", "property").order("read_at", { ascending: false }).limit(400);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{ image_url: string; lines: unknown; kind: string; model: string | null; conversation_id: string | null }>)
    .filter((r) => Array.isArray(r.lines) && (r.lines as unknown[]).length > 0)
    .filter((r) => !r.model || r.model === "deepseek-flash" || r.model.startsWith("image:"));   // 写し・文字層の行は比べない（旧の画像読みの行だけ）
  const urls = rows.map((r) => r.image_url);
  const sip = new Map<string, { property_name: string | null; room_no: string | null; source: string | null; facts: { rent?: number } | null }>();
  for (let i = 0; i < urls.length; i += 20) {
    const { data: s } = await sb.from("sent_image_properties").select("image_url, property_name, room_no, source, facts").in("image_url", urls.slice(i, i + 20));
    for (const r of (s ?? []) as Array<{ image_url: string; property_name: string | null; room_no: string | null; source: string | null; facts: { rent?: number } | null }>) sip.set(r.image_url, r);
  }
  // 物件名の答えがある物（照合済み＝source が vision 以外）を先に・会話が偏らないよう1会話3枚まで
  const perConv = new Map<string, number>();
  const out: Row[] = [];
  const sorted = [...rows].sort((a, b) => Number(!!(sip.get(b.image_url)?.source && sip.get(b.image_url)?.source !== "vision")) - Number(!!(sip.get(a.image_url)?.source && sip.get(a.image_url)?.source !== "vision")));
  for (const r of sorted) {
    const c = r.conversation_id ?? "-";
    if ((perConv.get(c) ?? 0) >= 3) continue;
    perConv.set(c, (perConv.get(c) ?? 0) + 1);
    const s = sip.get(r.image_url);
    out.push({ image_url: r.image_url, lines: (r.lines as unknown[]).map(String), kind: r.kind, model: r.model, conversation_id: r.conversation_id, name: s?.property_name ?? null, room: s?.room_no ?? null, source: s?.source ?? null, rent: typeof s?.facts?.rent === "number" ? s.facts.rent : null });
    if (out.length >= N) break;
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) { console.error("DEEPSEEK_API_KEY が無い"); process.exit(1); }
  const rows = await sample();
  console.log(`── 監査: 過去 ${DAYS}日に送った画像 ${rows.length}枚（旧の読み方の行あり）${BASELINE ? "・旧の読み方でも読み直す" : ""}\n`);
  const results = await pool(rows, 4, async (r) => {
    const both = await readPropertyImageBoth(r.image_url);
    const base = BASELINE ? await readPropertyImageDetail(r.image_url, { timeoutMs: 90_000 }) : null;
    return { r, both, base };
  });

  const tot = { imgs: 0, ok: 0, savedLines: 0, sameExact: 0, sameLabel: 0, dropped: 0, added: 0, flips: 0, nameOk: 0, nameAsk: 0, roomOk: 0, roomAsk: 0, rentOk: 0, rentAsk: 0, out: 0, ms: 0, kindChanged: 0, baseDropped: 0, baseFlips: 0, baseSaved: 0 };
  const focusDrop: Record<string, number> = {}; const focusSaved: Record<string, number> = {}; const focusAdd: Record<string, number> = {};
  for (const { r, both, base } of results) {
    tot.imgs++;
    const head = `■ ${r.image_url.slice(-44)}  会話 ${(r.conversation_id ?? "-").slice(0, 8)}`;
    if (both.failed) { console.log(`${head}\n   ⚠ 新しい読み方で読めなかった: ${both.read.raw.slice(0, 120)}\n`); continue; }
    tot.ok++; tot.ms += both.ms; tot.out += both.detail.usage?.output ?? 0;
    if (both.detail.kind !== "property") tot.kindChanged++;
    const saved = byLabel(r.lines); const got = byLabel(both.detail.lines);
    console.log(`${head}  ${both.ms}ms 出力 ${both.detail.usage?.output ?? "-"}  kind=${both.detail.kind}`);
    // 物件名・号室・家賃（答え = sent_image_properties・照合済みの物だけ数える）
    const item = both.read.items[0];
    if (r.name && r.source && r.source !== "vision") {
      tot.nameAsk++;
      const ok = !!item && !!resolveReadProperty({ propertyName: item.propertyName, roomNumber: item.roomNumber }, [r.name]);
      if (ok) tot.nameOk++;
      tot.roomAsk++;
      const rOk = !!item && room(item.roomNumber) === room(r.room);
      if (rOk) tot.roomOk++;
      console.log(`   物件 ${ok ? "＝" : "≠"} ${r.name} ${r.room ?? ""} ← 読み「${item?.propertyName ?? "（なし）"} ${item?.roomNumber ?? ""}」${rOk ? "" : "（号室が違う）"}${both.read.items.length > 1 ? `（${both.read.items.length}件）` : ""}`);
    }
    if (r.rent != null) { tot.rentAsk++; const g = item?.rent ?? null; if (g === r.rent) tot.rentOk++; else console.log(`   家賃 ≠ 保存 ${r.rent} ← 読み ${g}`); }
    for (const [k, v] of saved) {
      tot.savedLines++; if (FOCUS.includes(k)) focusSaved[k] = (focusSaved[k] ?? 0) + 1;
      const g = got.get(k);
      if (g === undefined) { tot.dropped++; if (FOCUS.includes(k)) focusDrop[k] = (focusDrop[k] ?? 0) + 1; console.log(`   − ${k}: ${v}`); continue; }
      tot.sameLabel++;
      if (g === v) { tot.sameExact++; console.log(`   ＝ ${k}: ${v}`); continue; }
      const p1 = polarity(v), p2 = polarity(g);
      const flip = p1 !== 0 && p2 !== 0 && p1 !== p2;
      if (flip) tot.flips++;
      console.log(`   ${flip ? "⚠反転" : "〜"} ${k}: ${v}  →  ${g}`);
    }
    for (const [k, g] of got) if (!saved.has(k)) { tot.added++; if (FOCUS.includes(k)) focusAdd[k] = (focusAdd[k] ?? 0) + 1; console.log(`   ＋ ${k}: ${g}`); }
    if (base) {
      const b = byLabel(base.lines);
      let d = 0, f = 0;
      for (const [k, v] of saved) { tot.baseSaved++; const g = b.get(k); if (g === undefined) d++; else { const p1 = polarity(v), p2 = polarity(g); if (p1 && p2 && p1 !== p2) f++; } }
      tot.baseDropped += d; tot.baseFlips += f;
      console.log(`   （基準: 旧の読み方で読み直すと 落ちる ${d}・反転 ${f}・出力 ${base.usage?.output ?? "-"}）`);
    }
    console.log("");
  }
  console.log(`=== まとめ ===`);
  console.log(`読めた ${tot.ok}/${tot.imgs}・平均 ${tot.ok ? Math.round(tot.ms / tot.ok) : 0}ms・出力 平均 ${tot.ok ? Math.round(tot.out / tot.ok) : 0} トークン・物件以外に変わった ${tot.kindChanged}`);
  console.log(`物件名 ${tot.nameOk}/${tot.nameAsk}・号室 ${tot.roomOk}/${tot.roomAsk}・家賃 ${tot.rentOk}/${tot.rentAsk}（照合済みの記録と比べて）`);
  console.log(`保存済みの行 ${tot.savedLines}: 同じ項目がある ${tot.sameLabel}（一字一句同じ ${tot.sameExact}）・落ちた ${tot.dropped}・反転 ${tot.flips}・新しく増えた ${tot.added}`);
  if (BASELINE) console.log(`基準（旧の読み方どうし）: 保存済みの行 ${tot.baseSaved} のうち 落ちる ${tot.baseDropped}・反転 ${tot.baseFlips}`);
  console.log(`項目ごと（落ちた/保存済み・増えた）: ${FOCUS.map((k) => `${k} ${focusDrop[k] ?? 0}/${focusSaved[k] ?? 0}+${focusAdd[k] ?? 0}`).join("・")}`);
  console.log(`（＝ 同じ／〜 書き方の違い／− 新しい読み方で落ちた／＋ 増えた／⚠反転 可否・有無が逆。件数だけでなく行を目で読むこと）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
