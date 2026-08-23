DELETE FROM thread_labels;

INSERT INTO thread_labels (account_id,label_id,thread_id,latest_at)
SELECT m.account_id,
       CASE
         WHEN mfs.is_trashed THEN 'TRASH'
         WHEN mfs.is_spammed THEN 'SPAM'
         ELSE ml.label_id
       END,
       m.thread_id,
       MAX(m.sent_at)
FROM messages m
JOIN message_labels ml
  ON ml.account_id=m.account_id AND ml.message_id=m.id
JOIN (
  SELECT m2.account_id AS account_id,
         m2.id AS message_id,
         MAX(ml2.label_id='TRASH') AS is_trashed,
         MAX(ml2.label_id='SPAM') AS is_spammed
  FROM messages m2
  LEFT JOIN message_labels ml2
    ON ml2.account_id=m2.account_id AND ml2.message_id=m2.id
  GROUP BY m2.account_id, m2.id
) mfs
  ON mfs.account_id=m.account_id AND mfs.message_id=m.id
GROUP BY m.account_id, m.thread_id, 2;
