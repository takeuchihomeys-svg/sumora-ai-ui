// 「最大限割引しました御見積書」の長い形／短い形の分かれ目を、実送信で探す（読み取りのみ）
//
// 2026-09-20・2026-09-23 に2回「場面分けができていない」と出しながら直せていない宿題。
// 2026-09-23 の型ごとの割り直しで、AIX【物件確認した】の最大の型で残る穴がここだと分かった:
//   property_check_result_available（67件）
//     見積書の同封（割引つきの長い形） 実送信 58.2% ／ 生成 77.6%（+19.4pt 書きすぎ）
//     見積書の同封（短い形）           実送信 29.9% ／ 生成 10.4%（-19.4pt 書けていない）
//   生成はコードの固定テンプレ（route.ts の estimate1 / estimateSection）で**必ず「最大限割引」**を書く。
//
// 【探す線】誤削除0になる分かれ目があるか。無ければ入れない（監査で止める）。
// 実行: npx tsx --env-file=.env.local scripts/audit-max-discount-scene.ts [DAYS=365] [SHOW=6]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** 御見積書を同封したと伝えている通か */
const ENCLOSED_RE = /(御見積書|お見積書|見積書)[^。\n]{0,12}(同封|お送り|ご査収)/;
/** 長い形（最大限割引つき） */
const MAXDISC_RE = /最大限割引/;

type Ex = { id: string; conversation_id: string | null; sent_reply: string | null; created_at: string; sent_at: string | null; aix_action: string | null };
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };

async function main() {
  const days = Number(process.env.DAYS ?? 365);
  const SHOW = Number(process.env.SHOW ?? 6);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const rows: Ex[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, sent_reply, created_at, sent_at, aix_action")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Ex[]; rows.push(...r); if (r.length < 1000) break;
  }
  const scene = rows.filter((r) => ENCLOSED_RE.test(r.sent_reply ?? "") && r.conversation_id);
  const long = scene.filter((r) => MAXDISC_RE.test(r.sent_reply ?? ""));
  console.log(`御見積書を同封したと伝えた実送信 ${scene.length}通（${days}日）`);
  console.log(`   長い形（最大限割引つき） ${long.length}（${pct(long.length, scene.length)}） ／ 短い形 ${scene.length - long.length}（${pct(scene.length - long.length, scene.length)}）`);
  console.log(`   ⚠ コードの固定テンプレは 100% 長い形（route.ts estimate1 / estimateSection / estimateApp）\n`);

  const convIds = [...new Set(scene.map((r) => r.conversation_id as string))];
  const msgsByConv = new Map<string, Msg[]>();
  for (let i = 0; i < convIds.length; i += 30) {
    const { data } = await sb.from("messages")
      .select("conversation_id, sender, text, created_at")
      .in("conversation_id", convIds.slice(i, i + 30)).eq("sender", "staff")
      .gte("created_at", new Date(Date.now() - (days + 60) * 86400_000).toISOString())
      .order("created_at");
    for (const m of (data ?? []) as Msg[]) {
      const a = msgsByConv.get(m.conversation_id) ?? []; a.push(m); msgsByConv.set(m.conversation_id, a);
    }
  }
  const atOf = (r: Ex) => new Date(r.sent_at ?? r.created_at).getTime();
  /** この会話で前に「最大限割引」を使っていたか（＝2回目以降は短くするのでは、という仮説） */
  const saidBefore = (r: Ex, windowDays: number) => {
    const at = atOf(r);
    return (msgsByConv.get(r.conversation_id as string) ?? []).some((m) => {
      const t = new Date(m.created_at).getTime();
      return t < at - 60_000 && t > at - windowDays * 86400_000 && MAXDISC_RE.test(m.text ?? "");
    });
  };

  console.log(`① 仮説「この会話で前に最大限割引と言っていたら2回目は短くする」`);
  for (const w of [3, 7, 30, 365]) {
    const yes = scene.filter((r) => saidBefore(r, w)), no = scene.filter((r) => !saidBefore(r, w));
    const y = yes.filter((r) => MAXDISC_RE.test(r.sent_reply ?? "")).length;
    const n = no.filter((r) => MAXDISC_RE.test(r.sent_reply ?? "")).length;
    console.log(`   ${String(w).padStart(3)}日: 前に言った ${y}/${yes.length}（${pct(y, yes.length)}） ／ 言っていない ${n}/${no.length}（${pct(n, no.length)}）`);
  }

  console.log(`\n② 他の軸（片側が0なら線になる）`);
  const axes: Array<[string, (r: Ex) => boolean]> = [
    ["物件確認の報告と一緒（募集中・募集に出ていない）", (r) => /現在募集中|募集に出ていない/.test(r.sent_reply ?? "")],
    ["物件を複数並べている（箇条書き2つ以上）", (r) => ((r.sent_reply ?? "").match(/^[・🌟]/gm) ?? []).length >= 2],
    ["見積書だけを送る通（物件の報告なし）", (r) => !/現在募集中|募集に出ていない|号室/.test(r.sent_reply ?? "")],
    ["AIX【見積書送る】", (r) => (r.aix_action ?? "").startsWith("estimate_sheet")],
    ["AIX【物件確認した】", (r) => (r.aix_action ?? "").startsWith("property_check_result")],
    ["AIXなし（手打ち・通常返信）", (r) => !r.aix_action],
    ["金額を書いている（〇〇円割引・節約）", (r) => /[0-9０-９,，]{3,}円[^。\n]{0,6}(割引|節約|お得)/.test(r.sent_reply ?? "")],
    ["申込あり（2番手）の通", (r) => /(1|１)番手|2番手以降|お申込が(は|入)って/.test(r.sent_reply ?? "")],
    ["物件が1件だけ（箇条書きなし・号室あり）", (r) => ((r.sent_reply ?? "").match(/^[・🌟]/gm) ?? []).length === 0 && /号室|現在募集中/.test(r.sent_reply ?? "")],
  ];
  for (const [label, f] of axes) {
    const yes = scene.filter(f), no = scene.filter((r) => !f(r));
    const y = yes.filter((r) => MAXDISC_RE.test(r.sent_reply ?? "")).length;
    const n = no.filter((r) => MAXDISC_RE.test(r.sent_reply ?? "")).length;
    const flag = yes.length >= 8 && (y === 0 || y === yes.length) ? "  ← 片側が揃っている（線になりうる）" : "";
    console.log(`   ${label.padEnd(36)} 当てはまる ${y}/${yes.length}（${pct(y, yes.length)}） ／ 当てはまらない ${n}/${no.length}（${pct(n, no.length)}）${flag}`);
  }

  if (SHOW > 0) {
    console.log(`\n③ 短い形の実物（テンプレが長い形で書いてしまっている側）`);
    for (const r of scene.filter((x) => !MAXDISC_RE.test(x.sent_reply ?? "")).slice(-SHOW)) {
      console.log(`   [${r.aix_action ?? "AIXなし"}] ${one(r.sent_reply ?? "").slice(0, 120)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
