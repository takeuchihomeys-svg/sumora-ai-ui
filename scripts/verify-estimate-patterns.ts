// scripts/verify-estimate-patterns.ts
// 実行: VERIFY_BASE_URL=http://localhost:3000 npx tsx --env-file=.env.local scripts/verify-estimate-patterns.ts
//       （本番は VERIFY_BASE_URL を付けなければ https://sumora-ai-ui.vercel.app）
//
// 2026-09-20 竹内「テストして他のパターンでバグや変な言い回しになっていないか確認おねがい
//   設計知見と協力して行う 色んなパターンで」
//
// 設計知見に従った作り:
//  ・「**本番検証は画面が渡すのと同じ形で渡す**」→ AixModal が /api/aix/action に渡すのと同じキー
//    （action / account / conversation_id / customer_name ＋ 見積書の分岐）。
//    ※ 見積書送るの分岐は画面も recent_messages を渡していない（コードで確認済み）
//  ・「**生成文と実送信を同じ整形で突き合わせる**」→ phrase-shape で実送信0件の言い回しを数える
//  ・「**線を引いたら外れた側の中身を必ず読む**」→ 引っかかった文は全文を出す
//  ・書き込みを伴うのでテスト会話「YUMA」だけを使う（竹内さんのルール）
export {};
import { createClient } from "@supabase/supabase-js";
import { extractPhraseShapes } from "../app/lib/phrase-shape";

const BASE = process.env.VERIFY_BASE_URL ?? "https://sumora-ai-ui.vercel.app";
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA（竹内さん本人のテスト会話）
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type Est = { property_name?: string; room_number?: string; rent?: number; management_fee?: number; total?: number; discount?: number; commission?: number; commission_tax?: number };
type Pat = {
  name: string;
  account?: "sumora" | "ieyasu" | "giga";
  est?: Est;
  multi?: Est[];          // 複数枚モード（parsed_estimate が使えないので単体を並べて確認する用）
  campaign?: string;
  want: { discount: boolean; savings: boolean; head: boolean };
};

/** 実物の見積書から拾った数字で組む（作り話の金額にしない） */
const PATTERNS: Pat[] = [
  { name: "A 主流: 割引あり＋節約あり（栄美グランドハイツ 211号室）",
    est: { property_name: "栄美グランドハイツ", room_number: "211", rent: 39000, management_fee: 3000, total: 107610, discount: 12000, commission: 2990, commission_tax: 299 },
    want: { discount: true, savings: true, head: true } },
  { name: "B ★H さん: 割引0円＋節約あり（ハイツカトレア B 202号室）",
    est: { property_name: "ハイツカトレア B", room_number: "202", rent: 59000, management_fee: 0, total: 178090, discount: 0, commission: 2990, commission_tax: 0 },
    want: { discount: false, savings: true, head: true } },
  { name: "C 割引あり・節約0（手数料が標準と同じ＝節約行を出さない）",
    est: { property_name: "テスト管理", room_number: "101", rent: 50000, management_fee: 0, total: 120000, discount: 0, commission: 50000, commission_tax: 5000 },
    want: { discount: false, savings: false, head: true } },
  { name: "D 金額が1つも読めない（受け皿の1文に倒れる）",
    est: { property_name: "", room_number: "", rent: 0, management_fee: 0, total: 0, discount: 0, commission: 0, commission_tax: 0 },
    want: { discount: false, savings: false, head: false } },
  { name: "E 物件名が英字＋スペース（The Peak Osaka Bay 202号室・実送信）",
    est: { property_name: "The Peak Osaka Bay", room_number: "202", rent: 82000, management_fee: 8000, total: 225680, discount: 45000, commission: 2990, commission_tax: 299 },
    want: { discount: true, savings: true, head: true } },
  { name: "F 物件名に記号（フジパレス瓜破Ⅱ番館 305号室・実送信）",
    est: { property_name: "フジパレス瓜破Ⅱ番館", room_number: "305", rent: 70000, management_fee: 4400, total: 156580, discount: 31000, commission: 2990, commission_tax: 299 },
    want: { discount: true, savings: true, head: true } },
  { name: "G 号室が無い（天下茶屋1丁目 貸家・実送信）",
    est: { property_name: "天下茶屋1丁目 貸家", room_number: "", rent: 200000, management_fee: 0, total: 661480, discount: 44000, commission: 2990, commission_tax: 299 },
    want: { discount: true, savings: true, head: true } },
  { name: "H 号室が先頭ゼロ（ジーライズ髙石綾園 0103・実送信）",
    est: { property_name: "ジーライズ髙石綾園", room_number: "0103", rent: 50000, management_fee: 5000, total: 98000, discount: 20000, commission: 2990, commission_tax: 299 },
    want: { discount: true, savings: true, head: true } },
  { name: "I 高額（グレイス ガーデン 204号室・実送信 401,830円）",
    est: { property_name: "グレイス ガーデン", room_number: "204", rent: 120000, management_fee: 10000, total: 401830, discount: 0, commission: 2990, commission_tax: 299 },
    want: { discount: false, savings: true, head: true } },
  { name: "J 家賃だけ読めて他が0（節約額は出るが初期費用は書けない）",
    est: { property_name: "テスト", room_number: "303", rent: 60000, management_fee: 0, total: 0, discount: 0, commission: 0, commission_tax: 0 },
    want: { discount: false, savings: true, head: true } },
  { name: "K イエヤス（仲介手数料0円・実送信のアカウント）", account: "ieyasu",
    est: { property_name: "ハイツカトレア B", room_number: "202", rent: 59000, management_fee: 0, total: 178090, discount: 0, commission: 0, commission_tax: 0 },
    want: { discount: false, savings: true, head: true } },
  { name: "L ギガ賃貸（ドゥーエなんば南 506号室・実送信）", account: "giga",
    est: { property_name: "ドゥーエなんば南", room_number: "506", rent: 98000, management_fee: 9000, total: 50600, discount: 107600, commission: 2990, commission_tax: 299 },
    want: { discount: true, savings: true, head: true } },
  { name: "M キャンペーン入力あり（2通目に入るか）",
    est: { property_name: "栄美グランドハイツ", room_number: "211", rent: 39000, management_fee: 3000, total: 107610, discount: 12000, commission: 2990, commission_tax: 299 },
    campaign: "礼金0円", want: { discount: true, savings: true, head: true } },
  { name: "N 物件名がとても長い（体裁が崩れないか）",
    est: { property_name: "エスリード新大阪グランファーストレジデンスタワー", room_number: "1208", rent: 95000, management_fee: 9000, total: 146000, discount: 34000, commission: 2990, commission_tax: 299 },
    want: { discount: true, savings: true, head: true } },
];

