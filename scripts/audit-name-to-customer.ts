// 拡張を再読み込みしなくても「誰に送ったか」を紐付けられるか（読み取りのみ）
//
// 2026-09-21 竹内「一度共有した物件を除いてLINEに送ることが出来ればかなり質高くなる」
//
// ■ 前提（scripts/audit-sent-prop-recent.ts で実測）
//   除外するには「この人に過去何を送ったか」が引けないといけないが、
//   line_group（拡張→LINEグループ）は 9/20 に 79.2% まで直った翌日 **9/21 は 0.1%** に戻っている。
//   ＝ 拡張（background.js）の修正が**再読み込みされていない端末**で動いている。
//
// ■ ここで測ること
//   merge-pdfs は customer_name を**必ず**受け取っている（LINE の見出しに使うため）。
//   これで property_customers を逆引きできるなら、**拡張を触らずにサーバー側だけで紐付く**。
//   逆引きが成立する条件は「名前が一意」であること。同姓同名が多いなら別人に紐付けてしまう。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-name-to-customer.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
/** ⚠ 個人情報なので名前そのものは出さない（1文字目＋伏せ字） */
const mask = (s: string) => (s ? `${s.slice(0, 1)}${"○".repeat(Math.max(1, s.length - 1))}` : "(空)");

async function all(table: string, select: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from(table).select(select).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

/** 拡張が渡してくる形に寄せる（「さん」付き・空白ゆれ） */
function normName(raw: string | null | undefined): string {
  return (raw ?? "").replace(/さん\s*$/, "").replace(/[\s　]+/g, "").trim();
}

async function main() {
  const customers = await all("property_customers", "id, customer_name, status");
  console.log(`=== property_customers ${customers.length}件 ===\n`);

  // ① 名前の一意性（逆引きが成立するか）
  const byName = new Map<string, Array<Record<string, unknown>>>();
  let noName = 0;
  for (const c of customers) {
    const n = normName(c.customer_name as string | null);
    if (!n) { noName++; continue; }
    byName.set(n, [...(byName.get(n) ?? []), c]);
  }
  const uniq = [...byName.entries()].filter(([, a]) => a.length === 1).length;
  const dup = [...byName.entries()].filter(([, a]) => a.length >= 2);
  console.log(`=== ① 名前から1人に決まるか ===`);
  console.log(`   名前あり ${customers.length - noName}件 ／ 名前なし ${noName}件`);
  console.log(`   別々の名前 ${byName.size}種類 ／ **1人に決まる ${uniq}種類（${pct(uniq, byName.size)}）**`);
  console.log(`   同じ名前が2人以上 ${dup.length}種類（${dup.reduce((a, [, x]) => a + x.length, 0)}人）`);
  for (const [n, a] of dup.sort((x, y) => y[1].length - x[1].length).slice(0, 6)) {
    console.log(`     ${mask(n)} … ${a.length}人（status: ${a.map((c) => c.status ?? "-").join(" / ")}）`);
  }
  // 決まらない名前が全体の何%の人にあたるか
  const inDup = dup.reduce((a, [, x]) => a + x.length, 0);
  console.log(`   → 逆引きで**別人に紐付ける恐れがある人**: ${inDup}人 / ${customers.length - noName}人（${pct(inDup, customers.length - noName)}）`);

  // ② 実際に送った時の名前で引けるか（直近の line_group と突き合わせる）
  //    sent_properties に customer_name は無いので、拡張が使う元＝property_customers 側の名前で見る
  console.log(`\n=== ② 会話（conversations）側からも辿れるか ===`);
  const convs = await all("conversations", "id, customer_name, property_customer_id");
  const linked = convs.filter((c) => c.property_customer_id).length;
  console.log(`   会話 ${convs.length}件 ／ 物件顧客に紐付いている ${linked}件（${pct(linked, convs.length)}）`);
  const convByName = new Map<string, number>();
  for (const c of convs) {
    const n = normName(c.customer_name as string | null);
    if (n) convByName.set(n, (convByName.get(n) ?? 0) + 1);
  }
  let bothSides = 0;
  for (const n of byName.keys()) if (convByName.has(n)) bothSides++;
  console.log(`   物件顧客の名前で会話も引ける: ${bothSides}種類 / ${byName.size}種類（${pct(bothSides, byName.size)}）`);

  // ③ status で絞れば一意性が上がるか（終了した顧客を除く）
  console.log(`\n=== ③ 進行中の顧客だけに絞った場合 ===`);
  const ACTIVE_NG = new Set(["成約", "終了", "他決", "追客終了", "キャンセル"]);
  const active = customers.filter((c) => !ACTIVE_NG.has(String(c.status ?? "")));
  const activeByName = new Map<string, number>();
  for (const c of active) {
    const n = normName(c.customer_name as string | null);
    if (n) activeByName.set(n, (activeByName.get(n) ?? 0) + 1);
  }
  const activeUniq = [...activeByName.values()].filter((n) => n === 1).length;
  console.log(`   進行中 ${active.length}人 ／ 名前 ${activeByName.size}種類 ／ 1人に決まる ${activeUniq}種類（${pct(activeUniq, activeByName.size)}）`);
  console.log(`   status の内訳: ${[...new Set(customers.map((c) => String(c.status ?? "-")))].join(" / ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
