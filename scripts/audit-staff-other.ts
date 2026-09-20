// 「直前スタッフ発言」が other に落ちるのはどんな文か（読み取りのみ）
//
// 2026-09-20 竹内「ブレインで足りていない部分はあるかな？実際スタッフが送る返信を生成する為にも」
//
// find-brain-gaps の G1（分類の穴・325件 34.5%）で最多は「直前=other × 顧客=other」77件。
// 調べた順に潰した仮説:
//   ①申込の意思表示が分類されていない → ブレインも 45% 止まりで確実には言えない
//   ②申込後の「会話の外の事実」が記録されていない → 申込以降の送信の 5.7% だけ・AI 採用率はむしろ高い
//   ③AIX の種類が StaffTurnKind にマップされていない → 1000件中22件（2.2%）・実害10件
// 残るのは **AIX を押していない手打ちの返信**（設計知見: スタッフ送信の47%）。
// ここでは other に落ちる手打ち返信を集め、言い回しの頻度で「型」を出す
// （scripts/audit-ai-only-phrases.ts と同じやり方）。
import { createClient } from "@supabase/supabase-js";
import { classifyLastStaffTurn } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

function normalize(s: string): string {
  return s
    .replace(/[0-9０-９,，:：]+/g, "#")
    .replace(/【[^】]*】/g, "【】")
    .replace(/[A-Za-zＡ-Ｚａ-ｚ]+/g, "@")
    .replace(/[ぁ-んァ-ヶー一-龥]{1,6}さん/g, "〇さん")
    .replace(/[^\S\n]+/g, "")
    .trim();
}
/** 本文の「最初の実のある行」で型を見る（挨拶行は飛ばす） */
function keyLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 6);
  const body = lines.find((l) => !/お世話になっております|はじめまして|お+待たせ/.test(l)) ?? lines[0] ?? "";
  return body;
}

async function main() {
  const days = Number(process.env.DAYS ?? 60);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const msgs: Array<{ text: string | null; created_at: string; is_aix_generated?: boolean | null }> = [];
  for (let p = 0; p < 20; p++) {
    const { data } = await sb.from("messages").select("text, created_at, is_aix_generated")
      .eq("sender", "staff").gte("created_at", since)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof msgs;
    if (r.length === 0) break;
    msgs.push(...r);
    if (r.length < 1000) break;
  }
  const manual = msgs.filter((m) => m.text && m.is_aix_generated !== true && !/^\[(画像|動画|スタンプ|通話)/.test(m.text));
  console.log(`=== 直近${days}日のスタッフ送信 ${msgs.length}通（手打ち ${manual.length}通）===\n`);

  let other = 0;
  const forms = new Map<string, { n: number; sample: string }>();
  for (const m of manual) {
    const k = classifyLastStaffTurn(m.text ?? "", { recentAixRows: [], lastStaffAt: m.created_at });
    if (k.kind !== "other") continue;
    other++;
    const line = keyLine(m.text ?? "");
    if (line.length < 6) continue;
    const key = normalize(line);
    const cur = forms.get(key) ?? { n: 0, sample: line };
    cur.n++;
    forms.set(key, cur);
  }
  console.log(`=== 手打ちのうち「直前スタッフ発言」が other に落ちる: **${other}通（${((other / manual.length) * 100).toFixed(1)}%）** ===`);
  console.log(`  → この直後にお客様が返信すると、往復文脈のセルが選ばれず材料ゼロで生成する\n`);

  const top = [...forms.entries()].filter(([, v]) => v.n >= 3).sort((a, b) => b[1].n - a[1].n);
  console.log(`--- other に落ちる手打ちの型（3回以上・上位40）---`);
  for (const [, v] of top.slice(0, 40)) {
    console.log(`${String(v.n).padStart(3)}回  ${v.sample.slice(0, 96)}`);
  }
  console.log(`\n（型 ${top.length}種類で ${top.reduce((s, [, v]) => s + v.n, 0)}通をカバー）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
