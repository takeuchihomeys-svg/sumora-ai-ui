// scripts/audit-scene-feeling-appeal.ts — 土台「気持ち」「訴求」を場面ごとに数える（竹内さん本人の実送信の形・読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（台帳 #496〜#499・作業員N の foundation-scene-grid で「場面ごとの決まり・物差しが無い」と出た所・統括役の頼み）。
//   1番＝お客様の束の後の、竹内さん本人のこちらの通の塊（次のお客様の通まで・AIX の文も含む）。
//   場面: こちらの塊に物件ピックアップ／物件オススメの AIX がある番は「物件を送る」、それ以外はお客様の束の reply-scene（短いお礼・検討中・質問・条件・物件を送ってきた・初期費用・内覧・申込・その他）。
//   形（決まった網・1番に複数付く）:
//     気持ち … 受けた（共感・気持ちの語で受けた: ですよね・ご不安・ご心配・お気持ち・嬉しい・良かった・残念・安心 等）／受けていない
//     訴求   … 推した（オススメ・お得・初期費用を抑え・審査通過・人気・早め 等）／内覧へ誘った（ご案内させて・ご内覧）／どちらも無い
//   本文は出さない（場面ごとの数と割合だけ）。--json= で場面ごとの数を書く（毎日の数の元）。
// 重い読み: 営業時間（JST 9〜22時）は --days=3 に絞る（30日は22時以降）。
// 実行: npx tsx --env-file=.env.local scripts/audit-scene-feeling-appeal.ts [--days=30] [--json=<出力>] [--force]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
export const FEEL_RE = /ですよね|お気持ち|ご不安|ご心配|不安な|心配な|分かります|わかります|嬉しい|うれしい|良かった|よかった|安心|残念|お辛い|大変でしたね|お忙しい中/;
export const APPEAL_RE = /オススメ|おすすめ|お勧め|お得|初期費用(?:を|も)?抑え|審査(?:通過|が通り)|人気|すぐに?埋まり|早め|お早め|🌟|一押し|特に/;
export const INVITE_RE = /ご案内させて|ご内覧|内覧(?:頂|いただ|のご案内)|お気に召され/;
export type TurnShape = { scene: string; feeling: boolean; appeal: boolean; invite: boolean };

/** 1番の形（純関数） */
export function turnShape(customerTexts: ReadonlyArray<string>, ourTexts: ReadonlyArray<string>, propertySend: boolean): TurnShape {
  const ours = ourTexts.join("\n").normalize("NFKC");
  const scene = propertySend ? "property_send" : resolveReplyScene({ customerText: customerTexts.join("\n") }).scene;
  return { scene, feeling: FEEL_RE.test(ours), appeal: APPEAL_RE.test(ours), invite: INVITE_RE.test(ours) };
}

// ── 過半数の形 → 設計知見の案（P2）／割れた形 → 推奨つきの確認案（台帳 #496・#498・統括役 11/21）──────────────
export const SCENE_JA: Record<string, string> = {
  ack: "短いお礼", considering: "検討中", question: "質問", conditions: "条件", property_share: "物件を送ってきた", property_send: "物件を送る",
  cost: "初期費用", viewing: "内覧", apply: "申込", other: "その他",
};
const SHAPE_JA: Record<"feeling" | "appeal" | "invite", { do: string; dont: string; base: "気持ち" | "訴求" }> = {
  feeling: { do: "お客様の気持ちを一言で受ける", dont: "気持ちの受けを書かない（本題から入る）", base: "気持ち" },
  appeal: { do: "物件・提案の良い点を推す", dont: "推す言葉を入れない", base: "訴求" },
  invite: { do: "内覧へ誘う", dont: "内覧へは誘わない", base: "訴求" },
};
export type SceneTally = Record<string, { n: number; feeling: number; appeal: number; invite: number }>;
export type ShapeProposal = { scene: string; shape: "feeling" | "appeal" | "invite"; n: number; rate: number; kind: "kb" | "confirm" | "few"; text: string; recommend?: string };
/** 場面×形ごとに: 60%以上→「する」の決まりの案／40%以下→「しない」の決まりの案／その間→推奨つきの確認案／番が minN 未満→少ない（純関数） */
export function proposalsOf(t: SceneTally, o: { minN?: number; scenes?: string[] } = {}): ShapeProposal[] {
  const minN = o.minN ?? 10;
  const out: ShapeProposal[] = [];
  for (const [scene, c] of Object.entries(t)) {
    if (o.scenes && !o.scenes.includes(scene)) continue;
    for (const shape of ["feeling", "appeal", "invite"] as const) {
      const rate = c.n ? c[shape] / c.n : 0;
      const sj = SCENE_JA[scene] ?? scene, s = SHAPE_JA[shape], pct = Math.round(rate * 100);
      if (c.n < minN) { out.push({ scene, shape, n: c.n, rate, kind: "few", text: `場面「${sj}」は番が ${c.n} で少ない（${minN} 未満）＝決めない` }); continue; }
      if (rate >= 0.6) out.push({ scene, shape, n: c.n, rate, kind: "kb", text: `竹内さんは場面「${sj}」の番で ${s.do}（${c.n}番中 ${pct}%）` });
      else if (rate <= 0.4) out.push({ scene, shape, n: c.n, rate, kind: "kb", text: `竹内さんは場面「${sj}」の番で ${s.dont}（${s.do}のは ${c.n}番中 ${pct}%）` });
      else out.push({ scene, shape, n: c.n, rate, kind: "confirm", text: `場面「${sj}」で ${s.do}かが割れている（${c.n}番中 ${pct}%）`, recommend: rate >= 0.5 ? `${s.do}（ただしお客様の発言にその気持ち・話題がある時だけ）` : `${s.dont}（お客様が気持ち・その話題を出した時だけ${s.do}）` });
    }
  }
  return out;
}
/** 案 → 設計知見の行（kb-insert.ts の JSON・P2・まだ入れない）と確認案の md */
export function proposalsToOutputs(ps: ReadonlyArray<ShapeProposal>, days: number): { kbRows: Array<Record<string, unknown>>; md: string } {
  const today = new Date().toISOString().slice(0, 10);
  const kbRows = ps.filter((p) => p.kind === "kb").map((p) => ({
    title: `${p.text.replace(/（.*$/, "")}（竹内さんの実送信の過半数・${today}）`,
    category: "prompt_engineering",
    insight: `${p.text}。数えは scripts/audit-scene-feeling-appeal.ts（${days}日・竹内さん本人の番・決まった網）。`,
    rationale: `竹内さん本人の実送信で場面ごとに数えた過半数の形（60%以上か40%以下）。土台「${SHAPE_JA[p.shape].base}」の場面の決まりが無かった所（台帳 #496・#498・作業員N の foundation-scene-grid）。`,
    context: `${today} 作業員K2（台帳 #496〜#499）`,
    draft: "audit-scene-feeling-appeal --kb-json", // 2026-11-23 作業員N2: 案の目印（kb-insert は --approved 無しでは入れない）
    applied_to: "scripts/audit-scene-feeling-appeal.ts",
    tags: [SHAPE_JA[p.shape].base, `場面:${SCENE_JA[p.scene] ?? p.scene}`, "竹内さんの実送信", "物差し"],
    priority: 2,
  }));
  const conf = ps.filter((p) => p.kind === "confirm");
  const md = [`# 気持ち・訴求の場面ごとの形（${days}日・竹内さん本人）— 竹内さんへの確認の案`, "", ...(conf.length ? conf.map((p) => `- ${p.text}\n  - 推奨: ${p.recommend}`) : ["- 割れた形はなし"]),
    "", "## 少なくて決めない形", ...ps.filter((p) => p.kind === "few").map((p) => `- ${p.text}・${SHAPE_JA[p.shape].do}`)].join("\n");
  return { kbRows, md };
}

