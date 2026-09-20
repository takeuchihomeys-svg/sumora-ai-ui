// scripts/audit-estimate-body.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-body.ts
//
// 2026-09-20 竹内（H さん事例）「AIX のテンプレートの部分くずれてしまっているかも」:
//   見積書の金額文を1つの純関数（app/lib/estimate-body.ts）に寄せたので、
//   **過去に実際に送った文を壊していないか**を全件で確かめる。
//   手順: 実送信の本文から材料（物件名・割引・初期費用・節約）を読み取り → 新関数に入れ直し →
//        元の文と一致するか。一致しない通は**全部目で読む**（件数だけ見ない）。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { buildEstimateMessage } from "../app/lib/estimate-body";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

// ※ tsconfig の target が ES2017 なので名前付きキャプチャは使えない（番号で受ける）
const HEAD_RE = /^([①-⑨]|[0-9]+\.)?【([^】]+)】\s*$/;
const DISCOUNT_RE = /🌟\s*([0-9０-９,，]+\s*円)\s*割引させて頂き/;
const TOTAL_RE = /初期費用[：:]\s*([0-9０-９,，]+\s*円)/;
const SAVINGS_RE = /(スモラ|イエヤス|ギガ賃貸)なら一般的な不動産業者より\s*([0-9０-９,，]+\s*円)\s*節約出来ます/;

/** 1通の本文を物件ごとのまとまりに割る */
function parseItems(text: string): Array<{ badge: string | null; name: string; discount: string | null; total: string | null; savings: string | null; accountName: string }> {
  const lines = text.split("\n");
  const out: Array<{ badge: string | null; name: string; discount: string | null; total: string | null; savings: string | null; accountName: string }> = [];
  let cur: (typeof out)[0] | null = null;
  for (const line of lines) {
    const h = line.match(HEAD_RE);
    if (h) {
      if (cur) out.push(cur);
      cur = { badge: h[1] ?? null, name: h[2].trim(), discount: null, total: null, savings: null, accountName: "スモラ" };
      continue;
    }
    if (!cur) continue;
    const d = line.match(DISCOUNT_RE); if (d) cur.discount = d[1].replace(/\s/g, "");
    const t = line.match(TOTAL_RE);    if (t) cur.total = t[1].replace(/\s/g, "");
    const s = line.match(SAVINGS_RE);  if (s) { cur.savings = s[2].replace(/\s/g, ""); cur.accountName = s[1]; }
  }
  if (cur) out.push(cur);
  return out;
}

async function main() {
  const { data } = await sb.from("messages").select("text, created_at, conversation_id").eq("sender", "staff")
    .gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
    .like("text", "%初期費用：%").order("created_at", { ascending: false }).limit(2000);
  const rows = (data ?? []) as Array<{ text: string; created_at: string; conversation_id: string }>;
  console.log(`=== 実送信365日「初期費用：」を含む ${rows.length}通 に新しい関数を当てる ===\n`);

  let same = 0, staffAdded = 0, unparsed = 0;
  const diffs: Array<{ at: string; before: string; after: string }> = [];
  for (const r of rows) {
    const items = parseItems(r.text);
    if (items.length === 0) { unparsed++; continue; }
    // 元の文に日割の注記があるかを合わせる（注記の有無はこの監査の対象ではない）
    const hasNote = /日割家賃|日割り家賃/.test(r.text);
    const after = buildEstimateMessage(
      items.map((i) => ({ badge: i.badge, propertyName: i.name, total: i.total, discount: i.discount, savings: i.savings, accountName: i.accountName })),
      { dayRentNote: hasNote },
    );
    // 比べるのは「行の並び」。元の文には注記の言い回しの揺れ（発生致します／変動します）があるので末尾の注記行は外して比べる
    const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l && !/^※/.test(l)).join("\n");
    if (norm(after) === norm(r.text)) { same++; continue; }
    // スタッフが前後に文を足しただけか（新しい関数が作る行が、元の文にその順番で全部入っているか）＝構成は壊れていない
    const beforeLines = norm(r.text).split("\n");
    let i = 0;
    for (const l of norm(after).split("\n")) { const at = beforeLines.indexOf(l, i); if (at < 0) { i = -1; break; } i = at + 1; }
    if (i >= 0) { staffAdded++; continue; }
    diffs.push({ at: String(r.created_at).slice(0, 16), before: r.text, after });
  }

  console.log(`  そのまま一致            ${same}通`);
  console.log(`  スタッフが文を足しただけ ${staffAdded}通（構成は同じ）`);
  console.log(`  読み取れず               ${unparsed}通（【物件名】の見出しが無い＝手打ちの文）`);
  console.log(`  **構成が変わった        ${diffs.length}通**\n`);
  console.log(`--- 構成が変わった通を全部読む ---`);
  for (const d of diffs) {
    console.log(`\n[${d.at}]`);
    console.log(`  ▼ 実際に送った文`);
    console.log(d.before.split("\n").map((l) => `      ${l}`).join("\n"));
    console.log(`  ▲ 新しい関数が作る文`);
    console.log(d.after.split("\n").map((l) => `      ${l}`).join("\n"));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
