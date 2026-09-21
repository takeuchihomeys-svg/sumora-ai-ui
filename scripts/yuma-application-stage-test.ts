// 申込の状況を正しく読めているか（YUMA・本番と同じ経路）
//
// 2026-09-21 竹内「実際に申し込んだかのところ判断できるようにする。
//   そしてそれに派生する他の状況把握で弱い部分もYUMAでテストして見つけ出す。
//   そして補っていく。実際のスタッフのように」
//
// 竹内さんのスクショの事故:
//   物件の詳細＋見積書を送った直後の「ありがとうございます🙇 検討します」に
//   「お申込みいただきありがとうございます😊」（申込は1件も無い）。
//
// ここで確かめる場面（申込の段階を変えて、文が段階に合うか）:
//   ① 申込していない（物件の詳細を送った直後の「検討します」）← 事故が起きた場面
//   ② 申込を案内しただけ（「お気に召されましたらお申込み」→「検討します」）
//   ③ 申込が完了している（「無事1番手にてお申込み完了しております」→「ありがとうございます」）
//
// ⚠ 書き込みを伴う（YUMA に場面を入れて、確認後に必ず消す）。テスト会話 YUMA だけで動かす。
// 実行: npx tsx --env-file=.env.local scripts/yuma-application-stage-test.ts
import { createClient } from "@supabase/supabase-js";
import { resolveApplicationStage } from "../app/lib/application-stage";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 申込が済んだ前提の文（竹内さんが「この場面で使わない」と言った形） */
const APPLY_THANKS_RE = /お?申込(?:み|)(?:いただき|頂き|下さり|くださり)?(?:誠に)?ありがとう/;
/** 申込の語（どんな形でも） */
const APPLY_WORD_RE = /申(?:し)?込/;
let cleanup: string[] = [];

type Scene = {
  name: string;
  staff: string[];          // こちらの送信（古い順）
  customer: string;         // お客様の返信
  expectStage: string;      // 期待する段階
  forbid: RegExp | null;    // 出てはいけない形
  forbidLabel: string;
};

const SCENES: Scene[] = [
  {
    name: "① 申込していない（物件の詳細を送った直後の「検討します」）",
    staff: [
      "YUMAさんお待たせ致しました！！\nこちらお部屋の詳細となります！！\nYUMAさんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！\nお手隙の際にご査収ください😌！！",
    ],
    customer: "ありがとうございます🙇 検討します",
    expectStage: "none",
    forbid: APPLY_THANKS_RE,
    forbidLabel: "申込へのお礼（申込していないのに）",
  },
  {
    name: "② 申込を案内しただけ → 「検討します」",
    staff: [
      "YUMAさんお気に召されましたらお申込みしお部屋押さえさせて頂きます😊！！\nお手隙の際にご査収ください😌！！",
    ],
    customer: "ありがとうございます！検討してみます！",
    expectStage: "guided",
    forbid: APPLY_THANKS_RE,
    forbidLabel: "申込へのお礼（案内しただけなのに）",
  },
  {
    name: "③ 申込が完了している → 「ありがとうございます」",
    staff: [
      "YUMAさんお申込み手続き進めさせて頂きます😊！！",
      "無事1番手にてお申込み完了しております！！\n審査の進捗あり次第ご連絡させて頂きます😌！！",
    ],
    customer: "ありがとうございます！よろしくお願いします",
    expectStage: "submitted",
    forbid: /新着|ピックアップ|オススメ出来るお部屋/,
    forbidLabel: "新しい物件の提案（申込後なのに）",
  },
];

async function runScene(s: Scene) {
  console.log(`\n${"═".repeat(78)}`);
  console.log(`【${s.name}】`);
  // 判定だけ先に確かめる（本番の経路と同じ関数）
  const v = resolveApplicationStage(s.staff);
  const stageOk = v.stage === s.expectStage;
  console.log(`   申込の段階の判定: ${v.stage}（期待 ${s.expectStage}）${stageOk ? " ✅" : " ⚠ 食い違い"}`);
  if (v.evidence) console.log(`     根拠: ${v.evidence}`);

  // 場面を作る
  const now = Date.now();
  const rows = s.staff.map((t, i) => ({
    conversation_id: YUMA, sender: "staff", text: t,
    created_at: new Date(now - (s.staff.length - i + 1) * 60_000).toISOString(),
  }));
  rows.push({ conversation_id: YUMA, sender: "customer", text: s.customer, created_at: new Date(now - 30_000).toISOString() });
  const ins = await sb.from("messages").insert(rows).select("id");
  if (ins.error) { console.log(`   場面を作れず: ${ins.error.message}`); return { stageOk, draftOk: null as boolean | null }; }
  const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  cleanup.push(...made);
  await sb.from("conversations").update({
    last_sender: "customer", ai_draft: null, ai_draft_check: null,
    draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null,
  }).eq("id", YUMA);

  let draft = "";
  try {
    const res = await fetch(`${BASE}/api/generate-draft-bg-async`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: YUMA, source: "direct" }),
    });
    const skipped = String(((await res.json()) as Record<string, unknown>).skipped ?? "");
    if (!skipped) {
      const t0 = Date.now();
      while (Date.now() - t0 < 240_000) {
        await sleep(3000);
        const { data } = await sb.from("conversations").select("ai_draft").eq("id", YUMA).maybeSingle();
        const d = String((data as Record<string, unknown> | null)?.ai_draft ?? "");
        if (d === "[AIX誘導中]" || d === "[返信不要]") { draft = `（${d}）`; break; }
        if (d && d !== "__SHOWN__") { draft = d; break; }
      }
    } else { draft = `（skipped: ${skipped}）`; }
  } catch (e) { draft = `（エラー: ${e instanceof Error ? e.message : String(e)}）`; }

  await sb.from("messages").delete().in("id", made);
  cleanup = cleanup.filter((x) => !made.includes(x));
  await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null, draft_attempted_at: null, draft_pending_at: null }).eq("id", YUMA);
  await sleep(6000);

  const body = draft.replace(/\n?<<<[A-Z_]{3,}[\s\S]*?(?:>>>|$)/g, "").trim();
  console.log(`   お客様: ${s.customer}`);
  console.log(`   下書き: ${body.replace(/\n/g, " ／ ").slice(0, 190)}`);
  const hit = s.forbid ? s.forbid.test(body) : false;
  const hasApply = APPLY_WORD_RE.test(body);
  console.log(`   ${hit ? "⚠ 出てはいけない形が出た" : "✅ 出てはいけない形は無い"}（${s.forbidLabel}）／ 「申込」の語: ${hasApply ? "あり" : "なし"}`);
  return { stageOk, draftOk: !hit };
}

async function main() {
  console.log(`=== 申込の状況を正しく読めているか（YUMA・本番と同じ bg-async 経由）===`);
  const results: Array<{ name: string; stageOk: boolean; draftOk: boolean | null }> = [];
  for (const s of SCENES) {
    const r = await runScene(s);
    results.push({ name: s.name, ...r });
  }
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.log(`\n${"═".repeat(78)}`);
  console.log(`=== まとめ ===`);
  for (const r of results) {
    console.log(`   ${r.stageOk ? "✅" : "⚠"} 段階の判定 ／ ${r.draftOk === null ? "－" : r.draftOk ? "✅" : "⚠"} 下書き   ${r.name}`);
  }
  console.log(`   後片付けの残り ${cleanup.length}件`);
}
main().catch(async (e) => {
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.error(e); process.exit(1);
});
