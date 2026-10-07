import { importJWK } from "jose";
import { randomBytes } from "node:crypto";
import {
  DossyClient,
  type PublicJwk,
} from "@dossy/sdk";

export const MCP_PROTOCOL = "2026-07-28";

export type BridgeSecret = {
  network_url: string;
  issuer?: string;
  agent_id: string;
  account_token?: string;
  now?: string;
  signing_jwk: PublicJwk & { d: string };
  encryption_jwk: PublicJwk & { d: string };
};

const TOOLS = [
  "discover_network",
  "list_marketplaces",
  "post_request",
  "list_requests",
  "get_request",
  "submit_offer",
  "list_offers",
  "get_inbox",
  "accept_offer",
  "confirm_connection",
  "send_message",
  "list_messages",
  "withdraw",
  "get_reputation",
  "revoke_authorization",
  "register_agent",
  "revoke_agent",
  "report_abuse",
] as const;

export function toolDefinitions() {
  return TOOLS.map((name) => ({
    name,
    description: `${name} on the configured private-context network. Private keys stay in the local secret file.`,
    inputSchema: { type: "object", additionalProperties: true },
  }));
}

export function rejectSecretArguments(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(rejectSecretArguments);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "d" || key === "private_jwk" || key === "signing_jwk" || key === "encryption_jwk") {
      throw new Error("Private keys are read from the local secret file, not tool arguments.");
    }
    rejectSecretArguments(child);
  }
}

export async function clientFromSecret(secret: BridgeSecret): Promise<{ client: DossyClient; encryptionPrivate: CryptoKey; encryptionPublic: PublicJwk }> {
  const signingKey = (await importJWK(secret.signing_jwk, "ES256")) as CryptoKey;
  const encryptionPrivate = (await importJWK(secret.encryption_jwk, "ECDH-ES")) as CryptoKey;
  const { d: _private, ...encryptionPublic } = secret.encryption_jwk;
  void _private;
  const client = new DossyClient({
    networkUrl: secret.network_url,
    issuer: secret.issuer,
    agentId: secret.agent_id,
    signingKey,
    accountToken: secret.account_token,
    clock: secret.now ? { now: () => new Date(secret.now as string) } : undefined,
  });
  await client.discover();
  await client.issueToken(secret.agent_id, signingKey);
  return { client, encryptionPrivate, encryptionPublic };
}

export async function callTool(secret: BridgeSecret, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  rejectSecretArguments(args);
  const { client, encryptionPublic } = await clientFromSecret(secret);
  switch (name) {
    case "discover_network":
      return client.discover();
    case "list_marketplaces":
      return client.listMarketplaces();
    case "post_request": {
      const document = { ...(args.document as Record<string, unknown>), reply_key: encryptionPublic };
      return client.postRequest(document, String(args.authorization_ref ?? randomBytes(16).toString("base64url")));
    }
    case "list_requests":
      return client.listRequests(String(args.marketplace_id), args.cursor ? String(args.cursor) : undefined);
    case "get_request":
      return client.getRequest(String(args.request_id));
    case "submit_offer":
      return client.submitOffer(String(args.request_id), args.payload, String(args.authorization_ref), String(args.permission_expires_at));
    case "list_offers":
      return client.listOffers(String(args.request_id));
    case "get_inbox":
      return client.inbox();
    case "accept_offer":
      return client.acceptOffer(String(args.offer_id), args.payload, String(args.authorization_ref), Number(args.state_version), String(args.offer_digest));
    case "confirm_connection":
      return client.confirmConnection(String(args.connection_id), Number(args.state_version), String(args.authorization_ref));
    case "send_message":
      return client.sendMessage(String(args.connection_id), args.payload, String(args.authorization_ref), Number(args.state_version ?? 1));
    case "list_messages":
      return client.listMessages(String(args.connection_id));
    case "withdraw":
      return client.withdraw(args.resource as "requests" | "offers" | "connections", String(args.id), Number(args.state_version), String(args.authorization_ref));
    case "get_reputation":
      return client.reputation(String(args.subject), args.request_id ? String(args.request_id) : undefined);
    case "revoke_authorization":
      return client.revokeAuthorization(String(args.authorization_ref));
    case "register_agent":
      return client.registerAgent(args.public_jwk as PublicJwk);
    case "revoke_agent":
      return client.revokeAgent(String(args.agent_id));
    case "report_abuse":
      return client.reportAbuse(args.report, String(args.authorization_ref));
    default:
      throw new Error(`Unknown tool ${name}.`);
  }
}
