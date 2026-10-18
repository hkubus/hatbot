// Its own module so schedule.ts and watch.ts can use it: index.ts re-exports them.

/** A bot's id: made from its first name, and fixed after that. */
export const BOT_ID = /^[a-z][a-z0-9-]{0,30}$/;
