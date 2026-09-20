// scripts/audit-property-label.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-property-label.ts
//
// 2026-09-20 竹内「ブレインに抜けがあるならそこを補うクエリをつくる」:
//   物件名の抽出（PROPERTY_LABEL_RE）が **🌟 か 【 を必須**にしているため、
//   実送信の「KANOACIA602号室」「ヴィオラ住吉302号室」「・ラムール・ファミリアルA 202号室」を
//   1つも拾えていない（直近30日で 127会話中 30会話＝24%が取りこぼし）。
//   緩める案を**実送信で当てて、拾えた数と誤検出を目で読む**。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { extractPropertyLabels } from "../app/lib/action-ledger";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 今の形（🌟 か 【 が必須） */
const NOW_RE = /(?:🌟|【)\s*([^\n【】🌟]{2,40}?)\s*([0-9０-９]{1,4})\s*号室/g;
/** 案A: 行頭・箇条書き・🌟・【 のどれかで始まる「〇〇 N号室」 */
const A_RE = /(?:^|\n)\s*(?:[・･\-−*]|[①-⑨]|[0-9０-９]{1,2}[.．)）]|🌟|【)?\s*([^\n【】🌟、。：:]{2,40}?)\s*([0-9０-９]{1,4})\s*号室/g;
/** 案B: 案A ＋ 文中でも「〇〇N号室」（直前が助詞・読点でない＝名前が続いている） */
const B_RE = /([^\n【】🌟、。：:\s]{2,40}?)\s*([0-9０-９]{1,4})\s*号室/g;

function run(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(re.source, "g"))) {
    const name = m[1].trim().replace(/^[・･\-−*①-⑨0-9０-９.．)）\s]+/, "");
    if (name.length >= 2) out.push(`${name} ${m[2]}号室`);
  }
  return [...new Set(out)];
}

// ── 案C: 号室の直前の「名前らしい所」だけを取る ────────────────────────────
//   案A・案Bは前置きを名前に巻き込む（「お送りさせて頂きましたお部屋の中でもエスリード…」）。
//   そこで ①号室の直前40字を見て ②区切り（空白・記号・🌟【）で切った**最後のかたまり**を名前にし
//   ③日本語の前置きで終わる物（「〜お部屋」「〜ですと」）は捨てる。
const C_SCOPE_RE = /([^\n]{0,40}?)\s*([0-9０-９]{1,4})\s*号室/g;
/** 名前の切れ目（ここより後ろが物件名） */
const C_CUT_RE = /[\s　、。：:！!？?（）()「」・･\-−*]|[①-⑨]|🌟|【|】/;
/** これで終わる／これを含むなら物件名ではない（実送信の前置きから拾った） */
const C_NOT_NAME = /お部屋|ですと|ますが|ました|ります|います|ください|こちら|中でも|番手|現在|改めて|残り|募集|以下|別の|他の|同じ|上記|下記|そちら|あちら|とも|ので|から|まで|など|次の|今回|前回/;

function runC(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(C_SCOPE_RE)) {
    const head = m[1];
    // 最後の区切りより後ろを名前にする
    const parts = head.split(new RegExp(C_CUT_RE.source, "g"));
    let name = (parts[parts.length - 1] ?? "").trim();
    // 区切りが無い（スペースなしで名前が続く）時は head 全体を見る
    if (!name) name = head.trim();
    name = name.replace(/^[0-9０-９.．)）]+/, "").trim();
    if (name.length < 2 || name.length > 40) continue;
    if (C_NOT_NAME.test(name)) continue;          // 前置きが混ざっていたら捨てる
    if (!/[^\s0-9０-９]/.test(name)) continue;     // 数字だけは名前ではない
    out.push(`${name} ${m[2]}号室`);
  }
  return [...new Set(out)];
}

async function main() {
  const rows: string[] = [];
  for (let page = 0; ; page++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - 180 * 86400_000).toISOString())
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null }>;
    if (r.length === 0) break;
    for (const x of r) if (x.text) rows.push(x.text);
    if (r.length < 1000) break;
    if (page > 9) break;
  }
  const withRoom = rows.filter((t) => /号室/.test(t));
  console.log(`=== スタッフの実送信180日 ${rows.length}通 / 「号室」を含む ${withRoom.length}通 ===\n`);

  for (const [label, re] of [["今の形（🌟・【が必須）", NOW_RE], ["案A（行頭・箇条書きも許す）", A_RE], ["案B（文中も許す）", B_RE]] as const) {
    const got = withRoom.filter((t) => run(re, t).length > 0).length;
    const all = new Set<string>();
    for (const t of withRoom) for (const x of run(re, t)) all.add(x);
    console.log(`  ${label.padEnd(26)} 拾えた通 ${String(got).padStart(4)}/${withRoom.length} (${Math.round(100 * got / Math.max(withRoom.length, 1))}%)  物件名 ${all.size}種類`);
  }

  {
    const got = withRoom.filter((t) => runC(t).length > 0).length;
    const all = new Set<string>();
    for (const t of withRoom) for (const x of runC(t)) all.add(x);
    console.log(`  ${"案C（名前らしい所だけ取る）".padEnd(26)} 拾えた通 ${String(got).padStart(4)}/${withRoom.length} (${Math.round(100 * got / Math.max(withRoom.length, 1))}%)  物件名 ${all.size}種類`);
  }

  // ★ 案C が新しく拾うものを目で読む（汚れていないか）
  console.log(`\n--- 案C が新しく拾う物件名（今の形では取れない）先頭45 ---`);
  const newC = new Set<string>();
  for (const t of withRoom) {
    const now = new Set(run(NOW_RE, t));
    for (const x of runC(t)) if (!now.has(x)) newC.add(x);
  }
  [...newC].slice(0, 45).forEach((x) => console.log(`    ${x}`));
  console.log(`    …全 ${newC.size}種類`);

  // ★ 案C が「今の形で取れていた物」を落としていないか（後退がないか）
  console.log(`\n--- 今の形で取れていたのに案Cが落とす物（後退）---`);
  const lost = new Set<string>();
  for (const t of withRoom) {
    const c = new Set(runC(t));
    for (const x of run(NOW_RE, t)) if (!c.has(x)) lost.add(x);
  }
  [...lost].slice(0, 20).forEach((x) => console.log(`    ${x}`));
  console.log(`    …全 ${lost.size}種類${lost.size === 0 ? "  ✅ 後退なし" : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
