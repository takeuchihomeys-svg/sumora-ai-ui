// 今日入れた「会社の事実」が実際の生成文に現れるかを確かめる（generate-reply を直接叩く）
//
// 2026-09-23 竹内「実際に生成される文と直近でスタッフが改善したところにブレなどないか確認する／
//   今日の改善でちゃんと改善されているのか」
//
// ⚠ なぜ bg-async ではなく generate-reply を直接叩くか:
//   設計知見「YUMA で実物の場面を再現しても同じ判断にならない — 下書きが出ない形で止まる」。
//   実際 bg-async 経由では8回すべて AIX 誘導（property_send / property_check_result）になり、
//   下書きが1通も出なかった（YUMA の会話履歴と状態に引きずられる）。
//   ここで見たいのは**生成側が事実を使うか**なので、画面と同じ形で generate-reply を直接叩く
//   （body は app/page.tsx の fetch と同じ形。scripts/yuma-generate-test.ts と揃える）。
//
// 【場面】想像で作らない。AI が実際に間違えた実物＋スタッフの実送信（正解）を持つ。
// 実行: npx tsx --env-file=.env.local scripts/yuma-company-facts-direct.ts [REPS=2]
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts } from "../app/lib/company-facts";
import { nameVariants } from "../app/lib/pii-pseudonym";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

type Scene = { id: string; msg: string; want: RegExp; wantNote: string; forbid: RegExp; forbidNote: string; actual: string };
const SCENES: Scene[] = [
  {
    id: "①店舗へ伺いたい",
    msg: "承知いたしました。当日はそちらの店舗へ伺い、ご相談させていただきながら、ほかの物件もご紹介いただければと思います。",
    want: /(オンライン専門|店舗で(は|ではあり)|店舗では(無|な)|ご来社|来店.{0,8}(出来|でき)ない|事務所)/,
    wantNote: "オンライン専門・事務所はあるが店舗ではなく来社での相談は受けていない",
    forbid: /(店舗|そちら)[^。\n]{0,16}(お待ちしております|お越しください|ご案内させて|ご相談させて|伺って)/,
    forbidNote: "店舗訪問を受け入れる（前の AI はこれを書いた）",
    actual: "弊社オンライン専門の不動産サービスとなります！／大阪市中央区に事務所ございますが／店舗では無く作業用の事務所となりますので、ご来社でのご相談が出来ない形となります！！",
  },
  {
    id: "②緊急連絡先は必須か",
    msg: "緊急連絡先は必ず必要ですか？",
    want: /(必須|必要となり|必要でござ|3親等|三親等)/,
    wantNote: "必須・3親等以内（お母様・お父様・ご兄弟など）",
    forbid: /(柔軟に対応|ケースもござ|物件によって|場合によって|必ずしも)/,
    forbidNote: "「柔軟に対応頂けるケースもございます」と曖昧にする（前の AI はこれを書いた）",
    actual: "お申込みするにあたり緊急連絡先様は必須となります！！／お母様、お父様など3親等以内の方で設定ください😌！！",
  },
  {
    id: "③室内写真が欲しい",
    msg: "これ室内写真欲しいです",
    want: /(撮影|お送りさせて|送らせて|ご用意させて|添付)/,
    wantNote: "室内の写真・動画はスタッフが撮影して送れる",
    // 2026-09-23 S2 の実測で見逃した形「ご用意できておりません」「弊社での室内撮影は行えておらず」を足す
    forbid: /(ご用意(?:出来|でき)て(?:いない|おりません|いません)|写真が(無|な)い|写真はございません|撮影(?:は|を)?(?:行|して)(?:え|い)?て(?:おりません|いません|おらず))/,
    forbidNote: "「貸主側で室内写真がまだご用意出来ていない」と無い事実を断定（前の AI はこれを書いた）",
    actual: "室内イメージ添付させていただきました！！／お手隙の際にご確認ください！！",
  },
  {
    id: "④キャンセル料はかかるか",
    msg: "もし申し込んだ後にキャンセルしたらキャンセル料とかかかりますか？",
    want: /(保証会社|審査)[^。\n]{0,18}(通過|通る)[^。\n]{0,16}(まで|前)|キャンセル料[^。\n]{0,14}(かかりません|無料|発生しません|一切)/,
    wantNote: "保証会社の審査が通過するまではキャンセル料がかからない",
    forbid: /キャンセル料[^。\n]{0,10}(発生いたします|かかります)/,
    forbidNote: "キャンセル料がかかると言う",
    actual: "キャンセルにつきまして、保証会社の審査が通る前であればキャンセル料は一切かかりませんのでご安心ください😊！！",
  },
];

