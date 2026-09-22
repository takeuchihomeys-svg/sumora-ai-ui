// ブレインの「今回の中身」を生成へ届けると下書きが変わるか（YUMA・本番と同じ経路）
//
// 2026-09-23 竹内「実際のスタッフの文の生成との間でブレインの部分にギャップがあると思うからそこも埋めたい」
//
// 【場面の作り方】想像で作らない。scripts/audit-brain-generation-gap.ts が実データから拾った
//   「ブレインの方向が型に差し替えられていた」実物をそのまま使う。
//   ⚠ 前回の失敗: 短いお礼だけの場面にしたら全部 [返信不要] になって何も測れなかった。
//     **返信が要る発言**（条件の追加・確認の依頼）で作る。
//
// 【測り方】ブレインが掴んだ中身の語が下書きに入っているか。
//   入っていれば「ブレインの判断が文に届いた」。
//   ⚠ 入る＝良い、ではない。型（開口語・構成・禁止）を壊していないかも見るので、本文を必ず目で読む。
//
// 【A/B】BRAIN_SPECIFIC=off で dev サーバーを起動し直すと切れる。同じ場面を両方で回して比べる。
//
// ⚠ 書き込みを伴う（YUMA に場面を入れて、生成後に必ず消す）。テスト会話 YUMA だけで動かす。
// 実行: npx tsx --env-file=.env.local scripts/yuma-brain-specific-test.ts [REPS=3]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: string[] = [];

type Scene = {
  id: string;
  staff: string;
  customer: string;
  /** ブレインが掴むはずの中身（実データで方向に出ていた語） */
  want: RegExp;
  wantNote: string;
  /** 型が守るべき事（壊れていないかを見る） */
  keep?: RegExp;
};

const SCENES: Scene[] = [
  {
    // 実物: ブレイン「日本橋1・2丁目エリアの物件を新規ピックアップする」
    //       型  「お客様が条件の追加/変更を伝えた（台帳: …）①「かしこまりました！！」…」
    id: "①エリアの追加（ブレイン: 日本橋1・2丁目でピックアップ）",
    staff: "YUMAさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！",
    customer: "日本橋1丁目と2丁目のエリアも追加でお願いできますか？",
    want: /日本橋/,
    wantNote: "実送信は「日本橋1・2丁目エリアからもオススメできるお部屋ピックアップしてお送りさせて頂きます！！」",
    keep: /かしこまりました/,
  },
  {
    // 実物: ブレイン「送付された3件の募集状況を確認し、塚本・大国町エリアでの再ピックアップも進める」
    id: "②エリア変更＋募集確認（ブレイン: 塚本・大国町で再ピックアップ）",
    staff: "YUMAさんお送り頂きましたお部屋の募集状況確認させて頂きます！！",
    customer: "塚本と大国町のあたりでも探してもらえますか？3件送ったお部屋の状況も知りたいです",
    want: /塚本|大国町/,
    wantNote: "実送信は「塚本・大国町エリアでもオススメ出来るお部屋ピックアップさせて頂きます！！」",
    keep: /かしこまりました/,
  },
];

async function armConversation() {
  await sb.from("conversations").update({
    last_sender: "customer", ai_draft: null, ai_draft_check: null,
    draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null,
  }).eq("id", YUMA);
}
async function waitForDraft(timeoutMs = 240_000): Promise<{ draft: string; aix: unknown }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    const { data } = await sb.from("conversations").select("ai_draft, suggested_next_aix, suggested_aix_meta").eq("id", YUMA).maybeSingle();
    const row = (data ?? {}) as Record<string, unknown>;
    const aix = row.suggested_next_aix ?? (row.suggested_aix_meta as Record<string, unknown> | null)?.action ?? null;
    const d = String(row.ai_draft ?? "");
    if (d === "[AIX誘導中]") return { draft: "", aix };
    if (d && d !== "__SHOWN__") return { draft: d, aix };
  }
  return { draft: "", aix: null };
}
async function sweepLeftovers() {
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  const texts = new Set(SCENES.flatMap((s) => [s.staff, s.customer]));
  const { data } = await sb.from("messages").select("id, text").eq("conversation_id", YUMA).gte("created_at", since);
  const ids = ((data ?? []) as Array<{ id: string; text: string | null }>).filter((r) => texts.has(String(r.text ?? ""))).map((r) => r.id);
  if (ids.length) { await sb.from("messages").delete().in("id", ids); console.log(`=== 前回の残り ${ids.length}件を片付けた ===`); }
}

async function main() {
  const reps = Number(process.env.REPS ?? 3);
  const label = (process.env.BRAIN_SPECIFIC ?? "on").toLowerCase() === "off" ? "なし（BRAIN_SPECIFIC=off）" : "あり";
  console.log(`=== ブレインの中身を渡す: ${label} ／ ${SCENES.length}場面 × ${reps}回 ===`);
  console.log(`※ 効くのは dev サーバー側の BRAIN_SPECIFIC。サーバーを起動し直してから回すこと\n`);
  await sweepLeftovers();

  let hit = 0, miss = 0, empty = 0, broke = 0;
  for (const s of SCENES) {
    for (let k = 0; k < reps; k++) {
      const now = Date.now();
      const ins = await sb.from("messages").insert([
        { conversation_id: YUMA, sender: "staff", text: s.staff, created_at: new Date(now - 10 * 60_000).toISOString() },
        { conversation_id: YUMA, sender: "customer", text: s.customer, created_at: new Date(now - 60_000).toISOString() },
      ]).select("id");
      if (ins.error) { console.log(`【${s.id}】場面を作れず: ${ins.error.message}`); continue; }
      cleanup.push(...((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id));

      let skipped = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        await armConversation();
        try {
          const res = await fetch(`${BASE}/api/generate-draft-bg-async`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversation_id: YUMA, source: "direct" }),
          });
          skipped = String(((await res.json()) as Record<string, unknown>).skipped ?? "");
        } catch (e) { skipped = `fetch失敗:${e instanceof Error ? e.message : String(e)}`; }
        if (skipped !== "in_progress") break;
        await sleep(20_000);
      }
      const { draft, aix } = await waitForDraft();
      if (cleanup.length) { await sb.from("messages").delete().in("id", cleanup); cleanup = []; }

      const head = `【${s.id}】[${k + 1}]`;
      if (!draft) { empty++; console.log(`${head} 下書きなし（AIX=${String(aix ?? "-")}・skipped=${skipped}）`); continue; }
      const got = s.want.test(draft);
      const kept = !s.keep || s.keep.test(draft);
      if (got) hit++; else miss++;
      if (!kept) broke++;
      console.log(`${head} ${got ? "✓ 中身が入った" : "✗ 中身が入らなかった"}${kept ? "" : " ／ ⚠ 型が崩れた"}`);
      console.log(`      ${draft.replace(/\n/g, " / ").slice(0, 170)}`);
    }
  }
  const total = hit + miss;
  console.log(`\n=== ブレインの中身を渡す: ${label} の結果（${total}回・下書きなし ${empty}） ===`);
  console.log(`   ✓ 中身が入った   ${hit} ／ ✗ 入らなかった ${miss} ＝ ${total ? ((hit / total) * 100).toFixed(1) : "—"}%`);
  console.log(`   ⚠ 型が崩れた     ${broke}`);
  for (const s of SCENES) console.log(`   ※ ${s.id}: ${s.wantNote}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (cleanup.length) { await sb.from("messages").delete().in("id", cleanup); console.log(`片付け: ${cleanup.length}件`); } });
