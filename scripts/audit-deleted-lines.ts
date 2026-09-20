// スタッフが下書きから「削った行」を集めて、何を書きすぎているかを見る（読み取りのみ）
//
// 2026-09-20 竹内「自分が送った文のことも踏まえたうえでズレは起きていないかな？
//   自分で送った文を理解していないことがたまにあるから」
//
// 設計知見「生成文と実送信の差分が正解データ」。
// 台帳との矛盾を regex で探す方法は偽陽性だらけだった（新しい物件の見積・内覧の変更・
// 新しく送られた物件の確認は全部正当）。そこで**スタッフの判断そのもの**を見る:
//   下書きにあって実送信に無い行 ＝ スタッフが「これは要らない／違う」と消した行。
// 頻度順に出せば、AI が繰り返し書きすぎている物が分かる。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 言い回しだけを比べる（数字・物件名・人名を潰す） */
function norm(s: string): string {
  return s
    .replace(/[0-9０-９,，:：]+/g, "#")
    .replace(/【[^】]*】/g, "【】")
    .replace(/[A-Za-zＡ-Ｚａ-ｚ]+/g, "@")
    .replace(/[ぁ-んァ-ヶー一-龥]{1,6}さん/g, "〇さん")
    .replace(/\s+/g, "")
    .trim();
}
const lines = (t: string) => t.split("\n").map((x) => x.trim()).filter((x) => x.length >= 6);

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 12; p++) {
    const { data } = await sb.from("ai_reply_examples")
      .select("ai_draft, sent_reply, was_ai_used, ai_similarity, created_at, conversation_state")
      .gte("created_at", since).not("ai_draft", "is", null).not("sent_reply", "is", null)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    rows.push(...r);
    if (r.length < 1000) break;
  }
  const usable = rows.filter((r) => {
    const d = String(r.ai_draft ?? ""), s = String(r.sent_reply ?? "");
    return d && s && d !== "__SHOWN__" && !/^\[/.test(d) && !/^\[/.test(s);
  });
  console.log(`=== 直近${days}日 下書きと実送信が揃う ${usable.length}件 ===\n`);

  const deleted = new Map<string, { n: number; sample: string }>();
  const added = new Map<string, { n: number; sample: string }>();
  let editedCount = 0;
  for (const r of usable) {
    const d = lines(String(r.ai_draft));
    const s = lines(String(r.sent_reply));
    const sNorm = new Set(s.map(norm));
    const dNorm = new Set(d.map(norm));
    const del = d.filter((x) => !sNorm.has(norm(x)));
    const add = s.filter((x) => !dNorm.has(norm(x)));
    if (del.length || add.length) editedCount++;
    for (const x of del) {
      const k = norm(x);
      const cur = deleted.get(k) ?? { n: 0, sample: x };
      cur.n++; deleted.set(k, cur);
    }
    for (const x of add) {
      const k = norm(x);
      const cur = added.get(k) ?? { n: 0, sample: x };
      cur.n++; added.set(k, cur);
    }
  }
  console.log(`スタッフが手を入れた（行の増減あり）: ${editedCount}件（${((editedCount / usable.length) * 100).toFixed(1)}%）\n`);

  console.log(`=== ★ スタッフが削った行（AI が書きすぎている物）上位30 ===`);
  for (const [, v] of [...deleted.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) {
    console.log(`${String(v.n).padStart(3)}回  ${v.sample.slice(0, 100)}`);
  }

  console.log(`\n\n=== 参考: スタッフが足した行（AI が書けていない物）上位20 ===`);
  for (const [, v] of [...added.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) {
    console.log(`${String(v.n).padStart(3)}回  ${v.sample.slice(0, 100)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
