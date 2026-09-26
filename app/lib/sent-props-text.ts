// app/lib/sent-props-text.ts
// ブレインに注入する【すでに送付済みの物件】の組み立て（純関数・brain-core.ts から切り出し）。
//
// 2026-09-24 竹内「これで送ったのとかも判断できる。どれ物件ピックアップで送ったか物件オススメで送ったかもわかる」:
//   ・お客様に送った行 → 画像の行 → グループに共有のみの行 の順に並べる（物件名＋号室の重複除けがこの順で効くので、送った事実が勝つ）
//   ・見出しの件数はお客様に送った件数。共有のみは同じブロックの下に「▼グループに共有のみ（お客様には未送付）」で並べる
//   ・「絶対に再提案しない」は両方に効く文のまま（抑止の範囲は変えない）
//   ・🌟オススメ・📤ピックアップの印は channel から（sent_properties の channel と sent_image_properties の source の両方）
import { jstMD } from "@/app/lib/jst-date";
import { rowChannel } from "@/app/lib/sent-delivery";

export type SentProp = {
  property_name: string; room_no: string; sent_at: string; rent: number | null;
  recruitment_status: string | null; applicant_rank: number | null; customer_reaction: string | null;
  /** 画像から読み取って記録した物の経路（sent_image_properties.source） */
  sent_via?: string | null;
  /** 送った経路（pickup / recommendation …） */
  channel?: string | null;
  source?: string | null;
  /** グループに共有しただけ（お客様には未送付） */
  shared_only?: boolean;
};

type CustomerRow = { property_name: string | null; room_no: string | null; sent_at: string | null; rent?: number | null; recruitment_status?: string | null; applicant_rank?: number | null; customer_reaction?: string | null; source?: string | null; channel?: string | null };
type ImageRow = { property_name: string | null; room_no: string | null; created_at: string | null; source: string | null; channel?: string | null };
type SharedRow = { property_name: string | null; room_no: string | null; sent_at: string | null; rent?: number | null };

const RECRUIT_LABEL: Record<string, string> = { open: "募集中", move_out_planned: "退去予定", occupied: "入居中", closed: "募集終了" };
const REACTION_LABEL: Record<string, string> = { interested: "興味あり", rejected: "見送り", no_response: "反応なし" };

