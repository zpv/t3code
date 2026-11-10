// @effect-diagnostics globalFetch:off extendsNativeError:off -- The bridge owns its HTTP client.
export class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function t3Request(
  origin: string,
  headers: Record<string, string>,
  pathname: string,
  options: RequestInit = {},
) {
  const res = await fetch(origin + pathname, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!res.ok)
    throw new HttpFailure(res.status, `T3 ${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}
