// 「ラベル＋空白＋値」を伏せる新しい線（pii-mask APP_LABEL_SPACE_REGEX）が、普通の文に当たっていないかの監査（読み取りのみ）
// 2026-09-23 竹内「問題は個人情報を deepseek 側が読み取ること」
// 実行: npx tsx --env-file=.env.local scripts/audit-mask-space-label.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { APP_LABEL_SPACE_REGEX } from "../app/lib/pii-mask";
import { isApplicationPayload } from "../app/lib/pii-pseudonym";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
/** 旧の線（コロンありだけ）を真似た伏せ字。差分を見るために使う */
const OLD_LABEL_RE = /(氏名|お名前|名前|フリガナ|ふりがな|年収|収入|月収|給与|現住所|住所|連帯保証人|保証人|緊急連絡先|勤務先|勤め先|会社名|職場|生年月日|誕生日|年齢|電話番号|メールアドレス)([:：]\s*)([^\n、。｜|】\]]+)/g;
const hide = (s: string) => s.replace(/[0-9０-９]/g, "#").replace(/[一-龯ァ-ヶ][一-龯ァ-ヶー]+/g, (m) => m[0] + "…");

async function main() {
  const days = Number(arg("days", "90"));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<{ sender: string; text: string | null }> = [];
  for (let p = 0; p < 40; p++) {
    const { data } = await sb.from("messages").select("sender, text").gte("created_at", since).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  let hit = 0, inForm = 0, outForm = 0;
  const examples: string[] = [];
  for (const m of rows) {
    const t = m.text ?? ""; if (!t) continue;
    const ms = [...t.matchAll(new RegExp(APP_LABEL_SPACE_REGEX.source, "g"))];
    if (ms.length === 0) continue;
    hit++;
    if (isApplicationPayload(t)) inForm++;
    else {
      outForm++;
      if (examples.length < 15) examples.push(`${m.sender === "staff" ? "ス" : "客"}: ${hide(ms[0][0].slice(0, 60))}`);
    }
  }
  console.log(`直近${days}日 ${rows.length}通 ／ 新しい線（ラベル＋空白＋値）に当たる通 ${hit}（申込フォーム ${inForm} ／ それ以外 ${outForm}）`);
  console.log(`\n【申込フォーム以外で当たる箇所（目で読む・伏字）】`);
  for (const e of examples) console.log("  ", e);
}
main().catch((e) => { console.error(e); process.exit(1); });
