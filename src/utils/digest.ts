import crypto from "crypto";

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

function parseWwwAuthenticate(header: string): DigestChallenge {
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    params[m[1]] = m[2];
  }
  if (!params.realm || !params.nonce) {
    throw new Error("Invalid WWW-Authenticate header: missing realm or nonce");
  }
  return {
    realm: params.realm,
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: params.algorithm ?? "MD5",
  };
}

function md5(data: string): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

export function buildDigestHeader(
  method: string,
  uri: string,
  username: string,
  password: string,
  wwwAuthenticate: string
): string {
  const challenge = parseWwwAuthenticate(wwwAuthenticate);
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  let response: string;
  let cnonce: string | undefined;
  let nc: string | undefined;

  if (challenge.qop === "auth") {
    cnonce = crypto.randomBytes(8).toString("hex");
    nc = "00000001";
    response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`);
  } else {
    response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
  }

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (challenge.qop) parts.push(`qop=${challenge.qop}`);
  if (cnonce) parts.push(`cnonce="${cnonce}"`);
  if (nc) parts.push(`nc=${nc}`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);

  return `Digest ${parts.join(", ")}`;
}
