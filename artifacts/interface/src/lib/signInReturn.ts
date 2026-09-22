/**
 * Where a sign-in goes back to: a path on this origin, or the stock list.
 *
 * The value arrives in a query string anybody can write, so it is held to a
 * path that starts with one slash. `//host` and a backslash are how a path
 * becomes another origin in a browser, and a sign-in page is the one place an
 * open redirect would be worth something to somebody.
 */
export function safeNextPathV1(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/stocks';
  return raw;
}
