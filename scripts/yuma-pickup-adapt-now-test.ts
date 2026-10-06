// scripts/yuma-pickup-adapt-now-test.ts
// 会話を合わせるの物件ピックアップ（あかりさんの事例の形）を YUMA で生成だけして、今の場面（一人暮らしに変わった・依頼に応えた送付）が
// 文に出るかを見る（/api/aix/action は文を返すだけ・LINE へは送らない・DB の会話には書かない＝場面は本文で渡す）。
// 2026-10-06 ⑰。手順書 memory/test_protocol_brain.md: サーバは LLM_TEST_MODE=deepseek-all で起動（requireTestServer が確かめる）・YUMA だけ・名前と物件名は伏せる
// 実行: BASE_URL=http://localhost:3477 npx tsx --env-file=.env.local scripts/yuma-pickup-adapt-now-test.ts [回数]
import { requireTestServer } from "./lib/dev-server-test-guard";

const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3477";
const N = parseInt(process.argv[2] ?? "2", 10);

// あかりさん（10/01〜10/04）の形。名前は YUMA・物件名は伏せる
const SCENE: Array<{ sender: string; text: string; at: string }> = [
  { sender: "staff", at: "2026-10-01T02:03:50Z", text: "YUMAさんお送り頂きました物件の中で\n・Aマンション 6FA\n・B大物町 301号室\nこちら2件どちらも現在募集中となります！！\n最大限割引しました初期費用御見積書同封させて頂きました。\nお手隙の際にご査収ください！！" },
  { sender: "customer", at: "2026-10-01T02:05:14Z", text: "最短でどのくらいに入れるってなってますか！大物のほう！です" },
  { sender: "staff", at: "2026-10-01T02:07:18Z", text: "B大物町301号室\n最短での入居可能時期10/8日となります！！" },
  { sender: "customer", at: "2026-10-01T02:09:07Z", text: "ふたり入居可ですか？" },
  { sender: "staff", at: "2026-10-01T02:24:21Z", text: "B大物町お2人でのご入居可能なお部屋となります😌！！" },
  { sender: "customer", at: "2026-10-01T02:25:54Z", text: "一緒に住む人に相談します！" },
  { sender: "customer", at: "2026-10-02T10:57:11Z", text: "別れることになって" },
  { sender: "customer", at: "2026-10-02T10:57:14Z", text: "私一人になるかもです" },
  { sender: "staff", at: "2026-10-02T12:38:53Z", text: "YUMAさんお世話になっております！！\nご事情お聞かせ頂きありがとうございます😌！！\nお一人でのご入居となりますと、ご希望の条件が変わることもあるかと思いますので、改めて家賃・広さ・設備のご希望を教えて頂けますと幸いです！！" },
  { sender: "customer", at: "2026-10-02T12:41:56Z", text: "なんかいい部屋ありますかね" },
  { sender: "customer", at: "2026-10-02T12:42:09Z", text: "ここの部屋に似た感じでちっさくて大丈夫です！" },
  { sender: "staff", at: "2026-10-04T02:24:45Z", text: "かしこまりました！！\nオススメできるお部屋ピックアップさせていただきます😊！！" },
  { sender: "staff", at: "2026-10-04T02:25:31Z", text: "以前お送りいただきましたお部屋探しのご条件から変更される条件はございますでしょうか！！" },
];
const CONDITIONS = "エリア：大阪市西淀川区\n家賃：65,000円以内\nこだわり条件：二人入居可・築浅・バストイレ別・独立洗面台";

(async () => {
  await requireTestServer(BASE, "yuma-pickup-adapt-now-test");
  const recent_messages = SCENE.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.at, rawCreatedAt: m.at, isAix: false }));
  for (let i = 0; i < N; i++) {
    const body = {
      action: "property_send", customer_name: "YUMA", account: "sumora", conversation_id: YUMA, recent_messages,
      customer_conditions: CONDITIONS, send_mode: "new_arrival", conversation_match: true,
      image_urls: Array.from({ length: 7 }, (_, k) => `https://example.invalid/test-${k}.jpg`),
    };
    const t0 = Date.now();
    const r = await fetch(`${BASE}/api/aix/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    const j = await r.json().catch(() => ({})) as { message?: string; error?: string };
    const text = String(j.message ?? j.error ?? "");
    console.log(`\n── ${i + 1}回目（${Math.round((Date.now() - t0) / 1000)}秒・HTTP ${r.status}）\n${text}`);
    console.log(`  一人暮らし・小さめ等の今の場面: ${/一人|お一人|ひとり|コンパクト|小さ/.test(text) ? "○" : "×"}／「新着で…募集に出ました」の決まった言い方: ${/新着で.{0,20}募集に(?:出|で)ました/.test(text) ? "あり" : "なし"}／二人入居可を書いた: ${/二人入居|2人入居|お二人/.test(text) ? "あり（×）" : "なし"}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
