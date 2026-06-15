/**
 * PARTIES_ENABLED — master switch for the Party chat system (user-created
 * community rooms, invite flow, realtime party:send/history WS frames, reap
 * sweep).
 *
 * Default ON everywhere (incl. production), overridable via the PARTIES_ENABLED
 * env var: set `PARTIES_ENABLED=false` (e.g. in Dokploy) to disable without a
 * code change; unset (or any non-"false" value) keeps it on. When false: party
 * routes return 404, WS party frames are rejected, and the frontend hides the
 * Party main tab.
 */
export const PARTIES_ENABLED = process.env.PARTIES_ENABLED
  ? process.env.PARTIES_ENABLED.toLowerCase() === 'true'
  : true;
