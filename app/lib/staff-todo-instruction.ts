// app/lib/staff-todo-instruction.ts — 【やることリスト】の「的確な指示」（どのボタン→どのピッカー→何を入れる／確かめる）を作る（純関数・DB も LLM もなし）
//
// 2026-10-21 竹内さんの決定（設計知見 c0a91198）「やることリスト次やることが分かっている場合は的確な指示をいれておく
//   出来る限り従業員は何も考えず作業する形にしていくため」。例:
//   『AIX【物件確認した】→管理会社に確認した→駐車場について：空き状況と月額を管理会社に確認して入力』
//   『AIX【物件ピックアップした】→新着まとめ：条件（〇〇駅・〜8万・2LDK・ペット可）で新着を確認、無ければ☑』
// 決まり: 作らない（推測しない）。ボタン・ピッカーは記録（約束の行の check_pattern・ピッカー鍵・物件を送った事実）と
//   お客様の条件の欄（property_customers）にある物だけで書く。分からない所は null を返し、一覧は今までの文（やる事）のまま。
//   ボタン・ピッカーの言葉は画面の実物（aix-pickers.ts）から引く（同じ事実を2か所に置かない）。
// テスト: app/lib/__tests__/staff-todo-instruction.test.ts
import { CONDITION_CHECK_OPTIONS, AVAILABILITY_RESULT_OPTIONS } from "./aix-pickers";

/** 確認した（条件・交渉）の各ピッカーで「何を確かめて入れるか」（画面の中の選ぶ・入れる欄＝aix-pickers の子の欄に合わせる） */
const CHECK_WHAT: Record<string, string> = {
  mgmt_parking: "空き状況と月額",
  mgmt_pet: "ペット可否（可／不可／相談可）と条件",
  mgmt_guarantor: "保証会社の名前と種類（独立系／信販系／信用系）",
  mgmt_move_in: "入居可能日",
  vacate_date: "退去予定日",
  mgmt_availability: "募集状況（募集している／募集終了した）",
  mgmt_equipment: "設備の有無",
  mgmt_company: "管理会社の名前と連絡先",
  mgmt_proxy: "代理契約の可否",
  mgmt_two_person: "二人入居の可否",
  mgmt_lifeline: "ライフラインの指定の有無と連絡先",
  mgmt_application_status: "申込の有無と何番手か",
  mgmt_initial_cost: "初期費用の交渉の結果（見積書おくる／管理会社交渉 を選ぶ）",
  mgmt_contract_terms: "短期解約の違約金・クリーニング代・フリーレント",
  mgmt_rent_negotiation: "家賃の交渉の結果と交渉後の家賃",
  mgmt_screening: "名義・保証人・職業・国籍・時期の審査の見込み",
};
const CHECK_LABEL: Record<string, string> = Object.fromEntries(CONDITION_CHECK_OPTIONS.map((o) => [o.value, o.label]));
const AVAIL_VALUES = new Set(AVAILABILITY_RESULT_OPTIONS.map((o) => o.value));

/** お客様の条件の欄（property_customers の列のまま） */
export type TodoConditionRow = {
  desired_area?: string | null; commute_station?: string | null; commute_minutes?: number | null;
  rent_max?: number | null; floor_plan?: string | null; other_requests?: string | null;
};
const KEY_REQ_RE = /ペット|駐車場|独立系|敷金|礼金|敷礼|初期費用|築浅|オートロック|バス|トイレ|2階以上|角部屋|楽器|家具|インターネット|ネット無料/;

/**
 * 条件の一言（〇〇駅・〜8万・2LDK・ペット可）。欄にある物だけ。何も無ければ null。
 *   駅（無ければエリアの先頭1つ）→ 家賃の上限 → 間取り → その他の要望のうち決まった語を含む短い物を2つまで
 */
