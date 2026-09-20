/**
 * Avatar URLs are stored raw (wasabi). They are rewritten per request to the image CDN of the
 * domain the app is talking to: the app calls us on the real API domain it got from
 * apiplayer.app/api/lookup for the endpoint + server the user picked (e.g. manko.fun +
 * Server 1 -> healertanker.com), and every such domain has an `image.<domain>` CDN host that
 * serves the same files. Nothing is configured here, so when lookup points an alias at a new
 * domain (GFW response) the images follow without touching this server.
 */
const WASABI_PREFIX = "https://s3.ap-northeast-1.wasabisys.com/swipesub";

function imageBase(hostHeader) {
  const host = String(hostHeader || "").toLowerCase().split(":")[0];
  // a real multi-label DNS name; not localhost, not an IP address
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^[\d.]+$/.test(host)) return null;
  return `https://image.${host}`;
}

function avatarUrl(url, hostHeader) {
  const base = imageBase(hostHeader);
  if (!url || !base || !url.startsWith(WASABI_PREFIX)) return url || "";
  return base + url.slice(WASABI_PREFIX.length);
}

module.exports = { avatarUrl, imageBase };
