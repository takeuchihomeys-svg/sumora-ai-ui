/**
 * 手順書のサイト分け（2026-11-26 竹内さん「手順書これでできてる？」）
 * itandi の手順書にリアプロ専用の手（並べ替え AD・印刷用PDF・高→低）が入っていた。ITANDI は並べ替えが無い。
 * ・itandi では載せない ・既定（site 未指定）・realpro は従来どおり載る ・読み出しの作り直しも site を見る
 * npx tsx app/lib/__tests__/playbook-site-split.test.ts
 */
import { buildPlaybook, refreshPlaybookIfStale, PLAYBOOK_BUILD_V } from "../action-playbook";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

const EMPTY = { points: {}, opens: {}, scene_flows: [] } as never;
const REALPRO_HAND = /印刷用PDF|並べ替え|高→低|span\.sort_detail/;

function sceneSteps(pb: ReturnType<typeof buildPlaybook>, scene: string): string[] {
  const sc = pb.scenes.find((s) => s.scene === scene);
  return sc ? sc.steps.map((t) => String(t)) : [];
}

// 1. itandi: 一覧・検索にリアプロの手が無い
{
  const pb = buildPlaybook(EMPTY, "itandi");
  const list = sceneSteps(pb, "list");
  const search = sceneSteps(pb, "search");
  assert(!list.some((t) => REALPRO_HAND.test(t)), "itandi の一覧にリアプロの手（並べ替え・PDF）が無い: " + list.join(" / "));
  assert(!search.some((t) => REALPRO_HAND.test(t)), "itandi の検索にリアプロの手（並べ替え）が無い: " + search.join(" / "));
  const rulesAll = pb.scenes.flatMap((s) => s.rules ?? []);
  assert(!rulesAll.includes("ad_sort_hover"), "itandi の場面に AD 並べ替えの決まりが付かない");
  console.log("  ✓ itandi: 一覧・検索にリアプロの手が無い");
}

// 2. realpro（明示）と既定（未指定）は従来どおり載る
{
  for (const pb of [buildPlaybook(EMPTY, "realpro"), buildPlaybook(EMPTY)]) {
    const list = sceneSteps(pb, "list");
    assert(list.some((t) => /印刷用PDF/.test(t)), "realpro の一覧に従来の並べ替え・PDF が載る");
    const search = sceneSteps(pb, "search");
    assert(search.some((t) => /並べ替え/.test(t)), "realpro の検索に従来の把握→並べ替えが載る");
  }
  console.log("  ✓ realpro・既定（未指定）は従来どおり");
}

// 3. 読み出しの作り直し（refreshPlaybookIfStale）も site を見る
{
  const bundle = { points: {}, opens: {}, scene_flows: [], playbook: { build_v: 14 } } as Record<string, unknown>;
  const it = refreshPlaybookIfStale(bundle, "itandi");
  assert(it.refreshed === true, "古い作り方の手順書は作り直す");
  const itPb = (it.bundle as { playbook: ReturnType<typeof buildPlaybook> }).playbook;
  assert(!sceneSteps(itPb, "list").some((t) => REALPRO_HAND.test(t)), "作り直した itandi にリアプロの手が無い");
  const rp = refreshPlaybookIfStale(bundle, "realpro");
  const rpPb = (rp.bundle as { playbook: ReturnType<typeof buildPlaybook> }).playbook;
  assert(sceneSteps(rpPb, "list").some((t) => /印刷用PDF/.test(t)), "作り直した realpro には従来どおり載る");
  console.log("  ✓ 作り直し（refreshPlaybookIfStale）も site で分かれる");
}

// 4. 作り方の版を上げた（古い手順書は全部作り直す対象）
assert(PLAYBOOK_BUILD_V >= 15, "作り方の版が 15 以上（itandi の直しを既存の束に当てるため）");
console.log("  ✓ 作り方の版 " + PLAYBOOK_BUILD_V);

console.log("playbook-site-split.test OK");
