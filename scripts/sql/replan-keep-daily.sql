-- #8 立て直し（CONDUCTOR_REPLAN・11/06 既定 on）の毎日の拾い上げ: 前の判断を使った番（digest.rp が keep:…）の数と、その番でスタッフ（竹内さんは writer で分ける）の一手と道が合ったか
-- 読むだけ・小さい（brain_decision_logs の直近1日・digest に rp がある行だけ）。作業員5
select (w.staff_first_at is not null) staffed,
  count(*) n,
  count(*) filter (where w.staff_first_at is not null and ((l.suggested_action is not null and coalesce(l.suggested_reply_mode,'') <> 'auto_reply') = (w.staff_aix is not null and w.staff_aix::text not in ('null','[]','{}')))) route_hit,
  count(*) filter (where (select m.staff_writer from messages m where m.conversation_id = l.conversation_id and m.sender <> 'customer' and m.created_at between w.staff_first_at - interval '1 second' and w.staff_first_at + interval '1 second' limit 1) = 'takeuchi') takeuchi
from brain_decision_logs l
left join line_watch_turns w on w.conversation_id = l.conversation_id and w.brain_analyzed_msg_ts = l.analyzed_msg_ts
where l.created_at > now() - interval '1 day' and l.digest->>'rp' like 'keep:%'
group by 1;
