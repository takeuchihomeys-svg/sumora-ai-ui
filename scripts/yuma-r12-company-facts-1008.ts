// 10/08 竹内さんの答え（申込は基本的に30日前から・オーナー審査以降のキャンセル料・SUUMO の物件・虫は7階以上・内覧後の見積書は頼まれた時だけ）が
//   生成文に届くかを generate-reply を直接叩いて確かめる（YUMA・書き込みなし＝下書きを画面に返すだけ）
//   手順書 memory/test_protocol_brain.md: 開発サーバは LLM_TEST_MODE=deepseek-all（試行錯誤）／最後だけ LLM_TEST_FINAL_CLAUDE=1 で場面ごとに1回
//   お客様の文は実物（scripts/audit-r12-company-facts-1008.ts で読んだ通・名前は無し）
// 実行: BASE_URL=http://localhost:3471 REPS=2 npx tsx --env-file=.env.local scripts/yuma-r12-company-facts-1008.ts
import { requireTestServer } from "./lib/dev-server-test-guard";
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts } from "../app/lib/company-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

type Scene = { id: string; state?: string; viewed?: boolean; staffBefore?: string; msg: string; want: RegExp | null; wantNote: string; forbid: RegExp; forbidNote: string; actual: string };
const SCENES: Scene[] = [
  {
    id: "①申込はいつから（9/06 の実物）",
    staffBefore: "YUMAさんお世話になっております！！\nご条件に合ったお部屋ピックアップさせて頂きました😊！！\nお手隙の際にご査収ください😌！！",
    msg: "ありがとうございます！\n10月29日くらいから入居希望ですが\nそれでも申し込みは出来ますか？",
    want: /30日前/, wantNote: "基本的にご入居日の30日前から（日付で伝えてよい）",
    forbid: /30日前から(?:しか|のみ)|必ず30日前|管理会社に確認|より早く抑え/, forbidNote: "言い切る・確認の約束に逃げる・事実に無い「より早く」",
    actual: "お申込しお部屋を抑える事が出来るのがご入居可能日の30日前となります！！／10月29日〜11月1日のご入居ですと9月29日以後にお申込頂く形となります！！",
  },
  {
    id: "②キャンセル料（オーナー審査以降）",
    staffBefore: "YUMAさんお世話になっております！！\nこちら初期費用の御見積書となります😊！！\nお手隙の際にご査収ください！！",
    msg: "もし申し込んだ後にキャンセルしたらキャンセル料とかかかりますか？",
    want: /オーナー審査/, wantNote: "保証会社の審査通過後オーナー審査開始まではかからない（以降は家賃1ヶ月分）",
    forbid: /キャンセル料[^。\n]{0,10}(?:発生いたします|かかります)(?![^。\n]{0,4}ん)|確認させて頂きます/, forbidNote: "無条件にかかると言う・確認に逃げる",
    actual: "保証会社の審査通過後オーナー審査開始までキャンセル料かかりませんので、お部屋抑えるのを推奨させて頂きます！！",
  },
  {
    id: "③SUUMO の物件を送ってよいか（8/21 の実物）",
    msg: "スーモとかで気になる物件あればこちらに送ってもいいですか？安くなる余地あればなんですけども。",
    want: /募集状況/, wantNote: "送って頂ければ募集状況の確認（＋最大限割引の御見積書）",
    forbid: /取り?扱(?:い)?(?:でき|出来)(?:ない|ません)|空いております|ご紹介(?:でき|出来)ません/, forbidNote: "取り扱えない・空いていると言い切る",
    actual: "もちろん大丈夫です😊！！気になるお部屋ございましたらお送りください！！募集状況の確認と最大限割引しました初期費用御見積し送らせて頂きます😌！！",
  },
  {
    id: "④2階だと虫は（9/05 の実物）",
    staffBefore: "YUMAさんお世話になっております！！\n2階のお部屋も募集中となります！！",
    msg: "遅くなり申し訳ないです💦\n2階だと虫とかって入ってきますかね？😭",
    want: /7階/, wantNote: "7階以上は虫が入りにくい（一般論で即答）",
    forbid: /管理会社に確認|確認させて頂きます|虫は(?:出|入)(?:ません|ない)/, forbidNote: "確認に逃げる・断言する",
    actual: "2階は虫が入る可能性御座います！！／お部屋7階以上ですと虫入る可能性ほとんど御座いませんので、虫気になられる場合は7階以上のお部屋でご選択頂くのがオススメです😊！",
  },
  {
    id: "⑤内覧後の前向きな感想（見積は頼まれていない）",
    state: "viewing", viewed: true,
    staffBefore: "YUMAさん本日お時間頂きありがとうございました！！\nご不明な点ございましたらお気軽にご連絡ください😊！！",
    msg: "今日はありがとうございました！とても良かったです！",
    want: null, wantNote: "申込の一言・受け止め",
    forbid: /見積/, forbidNote: "頼まれていない御見積書の作成宣言",
    actual: "（内覧後の感想への実送信 7通に見積の宣言 0通）",
  },
];

async function main() {
  await requireTestServer(BASE, "yuma-r12-company-facts-1008");
  const reps = Number(process.env.REPS ?? 2);
  const ONLY = process.env.ONLY ?? "";
  const { data: conv } = await sb.from("conversations").select("status, customer_name").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  console.log(`=== 10/08 の会社の事実・内覧後の見積（YUMA [${String(c.status)}]）／ ${SCENES.length}場面 × ${reps}回 ===`);
  for (const s of SCENES) console.log(`   判定 ${s.id} → ${matchCompanyFacts(s.msg).map((f) => f.id).join(",") || "当たらない"}`);
  let ok = 0, ng = 0, empty = 0;
  for (const s of SCENES.filter((x) => !ONLY || x.id.startsWith(ONLY))) {
    for (let k = 0; k < reps; k++) {
      const now = Date.now();
      const recentMessages = [
        ...(s.staffBefore ? [{ sender: "staff", text: s.staffBefore, createdAt: new Date(now - 30 * 60_000).toISOString(), isAix: false }] : []),
        { sender: "customer", text: s.msg, createdAt: new Date(now).toISOString(), isAix: false },
      ];
      const body = {
        message: s.msg, customerMessages: [s.msg], state: s.state ?? "proposing",
        conversationId: YUMA, customerName: "YUMA", hasViewed: !!s.viewed, activeTaskTypes: [] as string[], recentMessages,
      };
      let text = "";
      try {
        const res = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const raw = await res.text();
        const nl = raw.indexOf("\n");
        text = nl >= 0 ? raw.slice(nl + 1) : raw;
      } catch (e) { text = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
      const draft = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
      const head = `【${s.id}】[${k + 1}]`;
      if (!draft || /^【エラー】/.test(draft)) { empty++; console.log(`${head} 出なかった: ${draft.slice(0, 100)}`); continue; }
      const got = s.want ? s.want.test(draft) : true;
      const bad = s.forbid.test(draft);
      if (got && !bad) { ok++; console.log(`${head} ✓`); } else { ng++; console.log(`${head} ✗ ${!got ? `入らない（要: ${s.wantNote}）` : ""}${bad ? ` ⚠ ${s.forbidNote}` : ""}`); }
      console.log(`      生成 : ${draft.replace(/\n/g, " / ").slice(0, 220)}`);
      if (k === 0) console.log(`      実送信: ${s.actual.slice(0, 160)}`);
    }
  }
  console.log(`\n=== ✓ ${ok} ／ ✗ ${ng} ／ 出なかった ${empty} ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