async function main() {
  const reps = Number(process.env.REPS ?? 2);
  const { data: conv } = await sb.from("conversations").select("status, customer_name, has_viewed").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  const { data: msgs } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(20);
  const recentMessages = ((msgs ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""),
    imageUrl: (m.image_url as string | null) ?? undefined,
    createdAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));
  console.log(`=== 会社の事実が生成文に現れるか（YUMA [${String(c.status)}] 履歴${recentMessages.length}通）／ ${SCENES.length}場面 × ${reps}回 ===\n`);
  console.log(`【判定の確認】お客様の発言に事実が当たるか`);
  for (const s of SCENES) console.log(`   ${matchCompanyFacts(s.msg).length ? "✓" : "✗"} ${s.id} → ${matchCompanyFacts(s.msg).map((f) => f.id).join(",") || "当たらない"}`);
  console.log("");

  // 2026-09-23 DeepSeek 経路の実測で「黒明さん」（別のお客様の実名）が下書きに混入した（仮名化の戻しの不具合）。
  //   全会話のお客様名を持って、当事者以外の名前が出たら ⚠ を出す（本名は出力しない・件数だけ）
  const { data: nameRows } = await sb.from("conversations").select("customer_name").limit(2000);
  const party = String(c.customer_name ?? "YUMA").trim();
  // 会話名そのものと、手本に出る形（姓・名・装飾を外した形）の両方で見る（pii-pseudonym と同じ nameVariants）
  const otherNames = [...new Set(((nameRows ?? []) as Array<{ customer_name: string | null }>).map((r) => (r.customer_name ?? "").trim())
    .filter((n) => n.length >= 2 && n !== party).flatMap((n) => [n, ...nameVariants(n)]).filter((n) => n.length >= 2 && n !== party))];
  let foreign = 0;

  let ok = 0, ngWant = 0, ngForbid = 0, empty = 0;
  for (const s of SCENES) {
    for (let k = 0; k < reps; k++) {
      const body = {
        message: s.msg, customerMessages: [s.msg], state: String(c.status ?? "proposing"),
        conversationId: YUMA, customerName: String(c.customer_name ?? "YUMA"),
        hasViewed: !!c.has_viewed, activeTaskTypes: [] as string[],
        recentMessages: [...recentMessages, { sender: "customer", text: s.msg, createdAt: new Date().toISOString(), isAix: false }],
      };
      let text = "";
      try {
        const res = await fetch(`${BASE}/api/generate-reply`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const raw = await res.text();
        const nl = raw.indexOf("\n");
        text = nl >= 0 ? raw.slice(nl + 1) : raw;
      } catch (e) { text = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
      // 内部タグを外して「お客様に見える文」にする
      const draft = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
      const head = `【${s.id}】[${k + 1}]`;
      if (!draft || /^【エラー】/.test(draft)) { empty++; console.log(`${head} 出なかった: ${draft.slice(0, 80)}`); continue; }
      const leaked = otherNames.filter((n) => draft.includes(`${n}さん`) || draft.includes(`${n}様`));
      if (leaked.length) { foreign++; console.log(`${head} ⚠ 別のお客様の名前が混入（${leaked.length}件・本名は出力しない: ${leaked.map((n) => `${n[0]}*×${n.length}字`).join(",")}）`); }
      const got = s.want.test(draft);
      const bad = s.forbid.test(draft);
      if (got && !bad) { ok++; console.log(`${head} ✓ 事実が入り、間違いも書いていない`); }
      else { if (!got) ngWant++; if (bad) ngForbid++; console.log(`${head} ✗ ${!got ? `事実が入らない（要: ${s.wantNote}）` : ""}${bad ? ` ／ ⚠ ${s.forbidNote}` : ""}`); }
      console.log(`      生成 : ${draft.replace(/\n/g, " / ").slice(0, 160)}`);
      if (k === 0) console.log(`      実送信: ${s.actual.slice(0, 160)}`);
    }
  }
  console.log(`\n=== 結果（出た ${ok + ngWant + ngForbid}回・出なかった ${empty}） ===`);
  console.log(`   ✓ 事実が入り間違いなし   ${ok}`);
  console.log(`   ✗ 事実が入らなかった     ${ngWant}`);
  console.log(`   ⚠ 間違いを書いた         ${ngForbid}`);
  console.log(`   ⚠ 別のお客様の名前が混入 ${foreign}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
