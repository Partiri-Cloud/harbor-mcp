/**
 * @fileoverview Strict host / URL classification for SSRF defense and
 * OAuth-redirect safety.
 *
 * Every entry point that takes a URL parses it with the WHATWG URL parser and
 * operates on the parsed `hostname`, so userinfo
 * (`"https://trusted@10.0.0.1"`), ports, and IPv6 brackets cannot smuggle a
 * different effective host. The URL parser also normalizes numeric IPv4
 * encodings (decimal / hex / octal) to dotted-decimal; a bare-number host is
 * additionally rejected as a safety net.
 *
 * @remarks LIMITATION: these are LITERAL checks only — they do NOT resolve
 * DNS. A public hostname that resolves to a private IP (DNS rebinding,
 * metadata.* aliases) must additionally be guarded where the outbound
 * request is made, by resolving the host and checking the resolved IP. That
 * authoritative guard lives in the cloud/api probe endpoints; this module is
 * the in-process, defense-in-depth layer.
 */

/**
 * Normalizes a hostname for comparison: trims whitespace, lowercases, strips
 * IPv6 brackets, and strips a single trailing dot (FQDN form).
 *
 * @param hostname - The raw hostname to normalize.
 * @returns The normalized hostname.
 */
export function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '') // strip IPv6 brackets
    .replace(/\.$/, ''); // strip a single trailing dot (FQDN form)
}

/**
 * Parses a dotted-decimal IPv4 address into its four octets.
 *
 * @param host - The candidate host string.
 * @returns The four octets, or `null` if `host` is not a valid dotted-decimal
 * IPv4 address.
 */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1, 5).map((s) => Number(s));
  if (octets.some((n) => n > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Determines whether an IPv4 address (given as octets) is private, loopback,
 * link-local, CGNAT, or reserved/multicast.
 *
 * @param octets - The four IPv4 octets, as returned by {@link parseIpv4}.
 * @returns `true` if the address falls in a private/special range.
 */
function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0+ multicast / reserved
  return false;
}

/**
 * Determines whether a normalized IPv6 host literal is loopback, unspecified,
 * link-local, site-local, unique-local, multicast, or an IPv4-mapped address
 * whose embedded IPv4 is itself private.
 *
 * @param host - The normalized IPv6 host literal (as produced by the WHATWG
 * URL parser).
 * @returns `true` if the address falls in a private/special range.
 */
function isPrivateIpv6(host: string): boolean {
  if (host === '::1') return true; // loopback
  if (host === '::') return true; // unspecified
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  if (/^fe[c-f]/.test(host)) return true; // fec0::/10 site-local (deprecated)
  if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local
  if (/^ff/.test(host)) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d). The WHATWG URL parser normalizes this to the
  // hex form (::ffff:7f00:1), so match both and classify by the embedded IPv4 —
  // a mapped *public* address (e.g. ::ffff:8.8.8.8) stays public.
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]);
    return v4 ? isPrivateIpv4(v4) : true;
  }
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  return false;
}

/**
 * Hostnames that alias cloud-metadata services (they resolve to link-local
 * IPs).
 */
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog']);

/**
 * True for an IPv4/IPv6 loopback address or `localhost` — a redirect delivered
 * here lands on the user's own machine, so it is safe as an OAuth redirect.
 *
 * @param hostname - The hostname to classify.
 * @returns `true` if `hostname` is loopback or `localhost`.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (h === 'localhost') return true;
  if (h === '::1') return true;
  const v4 = parseIpv4(h);
  return v4 ? v4[0] === 127 : false;
}

/**
 * True if `hostname` is a private, loopback, link-local, metadata, or otherwise
 * non-public literal — i.e. an unsafe outbound (SSRF) target. A plain DNS name
 * returns false here: resolving it is the caller-of-last-resort's job.
 *
 * @param hostname - The hostname to classify.
 * @returns `true` if `hostname` is a private/special literal.
 */
export function isPrivateOrSpecialHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (!h) return true;
  if (h === 'localhost') return true;
  if (METADATA_HOSTS.has(h)) return true;
  // A bare number / 0x-hex "host" is never a legitimate public name — it is an
  // encoded IP that should have been normalized; reject it defensively.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return true;
  const v4 = parseIpv4(h);
  if (v4) return isPrivateIpv4(v4);
  if (h.includes(':')) return isPrivateIpv6(h);
  return false;
}

/**
 * True if `urlStr` is an http(s) URL whose host is a public literal. The
 * defense-in-depth SSRF gate applied to caller-supplied probe URLs.
 *
 * @param urlStr - The URL string to validate.
 * @returns `true` if `urlStr` parses as http(s) with a public hostname.
 */
export function isPublicHttpUrl(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!u.hostname) return false;
  return !isPrivateOrSpecialHost(u.hostname);
}

/**
 * True if `uriStr` is a safe OAuth redirect target:
 *   - loopback (http or https, any port) — delivered to the user's own machine, or
 *   - https to a host in `allowedHttpsHosts`.
 * Everything else — notably arbitrary external hosts — is rejected, which is
 * what stops a registered client from receiving another user's minted code.
 *
 * @param uriStr - The candidate redirect URI.
 * @param allowedHttpsHosts - Hosts permitted for https (non-loopback)
 * redirects.
 * @returns `true` if `uriStr` is a safe redirect target.
 */
export function isAllowedRedirectUri(
  uriStr: string,
  allowedHttpsHosts: ReadonlySet<string>,
): boolean {
  let u: URL;
  try {
    u = new URL(uriStr);
  } catch {
    return false;
  }
  const host = normalizeHost(u.hostname);
  if (
    (u.protocol === 'http:' || u.protocol === 'https:') &&
    isLoopbackHost(host)
  ) {
    return true;
  }
  return u.protocol === 'https:' && allowedHttpsHosts.has(host);
}
