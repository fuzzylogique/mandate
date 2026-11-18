// The dashboard can be opened locally (WEB_ORIGIN) and through a public tunnel or
// host (PUBLIC_WEB_ORIGIN). Browser writes are only accepted from these origins.
export function webOrigins(env: Record<string, string | undefined> = process.env): string[] {
  return [env.WEB_ORIGIN ?? "http://localhost:4020", env.PUBLIC_WEB_ORIGIN]
    .filter((origin): origin is string => Boolean(origin))
    .map(origin => origin.replace(/\/$/, ""));
}
