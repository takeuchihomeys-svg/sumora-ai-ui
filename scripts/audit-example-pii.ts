// scripts/audit-example-pii.ts — 手本・ナレッジ等（他のお客様の会話から作り、LLM に材料として渡す表）に
// 申込の書類・本人確認書類・収入の書類・個人の値が入っている行を数える（読み取りのみ・本文は出さない）
//
// 2026-10-08 事故: 手本 9bbf9b90（aix_template）の customer_message に記入済みの申込フォーム。判定は app/lib/example-pii-guard.ts
//   （テストの歯止め test-pii-guard.applicationMaterialReason も並べて数える＝テストで止まる物と本番で伏せる物の差を見る）
// 出す物: 表・列・理由ごとの件数／行の id 先頭8桁・entry_source・作った日／形だけの骨組み（--skeleton: 値は ○ と 9 に潰す）
// --sql=<path>: 伏せる SQL（控えの表へ写してから customer_message 等を伏せた文に置き換える）を書き出す（流さない）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-example-pii.ts [--skeleton] [--sql=<path>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { examplePiiReason, sanitizeExampleText } from "../app/lib/example-pii-guard";
import { applicationMaterialReason } from "../app/lib/test-pii-guard";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? null;
const SKELETON = process.argv.includes("--skeleton");
const SQL_OUT = arg("sql");

/** 値を潰した骨組み（項目名と記号だけ残す・名前・数字は出さない） */
const LABELS = ["氏名", "フリガナ", "生年月日", "現住所", "住所", "電話", "携帯", "勤務先", "年収", "緊急連絡先", "続柄", "保証人", "メール", "職業", "勤続", "入居", "申込", "本人確認書類", "免許証", "公安委員会", "〔直前のAIX送信〕", "〔AIX-META〕", "〔Brainテンプレヒント〕", "お客様", "スモラ", "物件", "家賃", "内覧"];
function skeleton(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const lab = LABELS.find((l) => s.startsWith(l, i));
    if (lab) { out += lab; i += lab.length; continue; }
    const c = s[i];
    if (/\d|[０-９]/.test(c)) out += "9";
    else if (/[A-Za-z]/.test(c)) out += "a";
    else if (/[぀-ヿ一-鿿々ー]/.test(c)) out += "○";
    else out += c === "\n" ? "⏎" : c;
    i++;
  }
  return out.replace(/○{3,}/g, "○○").replace(/a{3,}/g, "aa").replace(/9{3,}/g, "99").slice(0, 220);
}

async function all<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  // 大きい表（ai_reply_knowledge）は 1,000行の頁で statement timeout になることがある → 500行・3回まで取り直す（取りこぼしたら止める＝数え漏れを黙って出さない）
  const PAGE = 500;
  for (let p = 0; p < 400; p++) {
    let rows: T[] | null = null;
    for (let tryN = 0; tryN < 3 && !rows; tryN++) {
      const { data, error } = await sb.from(table).select(cols).order("id").range(p * PAGE, p * PAGE + PAGE - 1);
      if (error) console.error(`  ${table} 頁${p} ${tryN + 1}回目: ${error.message}`); else rows = (data ?? []) as T[];
    }
    if (!rows) throw new Error(`${table} を読み切れなかった（頁${p}）`);
    out.push(...rows); if (rows.length < PAGE) break;
  }
  return out;
}

type Row = Record<string, unknown> & { id: string };
const str = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const TARGETS: Array<{ table: string; cols: string[]; meta: string[]; fixCols?: string[] }> = [
  { table: "ai_reply_examples", cols: ["customer_message", "sent_reply", "ai_draft", "reply_context_snapshot"], meta: ["entry_source", "aix_action", "created_at", "conversation_id"], fixCols: ["customer_message", "sent_reply", "ai_draft"] },
  { table: "ai_reply_knowledge", cols: ["title", "content"], meta: ["source", "category", "importance", "created_at"], fixCols: ["title", "content"] },
  { table: "winning_patterns", cols: ["situation", "pattern", "notes"], meta: ["created_at"] },
  { table: "conversation_checkpoints", cols: ["summary", "key_facts"], meta: ["conversation_id", "created_at"] },
  { table: "line_watch_turns", cols: ["materials", "staff_texts", "draft_first", "draft_last"], meta: ["conversation_id", "created_at"] },
  { table: "template_selection_logs", cols: ["final_sent_text", "adapted_text", "open_context"], meta: ["aix_action_type", "created_at", "conversation_id"] },
  { table: "property_search_knowledge", cols: ["title", "content", "payload"], meta: ["source", "created_at"] },
];

