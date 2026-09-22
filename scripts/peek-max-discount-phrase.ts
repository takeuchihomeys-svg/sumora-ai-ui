// 「最大限割引しました御見積書…」をスタッフは実際に書いているのか（読み取りのみ）
// 2026-09-23 差分の監査で、AIX【物件確認した】の下書きから15回消されていた。
//   消すべきか決める前に、実送信に何通あるかを数える（設計知見「実送信で線を引く」）。
// 実行: npx tsx --env-file=.env.local scripts/peek-max-discount-phrase.ts [DAYS=365]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
/** 「最大限割引しました」＋見積書の同封（消されていた形） */
const WITH_DISCOUNT = /最大限割引[^。\n]{0,10}(御見積書|お見積書|見積書)[^。\n]{0,12}(同封|お送り|送付)/;
/** 割引を言わない形（足されていた形） */
const PLAIN = /(?<!最大限割引[^。\n]{0,10})(御見積書|お見積書|見積書)[^。\n]{0,12}(同封|ご査収)/;
/** 「最大限割引」単体（見積書と結びつかない使い方も見る） */
const DISCOUNT_ANY = /最大限割引|最大限お値引|限界まで割引/;

async function page(table: string, cols: string, since: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(`${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs = await page("messages", "sender, text, created_at, is_aix_generated", since);
  const staff = msgs.filter((m) => m.sender !== "customer" && String(m.text ?? "").trim() && m.text !== "[画像]");
  const texts = staff.map((m) => String(m.text ?? ""));
  console.log(`直近${days}日のこちらの送信 ${texts.length}通\n`);

  const withD = texts.filter((t) => WITH_DISCOUNT.test(t));
  const plain = texts.filter((t) => !WITH_DISCOUNT.test(t) && PLAIN.test(t));
  const anyD = texts.filter((t) => DISCOUNT_ANY.test(t));
  console.log(`① 見積書の同封・ご査収を言っている通`);
  console.log(`   「最大限割引しました」つき  ${String(withD.length).padStart(4)}通（同封を言う通のうち ${pct(withD.length, withD.length + plain.length)}）`);
  console.log(`   割引を言わない形            ${String(plain.length).padStart(4)}通（${pct(plain.length, withD.length + plain.length)}）`);
  console.log(`\n② 「最大限割引」という言葉そのもの: ${anyD.length}通（こちらの送信の ${pct(anyD.length, texts.length)}）`);

  // AIX で送った通と手打ちで分ける（テンプレートの癖か、人の言葉かを見る）
  const aixT = staff.filter((m) => m.is_aix_generated === true).map((m) => String(m.text ?? ""));
  const manT = staff.filter((m) => m.is_aix_generated !== true).map((m) => String(m.text ?? ""));
  console.log(`\n③ どちらの経路で出ているか`);
  console.log(`   AIX で送った通 ${aixT.length}: 「最大限割引」つきの同封 ${aixT.filter((t) => WITH_DISCOUNT.test(t)).length} ／ 割引なしの同封 ${aixT.filter((t) => !WITH_DISCOUNT.test(t) && PLAIN.test(t)).length}`);
  console.log(`   手打ち ${manT.length}: 「最大限割引」つきの同封 ${manT.filter((t) => WITH_DISCOUNT.test(t)).length} ／ 割引なしの同封 ${manT.filter((t) => !WITH_DISCOUNT.test(t) && PLAIN.test(t)).length}`);

  console.log(`\n④ 実物（「最大限割引」つき・5通）`);
  for (const t of withD.slice(0, 5)) console.log(`   ・${t.replace(/\n/g, " / ").slice(0, 96)}`);
  console.log(`\n⑤ 実物（割引を言わない同封・5通）`);
  for (const t of plain.slice(0, 5)) console.log(`   ・${t.replace(/\n/g, " / ").slice(0, 96)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
