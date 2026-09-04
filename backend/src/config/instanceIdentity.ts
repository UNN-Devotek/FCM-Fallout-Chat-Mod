import { v4 as uuidv4 } from 'uuid';

/** One process identity shared by the web broadcast and native relay paths. */
export const INSTANCE_ID = uuidv4();