async function main() {
  const sql: string[] = [];
  const fixIds: Record<string, string[]> = {};
  for (const tg of TARGETS) {
    const rows = await all<Row>(tg.table, ["id", ...tg.cols, ...tg.meta].join(","));
    const byReason = new Map<string, number>();
    const testOnly = new Map<string, number>();
    const hitRows = new Set<string>();
    const samples: string[] = [];
    for (const r of rows) {
      for (const c of tg.cols) {
        const t = str(r[c]);
        if (!t) continue;
        const hit = examplePiiReason(t);
        const testHit = applicationMaterialReason(t);
        if (hit) {
          const k = `${c}:${hit.kind}:${hit.reason}`;
          byReason.set(k, (byReason.get(k) ?? 0) + 1);
          hitRows.add(String(r.id));
          if (SKELETON && samples.length < 40) samples.push(`    ${String(r.id).slice(0, 8)} ${c} [${hit.reason}] ${tg.meta.map((m) => String(r[m] ?? "-").slice(0, 19)).join(" ")}\n      ${skeleton(t)}`);
        } else if (testHit) {
          const k = `${c}:${testHit}`;
          testOnly.set(k, (testOnly.get(k) ?? 0) + 1);
        }
      }
    }
    console.log(`\n■ ${tg.table}  全 ${rows.length}行 ／ 個人情報あり ${hitRows.size}行`);
    for (const [k, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${n.toString().padStart(5)}  ${k}`);
    if (testOnly.size) {
      console.log("   （テストの歯止めだけが当たる＝空の記入欄・項目名だけ等。本番の伏せの対象外）");
      for (const [k, n] of [...testOnly.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${n.toString().padStart(5)}  ${k}`);
    }
    if (samples.length) console.log(samples.join("\n"));

    if (SQL_OUT && tg.fixCols && hitRows.size) {
      fixIds[tg.table] = [...hitRows];
      for (const r of rows) {
        if (!hitRows.has(String(r.id))) continue;
        const sets: string[] = [];
        let strong = false;   // 書類・記入済みの申込フォーム・申込の情報（値だけでない）
        for (const c of tg.fixCols) {
          const t = str(r[c]);
          if (!t) continue;
          const s = sanitizeExampleText(t, c === "customer_message" ? "customer" : "staff");
          if (s.changed) sets.push(`${c} = ${sqlLit(s.text)}`);
          if (s.hit && s.hit.kind !== "personal_value") strong = true;
        }
        // reply_context_snapshot は文の塊（JSON）なので伏せずに外す（null）。embedding は個人情報入りの文から作ったので作り直させる（null）
        if (tg.table === "ai_reply_examples") {
          if (examplePiiReason(str(r.reply_context_snapshot))) sets.push("reply_context_snapshot = null");
          sets.push("embedding = null");
          // 書類・申込フォームの行は手本の母集団から外す（類似検索・☆直引き・フォールバックは全部 entry_source で絞っている）。元の値は控えにある
          if (strong) sets.push(`entry_source = 'pii_excluded'`);
        }
        if (tg.table === "ai_reply_knowledge") { sets.push("embedding = null"); if (strong) sets.push("importance = 0"); }
        sets.push("pii_redacted_at = now()");
        sql.push(`update ${tg.table} set ${sets.join(", ")} where id = '${r.id}';`);
      }
    }
  }
  if (SQL_OUT) {
    const head: string[] = [
      "-- 手本・ナレッジの個人情報を伏せる（scripts/audit-example-pii.ts が作った・流すのは竹内さんの確認の後）",
      "-- 中身: ①控えの表 *_pii_backup に元の行をそのまま写す（RLS 有効・公開キーから読めない） ②本文を伏せ字に置き換え・embedding を null（作り直させる）",
      "--       ③書類・申込フォームの手本は entry_source='pii_excluded'（手本に出ない）／ナレッジは importance=0 ④印 pii_redacted_at",
      "begin;",
    ];
    for (const [table, ids] of Object.entries(fixIds)) {
      head.push(`alter table ${table} add column if not exists pii_redacted_at timestamptz;`);
      head.push(`create table if not exists ${table}_pii_backup (like ${table} including defaults);`);
      head.push(`alter table ${table}_pii_backup add column if not exists backed_up_at timestamptz default now();`);
      head.push(`alter table ${table}_pii_backup enable row level security;`);
      head.push(`insert into ${table}_pii_backup select t.*, now() from ${table} t where t.id in (${ids.map((i) => `'${i}'`).join(",")}) and not exists (select 1 from ${table}_pii_backup b where b.id = t.id);`);
    }
    const tail = ["commit;", "", "-- 確かめ: select entry_source, count(*) from ai_reply_examples where pii_redacted_at is not null group by 1;", "",
      "-- 戻し方（控えから本文と印を戻す・控えの表は残す）:",
      ...Object.keys(fixIds).map((t) => `-- update ${t} t set ${t === "ai_reply_examples"
        ? "customer_message = b.customer_message, sent_reply = b.sent_reply, ai_draft = b.ai_draft, reply_context_snapshot = b.reply_context_snapshot, embedding = b.embedding, entry_source = b.entry_source"
        : "title = b.title, content = b.content, embedding = b.embedding, importance = b.importance"}, pii_redacted_at = null from ${t}_pii_backup b where b.id = t.id;`)];
    writeFileSync(SQL_OUT, [...head, ...sql, ...tail].join("\n") + "\n", "utf8");
    console.log(`\nSQL を書き出し: ${SQL_OUT}（${sql.length}行・流していない）`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
