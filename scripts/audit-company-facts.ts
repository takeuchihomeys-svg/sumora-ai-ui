// 「会社として答えが1つに決まる事実」を実送信から集めて、固定で渡す候補を作る（読み取りのみ）
//
// 2026-09-23 竹内「行う（固定の事実を別枠で必ず渡す）／実際の成約データや会話を見て」
//   ＋ 竹内「エポス否決なら全保連・GTN等で審査可能 ってところこれは物件によって保証会社に違いあるから
//     適当に答えない」
//
// 【線引き（竹内さんの指摘から）】
//   ✅ 固定してよい＝**いつ・どの物件でも同じ答え**になること
//       会社の運営形態（オンライン専門・店舗なし）／仲介手数料の額／緊急連絡先のルール（3親等以内）／
//       申込に必要な書類／キャンセルできる時期
//   ❌ 固定してはいけない＝**物件・保証会社・お客様によって変わる**こと
//       保証会社の名前や種類／家賃・初期費用の額／入居可能日／退去予定／設備の有無／募集状況
//       （「こちら」「この物件」のように特定を指す文もここ）
//
// 設計知見「実送信で線を引く」に従い、**スタッフが繰り返し書いている**言い回しだけを候補にする。
// 実行: npx tsx --env-file=.env.local scripts/audit-company-facts.ts [DAYS=365] [MIN=5]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(2)}%`);

/** 「いつ・どの物件でも同じ答え」になる問い。お客様が実際に聞いてくる形で書く */
const TOPICS: Array<{ q: string; re: RegExp; note: string }> = [
  { q: "店舗に行けるか／来店できるか", re: /(オンライン専門|来店(不可|は|での)|店舗(では|は)?(無|な)(く|い)|事務所(となり|ではあり))/, note: "会社の運営形態" },
  { q: "仲介手数料はいくらか", re: /(仲介手数料)[^。\n]{0,20}(無料|0円|かかりません|発生しません|一律)/, note: "会社の方針" },
  { q: "緊急連絡先は誰にすればよいか", re: /3親等以内/, note: "申込のルール" },
  { q: "緊急連絡先は必須か", re: /緊急連絡先[^。\n]{0,12}(必須|必要)/, note: "申込のルール" },
  { q: "申込に何が必要か", re: /(お申込|申込)[^。\n]{0,10}(必要な)?(ご)?情報[^。\n]{0,8}(となり|です)|本人確認書類[^。\n]{0,20}(写真|お送り)/, note: "申込のルール" },
  { q: "いつまでキャンセルできるか", re: /(審査|保証会社)[^。\n]{0,14}(通過|通る)[^。\n]{0,10}(まで|前)[^。\n]{0,10}キャンセル|キャンセル(料)?[^。\n]{0,10}(かかりません|無料|発生しません)/, note: "会社の運用" },
  { q: "内覧はオンラインでできるか", re: /オンライン(内覧|内見)/, note: "会社のサービス" },
  { q: "室内の写真は撮ってもらえるか", re: /(室内|お部屋)[^。\n]{0,6}(写真|撮影)[^。\n]{0,10}(承|可能|させて)/, note: "会社のサービス" },
  { q: "日割家賃はかかるか", re: /日割(家賃|り家賃)/, note: "賃貸の一般ルール" },
  { q: "前家賃とは", re: /前家賃/, note: "賃貸の一般ルール" },
  { q: "対応エリアはどこか", re: /(大阪府[^。\n]{0,6}(全域|全物件)|大阪[^。\n]{0,4}全域[^。\n]{0,10}(対応|ご紹介))/, note: "会社の対応範囲" },
];

async function main() {
  const days = Number(process.env.DAYS ?? 365);
  const MIN = Number(process.env.MIN ?? 5);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs: Array<{ text: string | null; sender: string | null }> = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("messages").select("text, sender")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as typeof msgs; msgs.push(...r); if (r.length < 1000) break;
  }
  const staff = msgs.filter((m) => m.sender !== "customer" && (m.text ?? "").trim() && m.text !== "[画像]").map((m) => String(m.text));
  console.log(`直近${days}日のこちらの送信 ${staff.length}通\n`);
  console.log(`【いつ・どの物件でも同じ答えになる問い】スタッフが実際に何通書いているか（${MIN}通以上を候補にする）\n`);
  console.log(`   ${"お客様の問い".padEnd(28)} ${"通数".padStart(5)} ／ 割合 ／ 種別`);
  const cands: Array<{ q: string; n: number; examples: string[] }> = [];
  for (const t of TOPICS) {
    const hit = staff.filter((s) => t.re.test(s));
    console.log(`   ${t.q.padEnd(28)} ${String(hit.length).padStart(5)} ／ ${pct(hit.length, staff.length).padStart(7)} ／ ${t.note}`);
    if (hit.length >= MIN) {
      // 特定の物件を指す文は候補から外す（竹内さんの指摘）
      const generic = hit.filter((s) => {
        const m = s.match(t.re);
        const around = m ? s.slice(Math.max(0, (m.index ?? 0) - 24), (m.index ?? 0) + 60) : s;
        return !/(こちら(の)?(お部屋|物件|費用)|この(お部屋|物件)|[0-9０-９]{3,}号室)/.test(around);
      });
      cands.push({ q: t.q, n: generic.length, examples: [...new Set(generic.map((s) => s.replace(/\s+/g, " ").trim()))].slice(0, 3) });
    }
  }
  console.log(`\n【候補（特定の物件を指す文を外した後）】`);
  for (const c of cands.sort((a, b) => b.n - a.n)) {
    console.log(`\n── ${c.q}（${c.n}通）`);
    for (const e of c.examples) {
      const s = e.length > 150 ? `${e.slice(0, 150)}…` : e;
      console.log(`   ・${s}`);
    }
  }
  console.log(`\n※ 保証会社の名前・種類／家賃・初期費用の額／入居可能日／募集状況は**物件によって変わる**ので固定しない`);
}
main().catch((e) => { console.error(e); process.exit(1); });
