-- Change event commands from actionType 'message' (bot post) to 'announce' (posts as the triggering user)
UPDATE chat_commands
SET action_type = 'announce'
WHERE trigger IN (
  '/acp','/bob','/ct','/dc','/dg','/dpt','/en','/enc','/fr','/ftp',
  '/gm','/hots','/jb','/lb','/lits','/mj','/mw','/nw','/ovn','/pp',
  '/pte','/rr','/rs','/sa','/sas','/sbq','/sos','/tol','/tt','/tym','/uf'
);
