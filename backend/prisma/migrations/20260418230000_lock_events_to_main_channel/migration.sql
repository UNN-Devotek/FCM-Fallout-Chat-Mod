-- Lock all FO76 event commands to the main General channel (and its sub-channels + server channel)
UPDATE chat_commands
SET allowed_channel_id = '00000000-0000-0000-0000-000000000001'
WHERE trigger IN (
  '/acp','/bob','/ct','/dc','/dg','/dpt','/en','/enc','/fr','/ftp',
  '/gm','/hots','/jb','/lb','/lits','/mj','/mw','/nw','/ovn','/pp',
  '/pte','/rr','/rs','/sa','/sas','/sbq','/sos','/tol','/tt','/tym','/uf'
);
