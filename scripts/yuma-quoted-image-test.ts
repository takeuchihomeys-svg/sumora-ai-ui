// 引用先の画像を読み取って文を作れているか（YUMA・本番と同じ bg-async 経由）
//
// 2026-09-21 竹内「引用とあれば引用先の画像を読み取れるように。こっちが送った画像なら deepseek で
//   読み取れるようになってるはずなので、そこで読み取ってちゃんとした文を生成できるようにする」
//
// 確かめる場面（同じ資料を引用して、聞く事だけを変える）:
//   ① 資料に**書いてある**事を聞く（駐車場・ペット・保証人）→ 確認を挟まずその場で答えられるか
//   ② 資料に**書いていない**事を聞く（駐車場は1階か）→ 作り話をせず「確認させて頂きます」で受けるか
//   ③ 見積書の画像を引用して費用を聞く → 金額を本文に書かないか
//
// ⚠ テストの見方（2026-09-21 の反省）: 「出てはいけない形が無い」だけ見ると、
//   **生成が失敗していても ✅ が並ぶ**。①下書きが出たか ②場面に合っているか を別々に出す。
//
// ⚠ 書き込みを伴う（YUMA に場面を入れて、確認後に必ず消す）。テスト会話 YUMA だけで動かす。
// 実行: npx tsx --env-file=.env.local scripts/yuma-quoted-image-test.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAIL_RE = /生成に失敗|AI返信の生成/;
let cleanup: string[] = [];

type Scene = {
  name: string;
  kind: "property" | "estimate";
  customer: string;
  /** 下書きに入っていてほしい事（どれか1つ） */
  want: RegExp;
  wantLabel: string;
  /** 出てはいけない形 */
  forbid: RegExp;
  forbidLabel: string;
};

const SCENES: Scene[] = [
  {
    name: "① 資料に書いてある事を聞く（駐車場）",
    kind: "property",
    customer: "こちらの物件って駐車場ありますか？",
    want: /駐車場/,
    wantLabel: "駐車場について答えている",
    forbid: /(?:駐車場[^。！\n]{0,10})?(?:確認(?:させて|いたし|し)て?(?:頂|いただ)|お調べ)/,
    forbidLabel: "資料に書いてあるのに確認で受けている",
  },
  {
    name: "② 資料に書いていない事を聞く（駐車場は1階か）",
    kind: "property",
    customer: "ここの駐車場って1階ですか？",
    want: /確認|お調べ|折り返し/,
    wantLabel: "確認させて頂きますで受けている",
    forbid: /(?:1階|一階|地下|平面|機械式)(?:です|となります|になります)/,
    forbidLabel: "資料に無い事を断定した（作り話）",
  },
  {
    name: "③ 見積書の画像を引用して費用を聞く",
    kind: "estimate",
    customer: "こちらもう少し初期費用抑えられませんか？",
    want: /.{6,}/,
    wantLabel: "文が出ている",
    forbid: /[0-9０-９]{2,3}[,，][0-9０-９]{3}|[0-9０-９]+万[0-9０-９]*円/,
    forbidLabel: "金額を本文に書いた",
  },
];

/** 読み取り済みの画像を1枚借りる（本番の実データ。書き換えない） */
async function pickImage(kind: "property" | "estimate"): Promise<{ url: string; lines: string[] } | null> {
  const { data, error } = await sb.from("image_details")
    .select("image_url, kind, lines").eq("kind", kind).order("read_at", { ascending: false }).limit(30);
  if (error) { console.log(`⚠ image_details: ${error.message}`); return null; }
  const rows = (data ?? []) as Array<{ image_url: string; lines: unknown }>;
  for (const r of rows) {
    const lines = Array.isArray(r.lines) ? (r.lines as unknown[]).map(String) : [];
    if (kind === "estimate" || lines.some((l) => /駐車場/.test(l))) return { url: r.image_url, lines };
  }
  const first = rows[0];
  return first ? { url: first.image_url, lines: Array.isArray(first.lines) ? (first.lines as unknown[]).map(String) : [] } : null;
}

