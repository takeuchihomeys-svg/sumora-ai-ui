// 今日入れた修正の後に作られた下書きの質が、前と比べて上がったかを測る（読み取りのみ）
// 2026-09-23 竹内「今日の修正した結果 ここの部分の質は上がっているはず 上がっているかも調査おねがい」
//
// ⚠ 効果が出るのは**修正がデプロイされた後に作られた下書き**だけ。
//   まず件数を数えて、比べられるだけ溜まっているかを先に見る（溜まっていないのに率を出すと嘘になる）。
//
// 質の見方は audit-diff-by-brain.ts と同じ（そのまま送信率＋直しの大きさの分布）。
// 実行: npx tsx --env-file=.env.local scripts/audit-today-effect.ts [SINCE=2026-09-23T00:00:00+09:00]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = { created_at: string; ai_draft: string | null; sent_reply: string | null; was_ai_used: boolean | null; ai_similarity: number | null; aix_action: string | null };
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました）|\[返信不要\])\s*$/;
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const band = (sim: number | null) =>
  sim === null ? "不明" : sim >= 0.95 ? "ほぼ同じ" : sim >= 0.80 ? "少し直した" : sim >= 0.60 ? "半分書き直し" : sim >= 0.35 ? "大きく書き直し" : "別の文";
const BANDS = ["ほぼ同じ", "少し直した", "半分書き直し", "大きく書き直し", "別の文"];

async function main() {
  const cutIso = process.env.SINCE ?? "2026-09-23T00:00:00+09:00";
  const cut = Date.parse(cutIso);
  const since = new Date(cut - 30 * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("created_at, ai_draft, sent_reply, was_ai_used, ai_similarity, aix_action")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const usable = rows.filter((r) => {
    const d = (r.ai_draft ?? "").trim(), s = (r.sent_reply ?? "").trim();
    return d && s && !MARK.test(d) && !MARK.test(s);
  });
  const before = usable.filter((r) => Date.parse(r.created_at) < cut);
  const after = usable.filter((r) => Date.parse(r.created_at) >= cut);
  console.log(`区切り: ${cutIso}`);
  console.log(`比べられる例（下書きと実送信が両方ある）: 前 ${before.length}件 ／ **後 ${after.length}件**\n`);

  if (after.length < 30) {
    console.log(`⚠ 修正後の例が ${after.length}件しかない。率を出しても偶然と区別できないので、ここで止める。`);
    console.log(`   （目安: 30件で±9pt・100件で±5pt くらいのぶれがある）`);
    if (after.length > 0) {
      console.log(`\n   参考までに中身だけ（判断には使わない）:`);
      for (const r of after.slice(0, 10)) {
        console.log(`   ${new Date(Date.parse(r.created_at) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ")} `
          + `${String(r.aix_action ?? "通常返信").padEnd(24)} そのまま=${r.was_ai_used ? "はい" : "いいえ"} 似ている度=${r.ai_similarity ?? "—"}`);
      }
    }
    const perDay = before.length / 30;
    console.log(`\n   直近30日は1日あたり ${perDay.toFixed(1)}件。30件たまるのに約 ${Math.ceil(30 / Math.max(perDay, 0.1))}日、100件なら約 ${Math.ceil(100 / Math.max(perDay, 0.1))}日。`);
    return;
  }

  const show = (name: string, xs: Row[]) => {
    const withSim = xs.filter((x) => typeof x.ai_similarity === "number");
    const cells = BANDS.map((b) => `${b} ${pct(withSim.filter((x) => band(x.ai_similarity) === b).length, withSim.length).padStart(6)}`);
    console.log(`   ${name.padEnd(8)} ${String(xs.length).padStart(4)}件 ／ そのまま送信 ${pct(xs.filter((x) => x.was_ai_used === true).length, xs.length).padStart(6)} ／ ${cells.join(" ／ ")}`);
  };
  console.log(`① 全体`);
  show("修正前", before); show("修正後", after);
  console.log(`\n② 通常返信（AIXなし・今日いちばん質が低かった層）`);
  const plain = (xs: Row[]) => xs.filter((x) => !x.aix_action);
  show("修正前", plain(before)); show("修正後", plain(after));
  console.log(`\n③ AIX あり`);
  const withAix = (xs: Row[]) => xs.filter((x) => !!x.aix_action);
  show("修正前", withAix(before)); show("修正後", withAix(after));
}
main().catch((e) => { console.error(e); process.exit(1); });
