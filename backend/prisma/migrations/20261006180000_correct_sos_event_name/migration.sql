UPDATE chat_commands
   SET description = replace(description, 'Surface to Air', 'Swarm of Suitors'),
       response = replace(response, 'Surface to Air', 'Swarm of Suitors'),
       updated_at = NOW()
 WHERE trigger = '/sos'
   AND (description LIKE '%Surface to Air%' OR response LIKE '%Surface to Air%');
