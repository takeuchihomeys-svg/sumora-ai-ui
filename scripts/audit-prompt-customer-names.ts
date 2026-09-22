// プロンプト本文（コード内の文字列）に、実在のお客様の表示名が入っていないかを調べる（読み取りのみ）
// 2026-09-23 竹内「問題は個人情報を deepseek 側が読み取ること」
//   事例の呼び名（「〇〇事例」）はコメントなら問題ないが、**プロンプトに載る文字列**なら LLM に渡る。
// 実行: npx tsx --env-file=.env.local scripts/audit-prompt-customer-names.ts [--files=app/lib/brain-core.ts,...]
import * as fs from "fs";
import { loadKnownCustomerNames } from "../app/lib/pii-known-names";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const FILES = arg("files", "app/lib/brain-core.ts,app/lib/line-reply-prompts.ts,app/api/generate-reply/route.ts,app/api/aix/action/route.ts,app/api/aix-template-generate/route.ts").split(",");
const hide = (s: string) => s.replace(/[0-9０-９]/g, "#");

async function main() {
  const names = (await loadKnownCustomerNames()).map((s) => (s ?? "").trim()).filter((s) => s.length >= 2 && /[ぁ-んァ-ヶ一-龯]/.test(s));
  console.log(`お客様の表示名 ${names.length}件 × ファイル ${FILES.length}件\n`);
  let total = 0;
  for (const f of FILES) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    const hits: string[] = [];
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;   // コメントは LLM に渡らない
      for (const n of names) {
        // 「〇〇さん」「〇〇事例」の形だけ（普通の語との一致を避ける）
        const re = new RegExp(`${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:さん|様|事例)`);
        if (!re.test(line)) continue;
        // 「〇〇事例」「〇〇さん」の形（プロンプト文に混ざった呼び名）だけを拾う
        hits.push(`L${i + 1}: …${hide(line.slice(Math.max(0, line.indexOf(n) - 40), line.indexOf(n) + 40)).trim()}…`);
        break;
      }
    });
    total += hits.length;
    console.log(`${f}: ${hits.length}行`);
    for (const h of hits.slice(0, 12)) console.log("   ", h);
  }
  console.log(`\n合計 ${total}行（コメント以外＝プロンプトに載りうる行）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
