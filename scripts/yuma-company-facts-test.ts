// 今日の改善で、AI が会社の事実を作文しなくなったかを本番と同じ経路で確かめる（YUMA）
//
// 2026-09-23 竹内「実際に生成される文と直近でスタッフが改善したところにブレなどないか確認する／
//   テストも行って／今日の改善でちゃんと改善されているのか」
//
// 【場面の作り方】想像で作らない。**AI が実際に間違えた実物**（通常返信で大幅に書き直された例）を使う。
//   各場面に「スタッフが実際に送った文」を正解として持ち、生成がその方向とブレていないかも見る。
//
// 【見るもの】
//   ① want   … 今日入れた固定の事実（company-facts.ts）が本文に現れるか
//   ② forbid … AI が前に書いた間違い（店舗訪問を受け入れる・写真が無いと断定・曖昧にぼかす）を書かないか
//   ③ ブレ   … スタッフの実送信と方向が合っているか（本文を並べて目で読む）
//
// ⚠ 書き込みを伴う（YUMA に場面を入れて、生成後に必ず消す）。テスト会話 YUMA だけで動かす。
// ⚠ 前に save / 後に restore: npx tsx --env-file=.env.local scripts/yuma-snapshot.ts save|restore
// 実行: npx tsx --env-file=.env.local scripts/yuma-company-facts-test.ts [REPS=2]
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts } from "../app/lib/company-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: string[] = [];

type Scene = {
  id: string;
  staff: string;
  customer: string;
  /** 今日入れた事実が現れるか */
  want: RegExp;
  wantNote: string;
  /** AI が前に書いた間違い */
  forbid: RegExp;
  forbidNote: string;
  /** スタッフが実際に送った文（ブレの確認用） */
  actual: string;
};

const SCENES: Scene[] = [
  {
    id: "①店舗へ伺いたい（AIは店舗訪問を受け入れていた）",
    staff: "YUMAさんお世話になっております！！\nご希望のご条件に合ったお部屋ピックアップしてお送りさせて頂きます！！",
    customer: "承知いたしました。当日はそちらの店舗へ伺い、ご相談させていただきながら、ほかの物件もご紹介いただければと思います。",
    want: /(オンライン専門|店舗で(は|ではあり)|店舗では(無|な)|ご来社|来店.{0,6}(出来|でき)ない|事務所)/,
    wantNote: "弊社はオンライン専門・事務所はあるが店舗ではなく来社での相談は受けていない",
    forbid: /(店舗|そちら)[^。\n]{0,14}(お待ちしております|お越しください|ご案内させて|ご相談させて|伺って)/,
    forbidNote: "店舗訪問を受け入れる（前の AI はこれを書いた）",
    actual: "李維さん／お世話になっております！！／担当の鈴木です！！／弊社オンライン専門の不動産サービスとなります！／大阪市中央区瓦町3-4-10日宝御堂ビル5階に事務所ございますが／店舗では無く作業用の事務所となりますので、ご来社でのご相談が出来ない形となります！！",
  },
  {
    id: "②緊急連絡先は必須か（AIは曖昧にぼかしていた）",
    staff: "YUMAさんお世話になっております！！\nお申込に必要なご情報となります😊！！\n上記フォーマットご入力いただき、ご本人確認書類をお送りください！！",
    customer: "緊急連絡先は必ず必要ですか？",
    want: /(必須|必要となり|必要でござ|3親等|三親等)/,
    wantNote: "必須・3親等以内（お母様・お父様・ご兄弟など）",
    forbid: /(柔軟に対応|ケースもござ|物件によって|場合によって|必ずしも)/,
    forbidNote: "「柔軟に対応頂けるケースもございます」と曖昧にする（前の AI はこれを書いた）",
    actual: "お申込みするにあたり緊急連絡先様は必須となります！！／お母様、お父様などYUMAさんから3親等以内の方で設定ください😌！！",
  },
  {
    id: "③室内写真が欲しい（AIは「写真が無い」と嘘をついた）",
    staff: "YUMAさんお世話になっております！！\nお送り頂きましたお部屋の募集状況確認させて頂きます！！",
    customer: "これ室内写真欲しいです",
    want: /(撮影|お送りさせて|送らせて|ご用意させて|添付)/,
    wantNote: "室内の写真・動画はスタッフが撮影して送れる",
    forbid: /(ご用意出来ていない|ご用意できていない|写真が(無|な)い|ございません)/,
    forbidNote: "「貸主側で室内写真がまだご用意出来ていない」と無い事実を断定（前の AI はこれを書いた）",
    actual: "こうさん／お世話になっております！！／横井第6ビルの室内イメージ添付させていただきました！！／お手隙の際にご確認ください！！",
  },
  {
    id: "④キャンセルできるか（固定の事実が要る場面）",
    staff: "YUMAさんお世話になっております！！\nこちら初期費用の御見積書となります😊！！\nお手隙の際にご査収ください！！",
    customer: "もし申し込んだ後にキャンセルしたらキャンセル料とかかかりますか？",
    want: /(保証会社|審査)[^。\n]{0,16}(通過|通る)[^。\n]{0,14}(まで|前)|キャンセル料[^。\n]{0,12}(かかりません|無料|発生しません)/,
    wantNote: "保証会社の審査が通過するまではキャンセル料がかからない",
    forbid: /(キャンセル料[^。\n]{0,10}(発生|かかります)|確認させて頂きます)/,
    forbidNote: "キャンセル料がかかると言う／答えられるのに「確認します」で逃げる",
    actual: "かずやさんお世話になっております！！／キャンセルにつきまして、保証会社の審査が通る前であればキャンセル料は一切かかりませんのでご安心ください😊！！",
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
  const reps = Number(process.env.REPS ?? 2);
  console.log(`=== 会社の事実が届くか（YUMA・本番と同じ経路）／ ${SCENES.length}場面 × ${reps}回 ===\n`);
  // 先に判定側（コード）が当たることを確かめる。ここが外れていたら生成を待つ意味がない
  console.log(`【判定の確認】お客様の発言に事実が当たるか`);
  for (const s of SCENES) {
    const ids = matchCompanyFacts(s.customer).map((f) => f.id);
    console.log(`   ${ids.length ? "✓" : "✗"} ${s.id.slice(0, 30)} → ${ids.join(",") || "当たらない"}`);
  }
  console.log("");
  await sweepLeftovers();

  let ok = 0, ngWant = 0, ngForbid = 0, empty = 0;
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
      const bad = s.forbid.test(draft);
      if (got && !bad) { ok++; console.log(`${head} ✓ 事実が入り、間違いも書いていない`); }
      else { if (!got) ngWant++; if (bad) ngForbid++; console.log(`${head} ✗ ${!got ? `事実が入らない（${s.wantNote}）` : ""}${bad ? ` ／ ⚠ ${s.forbidNote}` : ""}`); }
      console.log(`      生成 : ${draft.replace(/\n/g, " / ").slice(0, 150)}`);
      if (k === 0) console.log(`      実送信: ${s.actual.slice(0, 150)}`);
    }
  }
  const total = ok + ngWant + ngForbid;
  console.log(`\n=== 結果（${ok + Math.max(ngWant, ngForbid)}回・下書きなし ${empty}） ===`);
  console.log(`   ✓ 事実が入り間違いなし   ${ok}`);
  console.log(`   ✗ 事実が入らなかった     ${ngWant}`);
  console.log(`   ⚠ 間違いを書いた         ${ngForbid}`);
  void total;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (cleanup.length) { await sb.from("messages").delete().in("id", cleanup); console.log(`片付け: ${cleanup.length}件`); } });
