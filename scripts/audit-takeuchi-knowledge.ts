// scripts/audit-takeuchi-knowledge.ts — 竹内さん（書き手A）の実送信から「具体の知識」の文を場面ごとに集め、同じ中身の回数で並べる（読むだけ・LLM なし）
//
// 2026-10-28 竹内さん「今までの LINE を見たら読み取れる部分がたくさんあると思う。そこから大切な知識を入れていって。竹内が送った内容が優先度高い」。
//   文の外れ74番のうち B（具体の知識が無い）8番・11%（作業員1）。会社の事実（company-facts.ts）に無い中身を候補にする。
// 作り: 竹内さんの手打ちの通（AIX の通・物件の資料・見積書の文は除く）を文に割り、場面の語の網で分け、金額・日付・名前・物件名を伏せた形で同じ文を数える。
//   従業員の通は同じ形の数だけ横に出す（補い・食い違いを見る）。出力は JSON（場面→文の形→竹内さんの回数・従業員の回数・例の会話と日付）。
// 実行: npx tsx --env-file=.env.local scripts/audit-takeuchi-knowledge.ts --out=<file.json>
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

export const SCENES: Array<{ key: string; re: RegExp }> = [
  { key: "審査", re: /審査|保証会社|否決|通過/ },
  { key: "入金・期日", re: /入金|振込|振り込|お支払|期日|請求書/ },
  { key: "入居日・日割", re: /日割|ご入居日|入居日|月末|月初/ },
  { key: "入居までの期間", re: /ご入居まで|入居まで|[0-9一二]週間|日程度|日程/ },
  { key: "初期費用の中身", re: /初期費用|仲介手数料|敷金|礼金|前家賃|火災保険|鍵交換|クリーニング|スモ割|割引|AD|広告料/ },
  { key: "新着・探し方", re: /新着|募集に出|掲載|曜日|ピックアップ/ },
  { key: "内覧", re: /内覧|ご案内|内見|待ち合わせ|現地/ },
  { key: "鍵・入居の手続き", re: /鍵|契約書|郵送|署名|捺印|住民票|ライフライン|電気|ガス|水道/ },
  { key: "駐車場・バイク", re: /駐車|駐輪|バイク/ },
  { key: "ペット", re: /ペット|犬|猫/ },
  { key: "申込の段取り", re: /お申込|申込|フォーマット|本人確認|書類/ },
  { key: "解約・更新・退去", re: /解約|更新|退去|違約/ },
  { key: "設備・物件", re: /設備|インターネット|Wi-?Fi|エアコン|洗濯機|宅配|オートロック|ポスト/ },
  { key: "会社・店舗", re: /弊社|店舗|事務所|来店|営業時間|お電話/ },
];
/** 具体の中身のある文か（数字・期間・可否・必要/不要・言い切りの決まり） */
const CONCRETE_RE = /[0-9０-９]|一|二|三|週間|ヶ月|か月|日以内|日前|可能|不要|必要|出来ません|できません|かかりません|かかります|となります|御座います|ございます/;
const SKIP_RE = /^(?:.*さん)?(?:お世話になっております|かしこまりました|ありがとうございます|はじめまして|この度ご連絡|お部屋探しを担当|何卒よろしく|よろしくお願い|お手隙の際|ご査収|お気軽に|確認出来次第|確認させて頂きます)/;
export function normSentence(s: string): string {
  return s.normalize("NFKC")
    .replace(/[^\s、。！!]{1,10}さん/g, "〇〇さん")
    .replace(/[0-9,]+円/g, "<金額>").replace(/[0-9]{1,2}\/[0-9]{1,2}(?:日)?|[0-9]{1,2}月[0-9]{1,2}日/g, "<日付>").replace(/[0-9]{1,2}:[0-9]{2}/g, "<時刻>")
    .replace(/[A-Za-zァ-ヶー・]{3,}[^\s、。！!]{0,12}\s?[0-9]{2,5}号室/g, "<物件>")
    .replace(/[😊😌🌟✨🙇‍♀️🙏]/g, "").replace(/[！!]+/g, "！").replace(/\s+/g, "").trim();
}
export function splitSentences(t: string): string[] {
  return String(t ?? "").split(/(?<=[。！!？?])|\n+/).map((s) => s.trim()).filter((s) => s.length >= 8 && s.length <= 160);
}

(async () => {
  const rows: Array<{ id: string; conversation_id: string; created_at: string; text: string; staff_writer: string | null }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, text, staff_writer").eq("sender", "staff")
      .not("text", "is", null).or("is_aix_generated.is.null,is_aix_generated.eq.false").order("created_at").range(f, f + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  type G = { form: string; tk: number; emp: number; other: number; ex: Array<{ w: string; conv: string; at: string; s: string }> };
  const by: Record<string, Map<string, G>> = {};
  for (const r of rows) {
    const t = r.text;
    if (/^\s*[【🌟①]|初期費用さらに|オススメポイント|^\s*\[画像/.test(t)) continue; // 見積書・物件の資料の文
    for (const s of splitSentences(t)) {
      if (SKIP_RE.test(s.replace(/^.{0,12}さん\s*/, "")) || !CONCRETE_RE.test(s)) continue;
      const form = normSentence(s);
      if (form.length < 10) continue;
      for (const sc of SCENES) {
        if (!sc.re.test(s)) continue;
        const m = (by[sc.key] ??= new Map());
        const g = m.get(form) ?? { form, tk: 0, emp: 0, other: 0, ex: [] };
        if (r.staff_writer === "takeuchi") g.tk++; else if (r.staff_writer === "employee") g.emp++; else g.other++;
        if (g.ex.length < 4) g.ex.push({ w: r.staff_writer ?? "?", conv: r.conversation_id.slice(0, 8), at: r.created_at.slice(0, 10), s: s.slice(0, 160) });
        m.set(form, g);
      }
    }
  }
  const out: Record<string, G[]> = {};
  for (const [k, m] of Object.entries(by)) out[k] = [...m.values()].filter((g) => g.tk >= 1).sort((a, b) => b.tk - a.tk || b.emp - a.emp).slice(0, 80);
  writeFileSync(arg("out", "takeuchi-knowledge.json"), JSON.stringify({ rows: rows.length, scenes: out }, null, 1));
  for (const [k, gs] of Object.entries(out)) console.log(`${k}: 竹内さんの文の形 ${gs.length}（2回以上 ${gs.filter((g) => g.tk >= 2).length}）`);
})().catch((e) => { console.error(e); process.exit(1); });
