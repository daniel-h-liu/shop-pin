// eBay's Browse API requires an OAuth 2.0 client-credentials application
// token — the App ID alone (as previously used directly as a bearer token)
// is not a valid credential. This exchanges App ID + Cert ID (client secret)
// for a short-lived access token and caches it in-process until it's close
// to expiry, matching the module-level cached-client pattern already used
// for the vision client.
let cachedToken: { value: string; expiresAt: number } | null = null;

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SCOPE = "https://api.ebay.com/oauth/api_scope";
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

type TokenResponse = { access_token: string; expires_in: number };

/** Returns a valid eBay application access token, or null if not configured. */
export async function getEbayAppToken(): Promise<string | null> {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + EXPIRY_SAFETY_MARGIN_MS) {
    return cachedToken.value;
  }

  const credentials = Buffer.from(`${appId}:${certId}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
  });
  if (!res.ok) return null;

  const data = (await res.json()) as TokenResponse;
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.value;
}