export function conditionShort(c: TodoConditionRow | null | undefined): string | null {
  if (!c) return null;
  const parts: string[] = [];
  const st = (c.commute_station ?? "").replace(/\s+/g, "").trim();
  if (st && st !== "市内") parts.push(`${st.replace(/駅$/, "")}駅${c.commute_minutes ? `${c.commute_minutes}分` : ""}`);
  else {
    const a = (c.desired_area ?? "").replace(/[（(][^）)]*[）)]/g, "").split(/[、,，・\/\s]/).map((x) => x.trim()).filter(Boolean)[0];
    if (a) parts.push(a.slice(0, 10));
  }
  if (c.rent_max && c.rent_max > 0) {
    const man = Math.round(c.rent_max / 1000) / 10;
    parts.push(`〜${Number.isInteger(man) ? man : man.toFixed(1)}万`);
  }
  // 括弧の説明（「1LDK（横並びの部屋・築浅）」）は落とす（途中で切れて読めなくなるため）
  const fp = (c.floor_plan ?? "").replace(/[（(][^）)]*[）)]?/g, "").replace(/\s+/g, "").trim();
  if (fp) parts.push(fp.slice(0, 10));
  const reqs = (c.other_requests ?? "").split(/[、,，・\n。／/]/).map((x) => x.trim()).filter((x) => x && x.length <= 10 && KEY_REQ_RE.test(x));
  parts.push(...[...new Set(reqs)].slice(0, 2));
  return parts.length ? parts.join("・") : null;
}

export type TodoInstructionInput = {
  action: string | null;
  checkPattern: string | null;
  /** 行の元（新着の物件確認の行は "target_new_arrival"） */
  source: string;
  /** 約束の行の見出し（新着・物件名の手がかり。無ければ null） */
  taskText?: string | null;
  /** お客様に物件を送った事が一度でもあるか（初回まとめ／新着まとめの見分け。分からなければ null） */
  everSent?: boolean | null;
  /** お客様の条件の一言（conditionShort） */
  conditions?: string | null;
  /** ピックアップの約束の種類（約束の記録 sent_facts.detail.pickupKind・ピッカー鍵 から。無ければ null） */
  pickupKind?: "new_arrival" | "pickup" | null;
  /** 確かめる物件の名前（約束の行・記録にある時だけ） */
  propertyName?: string | null;
};

const condPart = (c: string | null | undefined) => (c ? `条件（${c}）で` : "ご条件で");

/**
 * 的確な指示の文（ボタン→ピッカー→何を入れる／確かめる）。分からない時は null（一覧は今までの「やる事」のまま）
 *   期限は一覧の行が（期限 …）で付けるのでここには書かない
 */
export function todoInstruction(i: TodoInstructionInput): string | null {
  const obj = (i.propertyName ?? "").trim();
  const objPart = obj ? `${obj.slice(0, 20)}の` : "";
  // ① 確認した（条件・交渉）: 約束の行・要対応の check_pattern がある時だけ
  if (i.action === "property_check_result" && i.checkPattern) {
    const cp = i.checkPattern;
    if (cp === "nearby_parking") return `AIX【物件確認した】→近隣の月極駐車場を確認した：${objPart}近くの月極駐車場の名前・距離・料金・空きを確認して入力`;
    if (CHECK_LABEL[cp]) {
      const what = CHECK_WHAT[cp];
      return `AIX【物件確認した】→管理会社に確認した→${CHECK_LABEL[cp]}：${objPart}${what ? `${what}を` : ""}管理会社に確認して入力`;
    }
    if (AVAIL_VALUES.has(cp)) return null; // 結果のピッカー（物件あった 等）はスタッフが確かめて選ぶ＝前もって決めない
    return null;
  }
  // ② 募集状況の確認（check_pattern 無し＝結果はスタッフが選ぶ）
  if (i.action === "property_check_result") {
    return `AIX【物件確認した】→募集状況：${objPart}募集状況を管理会社に確認し「物件あった／物件なかった／別の部屋が募集してた」を選ぶ`;
  }
  // ③ 物件を送る（ピックアップの約束・要対応・ターゲットの毎日の新着確認）
  const newArrival = i.pickupKind === "new_arrival" || (i.source === "target_new_arrival" && i.everSent === true) || (i.source !== "target_new_arrival" && /新着/.test(i.taskText ?? ""));
  if (i.action === "property_send" || i.action === "property_recommendation" || i.source === "target_new_arrival") {
    const tail = i.source === "target_new_arrival" ? "、無ければ☑" : "";
    if (newArrival) return `AIX【物件ピックアップした】→新着まとめ：${condPart(i.conditions)}新着を確認して送る${tail}`;
    if (i.everSent === false) return `AIX【物件ピックアップした】→初回まとめ：${condPart(i.conditions)}探して送る${tail}`;
    // 送ったことがある・種類が分からない＝ピッカーは決めない（条件だけ添える）
    if (i.conditions || tail) return `AIX【物件ピックアップした】：${condPart(i.conditions)}探して送る${tail}`;
    return null;
  }
  // ④ 御見積書（物件名が分かる時だけ）
  if (i.action === "estimate_sheet" && obj) return `AIX【見積書送る】：${obj.slice(0, 20)}の御見積書を作って送る`;
  return null;
}
