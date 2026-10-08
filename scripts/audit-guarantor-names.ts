// scripts/audit-guarantor-names.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-guarantor-names.ts [--out=scripts/.replay-out/guarantor-names.json] [--show-unread=60]
//
// 2026-10-08 竹内「保証会社、分からない保証会社あるかも。ちゃんと確認する。全て何系かも分かるように」:
//   資料（property_pickups の pdf_text・image_lines・terms／image_details.lines）・実際の LINE（スタッフの送信・AIX【保証会社について】）・
//   スタッフが登録した会社（guarantor_companies）に出る保証会社名を全期間で全部洗い出し、分類表（guarantor-companies.ts）で
//   種類が分かる／分からない（表に無い）・種類の確かさ（guarantorTypeSure）・表記ゆれを一覧にする。
//   読み取りのみ・LLM なし。出力は会社名と件数だけ（会話の本文は出さない。根拠の断片は資料の見出しの中身だけ）。
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { guarantorSegmentsOf, companiesInSegment } from "../app/lib/guarantor-material";
import { resolveGuarantor, guarantorTypeSure, GUARANTOR_COMPANY_MASTER, GUARANTOR_SCAN_WORDS, guarantorTypeJa, parseGuarantorTypeJa } from "../app/lib/guarantor-companies";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const OUT = arg("out", "scripts/.replay-out/guarantor-names.json");
const SHOW_UNREAD = Number(arg("show-unread", "60"));
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Tally = { material: number; imageDetails: number; staff: number; aix: number; customs: number; raw: Map<string, number>; staffTypes: Map<string, number> };
const tally = new Map<string, Tally>();
const T = (name: string): Tally => {
  let t = tally.get(name);
  if (!t) { t = { material: 0, imageDetails: 0, staff: 0, aix: 0, customs: 0, raw: new Map(), staffTypes: new Map() }; tally.set(name, t); }
  return t;
};
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
/** 見出しはあるが会社名が読めなかった中身（目で読む用・件数順） */
const unread = new Map<string, number>();

function fromSegments(segs: string[], where: "material" | "imageDetails") {
  const seen = new Set<string>();
  for (const s of segs) {
    const cs = companiesInSegment(s);
    if (cs.length === 0) { const k = s.normalize("NFKC").replace(/\s+/g, " ").slice(0, 60); if (/[ァ-ヶA-Za-z一-龠]{3}/.test(k.replace(/保証会社|利用|必須|加入|必要/g, ""))) bump(unread, k); continue; }
    for (const c of cs) { if (seen.has(c.name)) continue; seen.add(c.name); const t = T(c.name); t[where]++; bump(t.raw, c.name); }
  }
}

