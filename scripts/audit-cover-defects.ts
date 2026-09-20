// scripts/audit-cover-defects.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-cover-defects.ts
//
// 2026-09-20 竹内「テストして他のパターンでバグや変な言い回しになっていないか確認おねがい 色んなパターンで」
//   本番14パターンで AIX【見積書送る】を通したら、**2通目（カバーレター）**に欠陥が出た。
//   落としてよいか（＝スタッフの実送信に無い形か）を1つずつ実データで測る。
//   設計知見「出口は誤削除0でなければ入れない」。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 本番で実際に出た文（これに当たること＋実送信0件が条件） */
const LEAKED = [
  "【お客様に送る文】\nYUMAさんお世話になっております！！",
  "【お客様名】さんお世話になっております！！",
  "【お客様の現在の状況（状態）】お申込み情報を受け取りました",
  "こちらのメッセージには返信できません。",
  "〈",
  "鈴木さんお世話になっております😊\nお申込み情報受け取りました！",
  "お世話になっております。ギガ賃貸です。",
  "スモラでございます😊",
];

const CHECKS: Array<{ label: string; re: RegExp }> = [
  { label: "A 【…お客様…】の見出し行", re: /^\s*【[^】]*お客様[^】]*】/m },
  { label: "A' 【…】だけの行で中に「送る文・状況・名」", re: /^\s*【[^】]{0,20}(?:送る文|現在の状況|お客様名|状態)[^】]{0,10}】/m },
  { label: "B 会社名の名乗り（スモラです／ギガ賃貸です／イエヤスです）", re: /(?:スモラ|ギガ賃貸|イエヤス)(?:です|でございます|と申します)/ },
  { label: "C 返信できません", re: /返信(?:は)?(?:でき|出来)(?:ませ|ない)/ },
  { label: "D 実質1〜3文字（記号だけ）", re: /^[\s\S]{0,3}$/ },
  { label: "E 先頭がスタッフ名の呼びかけ（鈴木さん・秋山さん）", re: /^\s*(?:鈴木|秋山|竹内)さん/ },
];

/** 参考: スタッフ名が本文に出る正当な形（消してはいけない） */
const LEGIT_STAFF_NAME = /鈴木と申します|担当(?:の|は)?鈴木|鈴木が(?:担当|ご案内|対応)/;

async function main() {
  const rows: string[] = [];
  for (let page = 0; ; page++) {
    const { data } = await sb.from("messages").select("text").eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString())
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null }>;
    if (r.length === 0) break;
    for (const x of r) if (x.text) rows.push(x.text);
    if (r.length < 1000) break;
    if (page > 14) break;
  }
  console.log(`=== スタッフの実送信365日 ${rows.length}通 で線を引く ===\n`);
  console.log(`  ${"形".padEnd(46)} ${"実送信".padStart(6)}  本番の文に当たる`);
  for (const c of CHECKS) {
    const hits = rows.filter((t) => c.re.test(t));
    const catches = LEAKED.filter((l) => c.re.test(l));
    console.log(`  ${c.label.padEnd(46)} ${String(hits.length).padStart(6)}通  ${catches.length}件`);
    for (const h of hits.slice(0, 4)) console.log(`      実送信: ${h.replace(/\n/g, " ").slice(0, 90)}`);
    for (const l of catches) console.log(`      捕まえる: ${JSON.stringify(l.replace(/\n/g, " ").slice(0, 50))}`);
  }

  // 短文の分布（どこで切れば実送信を巻き込まないか）
  console.log(`\n--- 実送信の短さの分布（カバーレターを「短すぎ」で落とす線を決める）---`);
  for (const n of [1, 2, 3, 5, 8, 10, 15]) {
    const cnt = rows.filter((t) => t.trim().length <= n).length;
    console.log(`  ${String(n).padStart(2)}文字以下: ${String(cnt).padStart(4)}通`);
  }
  const shortest = rows.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 8).slice(0, 12);
  console.log(`  実例: ${shortest.map((s) => JSON.stringify(s)).join(" / ")}`);

  // スタッフ名が正当に出る形は何件か（E の線が危なくないか）
  const legit = rows.filter((t) => LEGIT_STAFF_NAME.test(t));
  const leadStaff = rows.filter((t) => /^\s*(?:鈴木|秋山|竹内)さん/.test(t));
  console.log(`\n--- スタッフ名 ---`);
  console.log(`  正当な形（鈴木と申します・担当の鈴木・鈴木が担当）: ${legit.length}通  ← 消してはいけない`);
  console.log(`  **先頭が「鈴木さん」等の呼びかけ**: ${leadStaff.length}通`);
  for (const t of leadStaff.slice(0, 5)) console.log(`      ${t.replace(/\n/g, " ").slice(0, 90)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
