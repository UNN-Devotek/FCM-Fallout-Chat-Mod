/**
 * Shape the browser session user without changing the Discord identity stored
 * in the Express session. Chat messages and user-facing REST routes use the
 * internal user UUID; Discord operations continue to use `discordId`.
 */
export function buildAuthUserResponse(
  sessionUser: Record<string, unknown> & { id: string },
  databaseUser: { id: string } | null | undefined,
  fields: {
    fo76Name: string | null;
    discordDisplayName: string;
    avatarUrl: string | null;
  },
): Record<string, unknown> {
  return {
    ...sessionUser,
    id: databaseUser?.id ?? sessionUser.id,
    discordId: sessionUser.id,
    ...fields,
  };
}