/** スタッフの文の保証会社名（マスタの語＋「保証会社は X」「X という…保証会社」「X（独立系）」の X） */
const TYPE_WORD = /(独立系|信販系|信用系|LICC系?)/;
function companiesInStaffText(text: string): Array<{ name: string; raw: string; staffType: string | null }> {
  const t = text.normalize("NFKC");
  const out: Array<{ name: string; raw: string; staffType: string | null }> = [];
  const add = (raw: string, staffType: string | null) => {
    const r = resolveGuarantor(raw.replace(/^(?:株式会社|\(株\))|(?:株式会社|\(株\))$/g, "").trim());
    if (!r.name || r.name.length < 2) return;
    const ex = out.find((o) => o.name === r.name);
    if (ex) { if (!ex.staffType && staffType) ex.staffType = staffType; return; }
    out.push({ name: r.name, raw, staffType });
  };
  // ① マスタの語（3字以上・一般語は除く）
  for (const w of GUARANTOR_SCAN_WORDS) {
    const wn = w.normalize("NFKC");
    if (wn.length < 3 || ["ライフ", "シノケン", "アーク", "エイト", "オセロ", "プレサンス", "セゾン"].includes(w)) continue;
    const re = new RegExp(wn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      if (/^[\x20-\x7e]+$/.test(wn) && (/[A-Za-z0-9]/.test(t[at - 1] ?? "") || /[A-Za-z0-9]/.test(t[at + wn.length] ?? ""))) continue;
      const near = t.slice(at + wn.length, at + wn.length + 30).match(TYPE_WORD);
      add(w, near ? near[1] : null);
    }
  }
  // ② 形から（マスタに無い会社）
  const pats = [
    /保証会社(?:は|が|:|：|\s)\s*(?:株式会社)?([ァ-ヶーA-Za-z][^\s、。,!！?？「」()（）と]{1,24}?)(?:株式会社)?(?:と|という|となり|となります|で|\(|（|、|,|\s|$)/g,
    /([ァ-ヶーA-Za-z一-龠][^\s、。,!！?？「」()（）:：]{1,24}?)(?:株式会社)?という(?:[^\s、。]{0,8})?保証会社/g,
    /([ァ-ヶーA-Za-z][^\s、。,!！?？「」()（）:：]{1,24}?)[（(](独立系|信販系|信用系|LICC系?)[）)]/g,
  ];
  for (const re of pats) for (const m of t.matchAll(re)) {
    const raw = (m[1] ?? "").trim();
    if (!raw || /^(?:こちら|弊社|物件|お部屋|審査|独立系|信販系|信用系|LICC|1社目|2社目|1番手|2番手|否決|利用|必須|加入|保証|会社|その|どこ|何|全て|すべて|各|同じ|別|他|オーナー|管理会社)/.test(raw)) continue;
    if (raw.length > 22 || /[0-9]{3}|円|%|ヶ月|号室/.test(raw)) continue;
    const near = m[2] ?? t.slice((m.index ?? 0) + m[0].length - 2, (m.index ?? 0) + m[0].length + 30).match(TYPE_WORD)?.[1] ?? null;
    add(raw, near);
  }
  return out;
}

async function pageAll<T>(fn: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, size = 500): Promise<T[]> {
  const all: T[] = [];
  for (let p = 0; ; p++) {
    const { data, error } = await fn(p * size, p * size + size - 1);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if ((data ?? []).length < size) break;
  }
  return all;
}

async function main() {
  // ① 売上サポの行（全期間）
  let pickRows = 0;
  await pageAll<{ id: string; pdf_text: string | null; image_lines: string[] | null; terms: unknown }>((a, b) => sb.from("property_pickups").select("id, pdf_text, image_lines, terms").order("id").range(a, b), 300)
    .then((rows) => {
      pickRows = rows.length;
      for (const r of rows) {
        const segs = guarantorSegmentsOf(r.pdf_text);
        for (const l of r.image_lines ?? []) { const m = String(l ?? "").normalize("NFKC").match(/^\s*保証会社\s*[:：]\s*(.+)$/); if (m) segs.push(m[1].trim()); }
        const tt = JSON.stringify(r.terms ?? "");
        if (/保証会社/.test(tt)) segs.push(...guarantorSegmentsOf(tt.replace(/\\n/g, "\n")));
        fromSegments(segs, "material");
      }
    });
  // ② 送った画像の読み取り（全期間）
  const det = await pageAll<{ lines: string[] | null }>((a, b) => sb.from("image_details").select("lines").order("image_url").range(a, b), 500);
  for (const d of det) {
    const segs: string[] = [];
    const joined = (d.lines ?? []).map((x) => String(x ?? "")).join("\n");
    if (!/保証会社/.test(joined)) continue;
    for (const l of d.lines ?? []) { const m = String(l ?? "").normalize("NFKC").match(/^\s*保証会社\s*[:：]?\s*(.+)$/); if (m) segs.push(m[1].trim()); }
    segs.push(...guarantorSegmentsOf(joined));
    fromSegments([...new Set(segs)], "imageDetails");
  }
  // ③ スタッフの送信（全期間・保証会社の語を含む通）
  const msgs = await pageAll<{ conversation_id: string; text: string | null }>((a, b) => sb.from("messages").select("conversation_id, text").neq("sender", "customer").ilike("text", "%保証%").order("created_at").range(a, b), 1000);
  let staffMsgs = 0;
  for (const m of msgs) {
    if (m.conversation_id === YUMA || !m.text) continue;
    if (!/保証会社|独立系|信販系|信用系|LICC/.test(m.text)) continue;
    staffMsgs++;
    for (const c of companiesInStaffText(m.text)) { const t = T(c.name); t.staff++; bump(t.raw, c.raw); if (c.staffType) bump(t.staffTypes, c.staffType); }
  }
  // ④ AIX【保証会社について】・物件確認した（保証会社）の送信
  const aix = await pageAll<{ aix_type: string | null; generated_text: string | null; conversation_id: string | null }>((a, b) => sb.from("aix_usage_logs").select("aix_type, generated_text, conversation_id").or("aix_type.eq.guarantor_info,generated_text.ilike.%保証会社%").order("created_at").range(a, b), 1000);
  let aixRows = 0;
  for (const r of aix) {
    if (r.conversation_id === YUMA || !r.generated_text) continue;
    aixRows++;
    for (const c of companiesInStaffText(r.generated_text)) { const t = T(c.name); t.aix++; bump(t.raw, c.raw); if (c.staffType) bump(t.staffTypes, c.staffType); }
  }
  // ⑤ スタッフが登録した会社
  const { data: customs } = await sb.from("guarantor_companies").select("name, type");
  for (const c of (customs ?? []) as Array<{ name: string; type: string }>) { const r = resolveGuarantor(c.name); const t = T(r.name); t.customs++; bump(t.raw, `${c.name}（登録 ${c.type}）`); }

  const rows = [...tally.entries()].map(([name, t]) => {
    const r = resolveGuarantor(name);
    const sure = guarantorTypeSure(name);
    return {
      name, inMaster: r.known, type: r.known ? guarantorTypeJa(r.type) : "表に無い",
      sure: sure.sure, source: sure.source ?? null,
      material: t.material, imageDetails: t.imageDetails, staff: t.staff, aix: t.aix, customs: t.customs,
      total: t.material + t.imageDetails + t.staff + t.aix + t.customs,
      spellings: [...t.raw.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).slice(0, 6),
      staffSaid: [...t.staffTypes.entries()].map(([k, n]) => `${k}×${n}`),
      staffMismatch: [...t.staffTypes.keys()].some((k) => r.known && r.type !== "unknown" && parseGuarantorTypeJa(k) !== r.type),
    };
  }).sort((a, b) => b.total - a.total);

  console.log(`=== 保証会社の洗い出し（全期間）: 売上サポ ${pickRows}行・画像の読み取り ${det.length}件・スタッフの送信 ${staffMsgs}通・AIX ${aixRows}件・登録 ${(customs ?? []).length}社 ===`);
  console.log("会社名\t表\t種類\t確か\t出所\t資料\t画像\tスタッフ\tAIX\t登録\tスタッフの言った種類\t表記");
  for (const r of rows) console.log([r.name, r.inMaster ? "○" : "×", r.type, r.sure ? "確か" : "-", r.source ?? "-", r.material, r.imageDetails, r.staff, r.aix, r.customs, r.staffSaid.join(" ") + (r.staffMismatch ? " ⚠食い違い" : ""), r.spellings.join(" ")].join("\t"));
  const unk = rows.filter((r) => !r.inMaster);
  console.log(`\n=== 表に無い会社 ${unk.length} ===`);
  for (const r of unk) console.log(`  ${r.name}\t資料${r.material}+画像${r.imageDetails}・スタッフ${r.staff}・AIX${r.aix}\t${r.spellings.join(" ")}`);
  console.log(`\n=== 見出しはあるが会社名が読めなかった中身（上位 ${SHOW_UNREAD}・目で読む） ===`);
  for (const [k, n] of [...unread.entries()].sort((a, b) => b[1] - a[1]).slice(0, SHOW_UNREAD)) console.log(`  ${n}\t${k}`);
  const masterUnseen = GUARANTOR_COMPANY_MASTER.filter((c) => !tally.has(c.name)).map((c) => c.name);
  console.log(`\n=== 表にあるが今回どこにも出なかった会社 ${masterUnseen.length}: ${masterUnseen.join("、")}`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rows, unread: [...unread.entries()].sort((a, b) => b[1] - a[1]) }, null, 1));
  console.log(`\n書き出し: ${OUT}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