export function buildSentProps(input: { customerRows: CustomerRow[]; imageRows: ImageRow[]; sharedRows: SharedRow[] }): SentProp[] {
  const seen = new Set<string>();
  const out: SentProp[] = [];
  const add = (p: SentProp) => {
    const name = (p.property_name ?? "").trim();
    if (!name) return;
    const key = `${name}|${(p.room_no ?? "").trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...p, property_name: name, room_no: (p.room_no ?? "").trim() });
  };
  // 2026-09-20: property_customer_id と conversation_id の両方で引くので、同じ物件が2行来ることがある（先頭＝新しい方を残す）
  for (const p of input.customerRows) {
    add({
      property_name: p.property_name ?? "", room_no: p.room_no ?? "", sent_at: p.sent_at ?? "", rent: p.rent ?? null,
      recruitment_status: p.recruitment_status ?? null, applicant_rank: p.applicant_rank ?? null, customer_reaction: p.customer_reaction ?? null,
      source: p.source ?? null, channel: rowChannel({ channel: p.channel ?? null, source: p.source ?? null }),
    });
  }
  // 2026-09-20 竹内（物件把握の監査）: 画像だけで送った物件（送信時の読み取り）を足す。既に sent_properties にある物件は重複させない
  for (const p of input.imageRows) {
    add({
      property_name: p.property_name ?? "", room_no: p.room_no ?? "", sent_at: p.created_at ?? "", rent: null,
      recruitment_status: null, applicant_rank: null, customer_reaction: null,
      sent_via: p.source ?? null, channel: rowChannel({ channel: p.channel ?? null, source: p.source }),
    });
  }
  // 共有のみ（グループに出しただけ）。再提案の抑止は効かせたまま、見出しを分けて出す
  //   共有の行は号室が殆ど無い（0.1%）ので、号室なしの共有の行は同じ建物をお客様に送っていれば出さない
  //   （「YUMAテスト荘 101 を送付」と「YUMAテスト荘 共有のみ・未送付」が並んで食い違わないように）
  const sentNames = new Set(out.map((p) => p.property_name));
  for (const p of input.sharedRows) {
    if (!(p.room_no ?? "").trim() && sentNames.has((p.property_name ?? "").trim())) continue;
    add({
      property_name: p.property_name ?? "", room_no: p.room_no ?? "", sent_at: p.sent_at ?? "", rent: p.rent ?? null,
      recruitment_status: null, applicant_rank: null, customer_reaction: null, channel: "extension_group", shared_only: true,
    });
  }
  return out;
}

export function buildSentPropsText(sentProps: SentProp[]): string {
  if (sentProps.length === 0) return "";
  // 2026-09-20 竹内「どの物件をお客さんにたいしてオススメしたのか分かるように」→ 内覧・見積の相手を取り違えない
  const recommendedProps = sentProps.filter((p) => !p.shared_only && p.channel === "recommendation");
  const deliveredProps = sentProps.filter((p) => !p.shared_only);
  const sharedOnlyProps = sentProps.filter((p) => p.shared_only);
  const line = (p: SentProp) => {
    const facts = [
      p.rent != null ? `家賃${p.rent.toLocaleString()}円` : "",
      p.recruitment_status ? `募集状況:${RECRUIT_LABEL[p.recruitment_status] ?? p.recruitment_status}` : "",
      p.applicant_rank != null ? `${p.applicant_rank}番手` : "",
      p.customer_reaction ? `顧客反応:${REACTION_LABEL[p.customer_reaction] ?? p.customer_reaction}` : "",
    ].filter(Boolean).join("・");
    if (p.shared_only) return `- ${p.property_name} ${p.room_no}（${jstMD(p.sent_at)} グループに共有のみ・お客様には未送付${facts ? `・${facts}` : ""}）`;
    const via = p.channel === "recommendation" ? "・🌟オススメで送付" : p.channel === "pickup" ? "・📤ピックアップで送付" : "";
    return `- ${p.property_name} ${p.room_no}（${jstMD(p.sent_at)}送付${facts ? `・${facts}` : ""}${via}）`;
  };
  const sharedBlock = sharedOnlyProps.length > 0
    ? `${deliveredProps.length > 0 ? "\n" : ""}▼グループに共有のみ（お客様には未送付・再提案は避ける）\n${sharedOnlyProps.map(line).join("\n")}`
    : "";
  // 2026-09-26 段3（切り替え）: 旧「内覧・見積・申込の話はこのお部屋が相手になる（別の物件にすり替えない）」は、
  //   お客様が自分で見つけた物件（SUUMO の URL・画像）や、後から名前を出した別のお部屋の内覧・見積の話まで、推した物件に寄せる入口になり得た
  //   （設計知見「1つの物件へのとらわれは…」の (c)・害は小）。お客様がどのお部屋か言っていない時だけの既定にする
  const recNote = recommendedProps.length > 0
    ? `\n※このうち **${recommendedProps.map((p) => `${p.property_name} ${p.room_no}`.trim()).join("・")}** は AIX【物件オススメ】で推した物件。内覧・見積・申込の話でお客様がどのお部屋か言っていない時は、このお部屋が相手の第一候補（お客様が名前・URL・画像で別のお部屋を指している時は、そのお部屋が相手）。`
    : "";
  return `\n【すでに送付済みの物件（${deliveredProps.length}件）】\n${deliveredProps.map(line).join("\n")}${sharedBlock}${recNote}\n※上記の物件は絶対に再提案しないこと（顧客が明示的に再リクエストした場合を除く。例外: 顧客が申込→落選した物件と同一マンションの別号室が新規募集された場合は、最優先で提案し申込訴求すること。申込経験のある建物は建物の印象・共用部・立地を把握済みのため内覧スキップ可能）。property_send・property_recommendation の候補から必ず除外すること。`;
}