type M = { conversation_id: string; sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  let days = Number(arg("days", "30")) || 30;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 3); console.log(`営業時間なので --days=${days} に絞った（全部は22時以降）`); }
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: tk, error } = await sb.from("messages").select("conversation_id").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).limit(20000);
  if (error) throw new Error(error.message);
  const convs = [...new Set(((tk ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !isTestConversation(c) && !isNoLineTestConversation(c));
  const tally: Record<string, { n: number; feeling: number; appeal: number; invite: number }> = {};
  for (const c of convs) {
    const [mq, aq] = await Promise.all([
      sb.from("messages").select("conversation_id, sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(2000),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).in("aix_type", ["property_send", "property_recommendation"]).limit(500),
    ]);
    const ms = (mq.data ?? []) as M[];
    const sendAts = ((aq.data ?? []) as Array<{ sent_at: string | null; created_at: string }>).map((a) => Date.parse(a.sent_at ?? a.created_at));
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.sender !== "staff" || m.staff_writer !== "takeuchi" || (i > 0 && ms[i - 1].sender === "staff")) continue;
      const cust: string[] = []; for (let j = i - 1; j >= 0 && ms[j].sender === "customer"; j--) cust.unshift(String(ms[j].text ?? ""));
      if (!cust.length) continue;
      let k = i; const ours: string[] = []; while (k < ms.length && ms[k].sender !== "customer") { ours.push(String(ms[k].text ?? "")); k++; }
      const from = Date.parse(m.created_at), to = k < ms.length ? Date.parse(ms[k].created_at) : Infinity;
      const s = turnShape(cust, ours, sendAts.some((t) => t >= from - 5000 && t < to));
      const c2 = (tally[s.scene] ??= { n: 0, feeling: 0, appeal: 0, invite: 0 });
      c2.n++; if (s.feeling) c2.feeling++; if (s.appeal) c2.appeal++; if (s.invite) c2.invite++;
    }
  }
  const pct = (a: number, n: number) => (n ? Math.round((100 * a) / n) : 0);
  console.log(`竹内さん本人の番の場面ごとの形（${days}日・${convs.length}会話）: 番 ／ 気持ちを受けた ／ 推した ／ 内覧へ誘った`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(15)} ${String(v.n).padStart(4)} ／ ${pct(v.feeling, v.n)}% ／ ${pct(v.appeal, v.n)}% ／ ${pct(v.invite, v.n)}%`);
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify({ days, scenes: tally }, null, 2));
  // --kb-json=<道>（kb-insert.ts に渡す JSON・まだ入れない）・--confirm-md=<道>（竹内さんへの確認の案）・--scenes=conditions,property_send（場面を絞る）・--min-n=10
  if (arg("kb-json", "") || arg("confirm-md", "")) {
    const scenes = arg("scenes", "") ? arg("scenes", "").split(",") : undefined;
    const ps = proposalsOf(tally, { minN: Number(arg("min-n", "10")) || 10, scenes });
    const { kbRows, md } = proposalsToOutputs(ps, days);
    if (arg("kb-json", "")) writeFileSync(arg("kb-json", ""), JSON.stringify(kbRows, null, 2));
    if (arg("confirm-md", "")) writeFileSync(arg("confirm-md", ""), md);
    console.log(`案: 決まり ${kbRows.length}・確認 ${ps.filter((p) => p.kind === "confirm").length}・少ない ${ps.filter((p) => p.kind === "few").length}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
