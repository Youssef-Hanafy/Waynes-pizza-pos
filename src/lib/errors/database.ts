/**
 * Postgres error codes our own functions raise on purpose. Each one carries a message
 * written for the person looking at the screen, so it is safe to repeat verbatim.
 *
 * Everything else — a missing relation, a bad cast, a constraint name — is internal
 * plumbing. Repeating it tells whoever is standing at the counter how the database is
 * put together, so it is replaced with a fallback sentence.
 *
 * Deciding this by looking for words in the message does not work: our table and column
 * names are made of the same vocabulary as our messages ("register", "refund", "cash",
 * "driver"), so an internal error that quotes a relation name walks straight through a
 * word list. The code is the only reliable signal for whether a human wrote the message.
 */
export const spokenDatabaseCodes = new Set(["22023", "40001", "42501", "P0001", "P0002"]);

export function spokenDatabaseMessage(error: { code?: string; message: string }, fallback: string) {
  return spokenDatabaseCodes.has(error.code ?? "") ? error.message : fallback;
}
