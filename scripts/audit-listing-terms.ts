// scripts/audit-listing-terms.ts — 物件資料の文字層から読んだ「募集の条件」（敷礼・築年・入居時期・契約・更新料・フリーレント・入居の条件・面積）の全件監査（DB は読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-listing-terms.ts [--rows] [--today=2026-09-25]
//   property_pickups の pdf_blob_url がある全行の PDF（1ページ目）の文字層に parseListingTerms を当て、
//   項目ごとの取れた件数・取れなかった行・値の分布と、条件（楽器・法人・外国籍…）の根拠の文字を全部出す（誤読が 0 か目で読む）。
//   --rows: 行ごとの1行（formatListingTerms）と根拠を全部出す
// 2026-09-25 初回: 36行（リアプロ 18・itandi 18）。結果と直した誤読は app/lib/listing-terms.ts の頭のコメント
import { createClient } from "@supabase/supabase-js";
import { extractPdfText } from "../app/lib/pdf-text";
import { parseListingTerms, formatListingTerms, CONDITION_KEYS, CONDITION_LABELS, type ListingTerms } from "../app/lib/listing-terms";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const showRows = process.argv.includes("--rows");
const today = (process.argv.find((a) => a.startsWith("--today=")) ?? "").slice(8) || undefined;

type Row = { id: number; site: string | null; t: ListingTerms };

function dist<T>(rows: Row[], f: (t: ListingTerms) => T): string {
  const m = new Map<string, number>();
  for (const r of rows) { const k = String(f(r.t)); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" / ");
}

(async () => {
  const sb = createClient(url, key);
  const { data, error } = await sb.from("property_pickups").select("id, site, pdf_blob_url").not("pdf_blob_url", "is", null).order("id");
  if (error) { console.error(error.message); process.exit(1); }
  const rows: Row[] = [];
  for (const r of data ?? []) {
    try {
      const res = await fetch(r.pdf_blob_url as string);
      const buf = new Uint8Array(await res.arrayBuffer());
      // 同じ Uint8Array を2回渡すと2回目が空になる（pdfjs が中身を移す）ので写しを渡す
      const x = await extractPdfText(buf.slice(), { maxPages: 1, maxChars: 20000 });
      rows.push({ id: r.id as number, site: r.site as string | null, t: parseListingTerms(x.text, { today }) });
    } catch (e) {
      console.log(`#${r.id} 取れない: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const n = rows.length;
  console.log(`\n=== 対象 ${n} 行（文字あり ${rows.filter((r) => r.t.hasText).length}・形 ${dist(rows, (t) => t.format)}）`);

  console.log("\n■ 項目ごとの取れた件数（null / unknown / unlisted 以外）");
  const got: Array<[string, (t: ListingTerms) => boolean]> = [
    ["敷金", (t) => t.depositMonths != null], ["礼金", (t) => t.keyMoneyMonths != null], ["保証金", (t) => t.guaranteeDeposit != null],
    ["償却・敷引", (t) => t.amortization != null], ["築年", (t) => t.builtYear != null], ["入居時期", (t) => t.moveIn.kind !== "unknown"],
    ["現況", (t) => t.moveIn.current != null], ["契約の種類", (t) => t.contract.kind !== "unknown"], ["契約の年数", (t) => t.contract.years != null],
    ["更新料", (t) => t.renewalFee.kind !== "unlisted" && t.renewalFee.kind !== "blank"], ["面積", (t) => t.areaSqm != null], ["賃料", (t) => t.rentYen != null],
  ];
  for (const [label, f] of got) {
    const miss = rows.filter((r) => !f(r.t));
    console.log(`  ${label.padEnd(6, "　")} ${String(n - miss.length).padStart(2)}/${n}${miss.length ? `  取れない: ${miss.map((r) => `#${r.id}`).join(" ")}` : ""}`);
  }

  console.log("\n■ 値の分布");
  console.log(`  敷金      ${dist(rows, (t) => t.depositMonths)}`);
  console.log(`  礼金      ${dist(rows, (t) => t.keyMoneyMonths)}`);
  console.log(`  敷礼0/0   ${dist(rows, (t) => (t.depositMonths === 0 && t.keyMoneyMonths === 0 ? "敷礼0" : t.depositMonths == null || t.keyMoneyMonths == null ? "不明" : "敷礼あり"))}`);
  console.log(`  出どころ  ${dist(rows, (t) => t.depositSource)}`);
  console.log(`  保証金    ${dist(rows, (t) => t.guaranteeDeposit)}`);
  console.log(`  築年数    ${dist(rows, (t) => t.buildingAgeYears)}`);
  console.log(`  新築      ${dist(rows, (t) => t.newBuild)}`);
  console.log(`  入居時期  ${dist(rows, (t) => t.moveIn.kind === "date" ? `${t.moveIn.date}${t.moveIn.part ?? ""}` : t.moveIn.kind)}`);
  console.log(`  現況      ${dist(rows, (t) => t.moveIn.current)}`);
  console.log(`  契約      ${dist(rows, (t) => `${t.contract.kind}${t.contract.years ?? ""}`)}`);
  console.log(`  更新料    ${dist(rows, (t) => (t.renewalFee.kind === "months" ? `${t.renewalFee.months}ヶ月` : t.renewalFee.kind === "yen" ? "円" : t.renewalFee.kind))}`);
  console.log(`  フリーレント ${dist(rows, (t) => (t.freeRent ? `${t.freeRent.months ?? "?"}ヶ月` : "なし"))}`);

  console.log("\n■ 円で書いてある敷礼（ヶ月への直し方を目で読む）");
  for (const r of rows) {
    const t = r.t;
    if (t.depositYen != null || t.keyMoneyYen != null) console.log(`  #${r.id} 賃料${t.rentYen} 管理費${t.adminFeeYen} → 敷${t.depositYen ?? "-"}円=${t.depositMonths} 礼${t.keyMoneyYen ?? "-"}円=${t.keyMoneyMonths}`);
  }

  console.log("\n■ 入居の条件（ok / consult / ng の根拠を全部）");
  for (const k of CONDITION_KEYS) {
    const hits = rows.filter((r) => r.t.conditions[k].status !== "unlisted");
    console.log(`  [${CONDITION_LABELS[k]}] ok ${hits.filter((r) => r.t.conditions[k].status === "ok").length} / consult ${hits.filter((r) => r.t.conditions[k].status === "consult").length} / ng ${hits.filter((r) => r.t.conditions[k].status === "ng").length} / unlisted ${n - hits.length}`);
    for (const r of hits) console.log(`    #${r.id} ${r.t.conditions[k].status} 「${r.t.conditions[k].evidence}」`);
  }
  console.log(`  単身限定の札: ${rows.filter((r) => r.t.singleOnlyRestricted).map((r) => `#${r.id}`).join(" ") || "なし"}`);

  console.log("\n■ 行ごと（入居時期・契約・更新料の元の文字）");
  for (const r of rows) {
    console.log(`  #${r.id} ${r.site} ${formatListingTerms(r.t)}`);
    if (showRows) console.log(`      ${JSON.stringify(r.t.evidence)}`);
  }
})();
