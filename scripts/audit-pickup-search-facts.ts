// scripts/audit-pickup-search-facts.ts
// AIX【物件ピックアップした】の1行目でスタッフが足した／直した条件の語（区・市・沿線・駅・家賃の万円・間取り）が、
// 「今回実際に検索した条件」（search_audits.filled.form・送付の前12時間）と「登録の希望条件」（property_customers）のどちらにあったかを数える
// （読むだけ・LLM なし・費用0）。AIX が知り得た材料が増えたかの物差し。
// 2026-10-06 ⑰ 竹内「物件ピックアップの文のところもAIXツールと連携したら、最善の文が出来る」
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-search-facts.ts [--days=60] [--hours=12]
import { createClient } from "@supabase/supabase-js";
import { searchedConditionsFrom, type SearchAuditRow } from "../app/lib/pickup-search-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "60"), 10);
const HOURS = parseInt(String(args.hours ?? "12"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const norm = (s: string) => String(s ?? "").replace(EMOJI, "").replace(/[\s　]+/g, "");
/** 1行目の条件の語（区・市・町・沿線・駅・万円・間取り） */
function condTokens(line: string): string[] {
  const s = norm(line).normalize("NFKC");
  const out = new Set<string>();
  for (const m of s.matchAll(/([一-鿿ぁ-んァ-ヶ]{1,6}?)(区|市)(?![役場])/g)) out.add(m[1] + m[2]);
  for (const m of s.matchAll(/([一-鿿ァ-ヶA-Za-z]{2,10}線)/g)) out.add(m[1]);
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)万/g)) out.add(`${m[1]}万`);
  for (const m of s.matchAll(/(\d[SLDKR]{1,4})/gi)) out.add(m[1].toUpperCase());
  return [...out];
}
function inSearched(tok: string, c: ReturnType<typeof searchedConditionsFrom>): boolean {
  if (!c) return false;
  if (/万$/.test(tok)) { const v = parseFloat(tok) * 10000; return c.rentMax === v || c.rentMin === v; }
  if (/^\d[SLDKR]/i.test(tok)) return c.layouts.some((l) => l.toUpperCase().includes(tok));
  return [...c.wards, ...c.lines, ...c.stations].some((x) => x.includes(tok) || tok.includes(x.replace(/^大阪市|^大阪府/, "")));
}

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const { data: ex, error } = await sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, created_at").eq("entry_source", "aix_action")
    .like("aix_action", "property_send%").gte("created_at", since).neq("conversation_id", YUMA_CONVERSATION_ID).not("ai_draft", "is", null).order("created_at").limit(2000);
  if (error) throw new Error(error.message);
  let pairs = 0, withSearch = 0, firstEdited = 0, addedTok = 0, foundSearched = 0, foundRegistered = 0, foundOnlySearched = 0;
  for (const p of (ex ?? []) as Row[]) {
    const first = (s: string) => String(s).split("\n").map((x) => x.trim()).filter((x) => x && !/^[^\s]{1,10}さん$|お世話|お待たせ|夜分/.test(x))[0] ?? "";
    const d1 = first(p.ai_draft), s1 = first(p.sent_reply);
    pairs++;
    const { data: conv } = await sb.from("conversations").select("property_customer_id").eq("id", p.conversation_id).maybeSingle();
    const pc = (conv as Row | null)?.property_customer_id;
    if (!pc) continue;
    const t = Date.parse(p.created_at);
    const { data: audits } = await sb.from("search_audits").select("site, is_wide, created_at, status, filled").eq("property_customer_id", String(pc)).eq("status", "finished")
      .gte("created_at", new Date(t - HOURS * 3_600_000).toISOString()).lte("created_at", new Date(t).toISOString()).limit(12);
    const searched = searchedConditionsFrom((audits ?? []) as SearchAuditRow[], t, HOURS * 3_600_000);
    if (searched) withSearch++;
    if (norm(d1) === norm(s1)) continue;
    firstEdited++;
    const dTok = new Set(condTokens(d1));
    const added = condTokens(s1).filter((x) => !dTok.has(x));
    if (!added.length) continue;
    const { data: cust } = await sb.from("property_customers").select("desired_area, rent_max, max_rent, floor_plan, layout, preferences, other_requests, raw_format_text").eq("id", pc).maybeSingle();
    const reg = norm(JSON.stringify(cust ?? {})).normalize("NFKC");
    for (const tok of added) {
      addedTok++;
      const inS = inSearched(tok, searched);
      const inR = reg.includes(tok) || (/万$/.test(tok) && reg.includes(String(parseFloat(tok) * 10000)));
      if (inS) foundSearched++; if (inR) foundRegistered++; if (inS && !inR) foundOnlySearched++;
    }
  }
  console.log(`=== 物件ピックアップの1行目（${DAYS}日・組 ${pairs}・送付の前 ${HOURS}時間に検索の記録がある ${withSearch}）===`);
  console.log(`1行目をスタッフが直した ${firstEdited}組・スタッフが足した条件の語 ${addedTok}個`);
  console.log(`  登録の希望条件にあった ${foundRegistered}・今回実際に検索した条件にあった ${foundSearched}（検索した条件にだけあった＝今回から AIX が知り得る ${foundOnlySearched}）`);
})().catch((e) => { console.error(e); process.exit(1); });