async function runScene(s: Scene) {
  console.log(`\n${"═".repeat(78)}`);
  console.log(`【${s.name}】`);
  const img = await pickImage(s.kind);
  if (!img) { console.log("   画像が無い（先に backfill-image-details を動かす）"); return { drafted: false, ok: false }; }
  console.log(`   引用先の資料（読み取り ${img.lines.length}行）: ${img.lines.slice(0, 6).join(" ／ ") || "（見積書なので中身は読まない）"}`);

  const now = Date.now();
  const lmid = `yuma-test-${now}`;
  const ins = await sb.from("messages").insert([
    { conversation_id: YUMA, sender: "staff", text: "[画像]", image_url: img.url, line_message_id: lmid, created_at: new Date(now - 120_000).toISOString() },
    { conversation_id: YUMA, sender: "customer", text: s.customer, quoted_message_id: lmid, created_at: new Date(now - 30_000).toISOString() },
  ]).select("id");
  if (ins.error) { console.log(`   場面を作れず: ${ins.error.message}`); return { drafted: false, ok: false }; }
  const made = ((ins.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  cleanup.push(...made);
  await sb.from("conversations").update({
    last_sender: "customer", ai_draft: null, ai_draft_check: null,
    draft_attempted_at: null, draft_pending_at: null, draft_fail_count: 0, draft_last_error: null,
  }).eq("id", YUMA);

  // ⚠ bg-async（自動の下書き）はブレインが AIX を指示すると「[AIX誘導中]」で本文を作らない。
  //   引用＋物件の質問はまさに AIX の場面なので、ここは**画面の再生成と同じ形**で
  //   /api/generate-reply を直接叩いて本文を見る（AIX の文にも同じ材料が入る）。
  const { data: convRow } = await sb.from("conversations").select("status, customer_name").eq("id", YUMA).maybeSingle();
  const conv = (convRow ?? {}) as { status?: string; customer_name?: string };
  let draft = "";
  try {
    const res = await fetch(`${BASE}/api/generate-reply`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: s.customer,
        customerMessages: [s.customer],
        state: conv.status ?? "property_proposal",
        conversationId: YUMA,
        customerName: conv.customer_name ?? "YUMA",
        recentMessages: [
          { sender: "staff", text: "[画像]", imageUrl: img.url, createdAt: new Date(now - 120_000).toISOString(), isAix: false },
          { sender: "customer", text: s.customer, createdAt: new Date(now - 30_000).toISOString(), isAix: false },
        ],
        hasViewed: false, activeTaskTypes: [],
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const raw = await res.text();
    const nl = raw.indexOf("\n");
    const meta = nl >= 0 ? (JSON.parse(raw.slice(0, nl)) as { ok?: boolean; reason?: string }) : { ok: false, reason: "no-meta" };
    draft = meta.ok ? raw.slice(nl + 1) : `（生成されず: ${meta.reason ?? "?"}）`;
  } catch (e) { draft = `（エラー: ${e instanceof Error ? e.message : String(e)}）`; }

  await sb.from("messages").delete().in("id", made);
  cleanup = cleanup.filter((x) => !made.includes(x));
  await sb.from("conversations").update({ ai_draft: null, ai_draft_check: null, draft_attempted_at: null, draft_pending_at: null }).eq("id", YUMA);
  await sleep(6000);

  const body = draft.replace(/\n?<<<[A-Z_]+:[\s\S]*?(?:>>>|$)/g, "").replace(/\n?<<<[A-Z_]+>>>/g, "").trim();
  // ① 下書きが本当に出たか（失敗文・AIX誘導中・空を成功と読まない）
  const drafted = body.length > 5 && !FAIL_RE.test(body) && !/^（/.test(body);
  console.log(`   お客様: ${s.customer}`);
  console.log(`   下書き: ${body.replace(/\n/g, " ／ ").slice(0, 220)}`);
  if (!drafted) { console.log(`   ⚠ 下書きが出ていない（この後の判定は意味を持たない）`); return { drafted, ok: false }; }
  // ② 場面に合っているか
  const wantHit = s.want.test(body);
  const forbidHit = s.forbid.test(body);
  console.log(`   ${wantHit ? "✅" : "⚠"} ${s.wantLabel} ／ ${forbidHit ? "⚠ 出てしまった" : "✅ 出ていない"}（${s.forbidLabel}）`);
  return { drafted, ok: wantHit && !forbidHit };
}

async function main() {
  console.log(`=== 引用先の画像を読んで文を作れているか（YUMA・本番と同じ bg-async 経由）===`);
  const results: Array<{ name: string; drafted: boolean; ok: boolean }> = [];
  for (const s of SCENES) results.push({ name: s.name, ...(await runScene(s)) });
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.log(`\n${"═".repeat(78)}\n=== まとめ ===`);
  for (const r of results) console.log(`   ${r.drafted ? "✅" : "⚠"} 下書きが出た ／ ${r.ok ? "✅" : "⚠"} 場面に合っている   ${r.name}`);
  console.log(`   後片付けの残り ${cleanup.length}件`);
}
main().catch(async (e) => {
  if (cleanup.length) await sb.from("messages").delete().in("id", cleanup);
  console.error(e); process.exit(1);
});
