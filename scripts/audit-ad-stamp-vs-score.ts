// 2026-09-30 売上サポの AD の札（物件名の横・資料の文字）と採点が使った AD の月数（reason_codes の段）が食い違う行を全件で数える（読み取りのみ）
//   竹内さんの実物: TIO岸和田 103（#1952）札「広告料2.0ヶ月」↔ 採点「AD 1ヶ月 +15」
//   npx tsx --env-file=.env.local scripts/audit-ad-stamp-vs-score.ts [--show=30]
import { createClient } from "@supabase/supabase-js";
import { listingAdStamp, adMonthsOfStamp } from "../app/lib/pickup-listing-text";
import { parsePropertyFacts } from "../app/lib/property-brain";
import { pickupAdTier, type PickupAdTier } from "../app/lib/pickup-ad-priority";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SHOW = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=30").slice(7));

// 旧の札（最後の行の「最後の」見出しから）を比べるための写し（2026-09-30 以前の listingAdText）
const AD_HEAD = String.raw`(?<![A-Za-zＡ-Ｚａ-ｚ])(?:A\s?D|Ａ\s?Ｄ)(?![A-Za-zＡ-Ｚａ-ｚ])|広告料|広告費`;
const AD_HEAD_LAST_LINE = String.raw`${AD_HEAD}|(?<![A-Za-zＡ-Ｚａ-ｚ])(?:BK|ＢＫ)(?![A-Za-zＡ-Ｚａ-ｚ])|[一-龥]{0,6}(?:委託料|業務報酬|委託報酬|業務手数料)`;
const LAST_LINE_RE = new RegExp(String.raw`(?:${AD_HEAD_LAST_LINE})[ \t　]*[:：]?[ \t　]*(?=[\d０-９]|なし|無し)`, "gu");
function oldLastLineStamp(pdfText: string): string | null {
  const lines = pdfText.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const hits = [...last.matchAll(LAST_LINE_RE)];
  return hits.length ? last.slice(hits[hits.length - 1].index).trim() : null;
}

function tierOfMonths(m: number | null): PickupAdTier {
  if (m == null) return "unknown";
  const a = m + 0.01;
  if (a >= 2) return "ad2";
  if (a >= 1.5) return "ad15";
  if (a >= 1) return "ad1";
  return "low";
}

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("property_pickups").select("id, created_at, customer_name, property_name, room_no, summary_text, pdf_text, reason_codes, ad_yen").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  let withStamp = 0, mismatchNew = 0, mismatchOld = 0, changedStamp = 0;
  const shown: string[] = [], changed: string[] = [], unknownShown: string[] = [];
  let unknownButStamp = 0;
  const cross: Record<string, number> = {};
  for (const r of rows) {
    const pdf = String(r.pdf_text ?? "");
    const stamp = listingAdStamp(pdf);
    if (!stamp) continue;
    withStamp++;
    const f = parsePropertyFacts(String(r.summary_text ?? ""));
    const rent = f.rentYen;
    const stampM = adMonthsOfStamp(stamp, rent);
    const scoreTier = pickupAdTier(r.reason_codes as string[] | null);
    const stampTier = tierOfMonths(stampM);
    const old = oldLastLineStamp(pdf);
    const oldTier = old ? tierOfMonths(adMonthsOfStamp(old, rent)) : stampTier;
    if (old && old !== stamp.trim()) { changedStamp++; changed.push(`#${r.id} ${r.property_name} 旧「${old}」→ 新「${stamp}」`); }
    if (stampM != null && scoreTier === "unknown") { unknownButStamp++; if (unknownShown.length < SHOW) unknownShown.push(`#${r.id} ${r.property_name} 札「${stamp}」codes=${JSON.stringify((r.reason_codes as string[] | null)?.filter((c) => /^AD_/.test(c)))}`); }
    if (stampM == null || scoreTier === "unknown") continue;
    const key = `${scoreTier}→札${stampTier}`;
    cross[key] = (cross[key] ?? 0) + 1;
    if (stampTier !== scoreTier) {
      mismatchNew++;
      if (shown.length < SHOW) shown.push(`#${r.id} ${String(r.created_at).slice(0, 10)} ${r.property_name} ${r.room_no ?? ""} 採点=${scoreTier}（説明文 AD ${f.adMonths ?? (f.adYen != null ? `${f.adYen}円` : "-")}）札=「${stamp}」`);
    }
    if (oldTier !== scoreTier) mismatchOld++;
  }
  console.log(`全 ${rows.length} 行・札のある行 ${withStamp}・札が旧→新で変わった行 ${changedStamp}`);
  console.log(`採点の段と札の段が違う行: 旧の札 ${mismatchOld} → 新の札 ${mismatchNew}`);
  console.log("段の組み合わせ（採点→札）:", Object.entries(cross).sort((a, b) => b[1] - a[1]));
  console.log("\n食い違いの実物（新の札）:\n" + shown.join("\n"));
  console.log("\n札が旧→新で変わった行（目で読む）:\n" + changed.join("\n"));
  console.log(`\n採点は AD 不明なのに札で月数が読める行: ${unknownButStamp}\n` + unknownShown.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
