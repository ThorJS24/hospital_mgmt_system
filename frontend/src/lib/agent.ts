/** Plain-language summary of a user-agent string (display only). */
export function describeAgent(ua: string): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Unknown device', mobile: false };
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /^node|supertest|curl/i.test(ua) ? 'Command line' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux|X11/.test(ua) ? 'Linux' : '';
  return { label: os ? `${browser} on ${os}` : browser, mobile: /Android|iPhone|iPad/.test(ua) };
}