/** 変な言い回し・壊れた出力の点検（実データで0件と分かっている形だけ） */
const BAD: Array<{ label: string; re: RegExp; where: "both" | "body" | "cover" }> = [
  { label: "敬称の二重（さんさん／さん様）", re: /さん\s*(さん|様)/, where: "both" },
  { label: "プレースホルダ ○○ が残っている", re: /[○〇◯]{2,}\s*(さん|様)/, where: "both" },
  { label: "NaN・undefined・null", re: /NaN|undefined|null(?!ptr)/, where: "both" },
  { label: "0円の金額（：0円 ／ より0円）", re: /[：:]\s*0\s*円|より\s*0\s*円|🌟\s*0\s*円/, where: "both" },
  { label: "禁止語「お待たせ致しました」", re: /お待たせ(?:致しました|しました)/, where: "both" },
  { label: "作業メモ・箇条書き・Markdown 見出し", re: /^\s*[-*#]|^\s*⚠|確認事項\s*[：:]|\*\*/m, where: "both" },
  { label: "スタッフへの問い合わせ文", re: /分かりません|わかりません|お客様に直接|対応推奨|返信案/, where: "both" },
  { label: "他ブランド名の混入", re: /(?:イエヤス|ギガ賃貸|スモラ)/, where: "cover" },   // カバーレターは1通目と重複させない（後で account で判定）
  { label: "2通目に金額（初期費用：〇円）", re: /初期費用\s*[：:]\s*[0-9０-９〇,，]+\s*円/, where: "cover" },
  { label: "2通目に割引の金額", re: /(?:🌟|⭐)?\s*[0-9０-９〇,，]+\s*円\s*割引させて(?:頂|いただ)き/u, where: "cover" },
  { label: "2通目に節約の金額", re: /一般的な不動産業者より\s*[0-9０-９〇,，]+\s*円\s*節約/, where: "cover" },
  { label: "2通目に日割の注記（1通目と重複）", re: /※\s*ご?入居日によって日割/, where: "cover" },
];

async function loadSentPhrases(): Promise<Set<string>> {
  const s = new Set<string>();
  for (let page = 0; ; page++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    const rows = (data ?? []) as Array<{ text: string | null }>;
    if (rows.length === 0) break;
    for (const m of rows) for (const p of extractPhraseShapes(m.text ?? "")) s.add(p.predicate);
    if (rows.length < 1000) break;
    if (page > 14) break;
  }
  return s;
}

async function main() {
  const sent = await loadSentPhrases();
  console.log(`── 実送信365日の言い回し ${sent.size} 種類を物差しにする`);
  console.log(`── 生成先: ${BASE}  会話: YUMA\n`);

  let ng = 0;
  const summary: Array<{ name: string; ok: boolean; notes: string[] }> = [];

  for (const p of PATTERNS) {
    const notes: string[] = [];
    const body: Record<string, unknown> = {
      action: "estimate_sheet", account: p.account ?? "sumora",
      conversation_id: CONV, customer_name: "YUMA",
      parsed_estimate: p.est,
    };
    if (p.campaign) body.estimate_campaign = p.campaign;

    const res = await fetch(`${BASE}/api/aix/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
    });
    const raw = await res.text();
    console.log(`═══ ${p.name} ═══`);
    if (!res.ok) { console.log(`  ⚠ HTTP ${res.status}: ${raw.slice(0, 200)}\n`); ng++; summary.push({ name: p.name, ok: false, notes: ["HTTP エラー"] }); continue; }
    const j = JSON.parse(raw) as Record<string, unknown>;
    const text = String(j.message_text ?? "");
    const cover = String(j.coverLetter ?? j.cover_letter ?? "");

    console.log("  ─ 1通目（金額文）─");
    console.log(text.split("\n").map((l) => `    ${l}`).join("\n"));
    if (cover) { console.log("  ─ 2通目（カバーレター）─"); console.log(cover.split("\n").map((l) => `    ${l}`).join("\n")); }

    // ① 構成
    const hasHead = /【.+】/.test(text);
    const hasDiscount = /(?:🌟|⭐)\s*[0-9,]+円割引させて頂き/u.test(text);
    const hasSavings = /なら一般的な不動産業者より[0-9,]+円節約出来ます！！/.test(text);
    const hasNote = /※ご入居日によって日割家賃が発生致します。/.test(text);
    const chk = (label: string, cond: boolean) => { if (!cond) { notes.push(label); ng++; } return cond ? "✅" : "⚠"; };
    console.log(`  ${chk("見出し", hasHead === p.want.head)} 見出し ${hasHead ? "あり" : "なし"}（期待 ${p.want.head ? "あり" : "なし"}）`
      + `  ${chk("割引行", hasDiscount === p.want.discount)} 割引 ${hasDiscount ? "あり" : "なし"}（期待 ${p.want.discount ? "あり" : "なし"}）`
      + `  ${chk("節約行", hasSavings === p.want.savings)} 節約 ${hasSavings ? "あり" : "なし"}（期待 ${p.want.savings ? "あり" : "なし"}）`
      + `  ${chk("日割注記", hasNote)} 注記`);

    // ② 変な言い回し・壊れた出力
    const accName = p.account === "ieyasu" ? "イエヤス" : p.account === "giga" ? "ギガ賃貸" : "スモラ";
    for (const b of BAD) {
      const targets: Array<[string, string]> = b.where === "body" ? [["1通目", text]]
        : b.where === "cover" ? [["2通目", cover]] : [["1通目", text], ["2通目", cover]];
      for (const [where, t] of targets) {
        if (!t) continue;
        // 他ブランドの判定はアカウント名を除いて見る
        const probe = b.label.includes("他ブランド") ? t.split(accName).join("") : t;
        const m = probe.match(b.re);
        if (m) { notes.push(`${where}: ${b.label}「${m[0].slice(0, 30)}」`); ng++; console.log(`  ⚠ ${where}: ${b.label} → ${JSON.stringify(m[0].slice(0, 40))}`); }
      }
    }

    // ③ キャンペーン
    if (p.campaign) {
      const inCover = cover.includes(p.campaign.replace(/円$/, "")) || /キャンペーン/.test(cover);
      if (!inCover) { notes.push("キャンペーンが2通目に入っていない"); ng++; }
      console.log(`  ${inCover ? "✅" : "⚠"} キャンペーン「${p.campaign}」が2通目にある`);
    }

    // ④ 実送信に無い言い回し（創作）— カバーレターだけ見る（1通目は固定テンプレ）
    if (cover) {
      const shapes = extractPhraseShapes(cover);
      const unseen = shapes.filter((s) => !sent.has(s.predicate));
      console.log(`  ${unseen.length === 0 ? "✅" : "⚠"} 2通目に実送信0件の言い回し: ${unseen.length}件 / 全${shapes.length}件`);
      for (const u of unseen) { console.log(`     0件: ${JSON.stringify(u.clause)}`); notes.push(`2通目に実送信0件の言い回し: ${u.clause.slice(0, 40)}`); }
    }
    console.log("");
    summary.push({ name: p.name, ok: notes.length === 0, notes });
  }

  console.log("━━━━━━━━━━ まとめ ━━━━━━━━━━");
  for (const s of summary) console.log(`  ${s.ok ? "✅" : "⚠"} ${s.name}${s.ok ? "" : `\n        ${s.notes.join("\n        ")}`}`);
  const bad = summary.filter((s) => !s.ok).length;
  console.log(`\n  ${bad === 0 ? "✅ 全パターンそろっている" : `⚠ ${bad}/${summary.length} パターンで引っかかりあり`}`);
  if (bad > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
