import { assertSchema } from "./validate.js";
import {
  decryptJson,
  encryptJson,
  signClaims,
  type PcnHeader,
  type PublicJwk,
} from "./crypto.js";
import { digestJson, loadBounds, PROTOCOL, randomId } from "./protocol.js";

export class ProtocolClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProtocolClientError";
  }
}

/** Options for a signed mutation. Reuse `operationId` to retry an action without repeating it. */
export type MutationOptions = {
  operationId?: string;
  /** Attempts after the first when the network fails or reports `unavailable`. Default 2. */
  retries?: number;
};

function newOperationId(): string {
  return randomId();
}

function isTransient(error: unknown): boolean {
  if (error instanceof ProtocolClientError) return error.code === "unavailable" || (error.status >= 500 && error.status !== 501);
  return error instanceof TypeError || (error instanceof Error && /fetch|network|ECONN|socket/i.test(error.message));
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type Clock = { now(): Date };

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

type FetchImpl = typeof fetch;

export type ClientOptions = {
  networkUrl: string;
  issuer?: string;
  fetchImpl?: FetchImpl;
  accessToken?: string;
  accountToken?: string;
  agentId?: string;
  signingKey?: CryptoKey;
  clock?: Clock;
};

type EnvelopeInput = {
  action: string;
  target: { type: string; id: string };
  payload: unknown;
  audience: string;
  permittedFields: string[];
  authorizationRef: string;
  permissionExpiresAt: string;
  options?: MutationOptions;
  stateVersion?: number;
  requestDigest?: string;
  offerDigest?: string;
};

export class DossyClient {
  readonly networkUrl: string;
  issuer: string;
  fetchImpl: FetchImpl;
  accessToken?: string;
  accountToken?: string;
  agentId?: string;
  signingKey?: CryptoKey;
  readonly clock: Clock;
  private accessTokenExpiresAt?: number;

  constructor(options: ClientOptions) {
    this.networkUrl = options.networkUrl.replace(/\/$/, "");
    this.issuer = options.issuer ?? this.networkUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.accessToken = options.accessToken;
    this.accountToken = options.accountToken;
    this.agentId = options.agentId;
    this.signingKey = options.signingKey;
    this.clock = options.clock ?? new SystemClock();
  }

  async discover(): Promise<Record<string, unknown>> {
    const body = await this.call("GET", "/.well-known/private-context-network", undefined, "none");
    if (typeof body.issuer === "string") this.issuer = body.issuer;
    return body;
  }

  /** Registers an agent signing key. Authorized by an account token the operator issued. */
  async registerAgent(publicJwk: PublicJwk): Promise<Record<string, unknown>> {
    return this.call("POST", "/v0.1/agents", { public_jwk: publicJwk }, "account");
  }

  async revokeAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.call("POST", `/v0.1/agents/${agentId}/revoke`, {}, "account");
  }

  async issueToken(agentId: string, signingKey: CryptoKey): Promise<string> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const assertion = await signClaims(signingKey, agentId, {
      iss: agentId,
      sub: agentId,
      aud: this.issuer,
      iat: now,
      exp: now + loadBounds().assertion_max_seconds,
      jti: randomId(),
    });
    const body = await this.call("POST", "/v0.1/oauth/token", {
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    }, "none");
    if (typeof body.access_token !== "string") throw new Error("Token response is missing access_token.");
    this.accessToken = body.access_token;
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 600;
    this.accessTokenExpiresAt = this.clock.now().getTime() + Math.max(0, lifetime - 30) * 1000;
    this.agentId = agentId;
    this.signingKey = signingKey;
    return body.access_token;
  }

  async listMarketplaces(): Promise<Record<string, unknown>> {
    return this.call("GET", "/v0.1/marketplaces", undefined, "agent");
  }

  async postRequest(document: unknown, authorizationRef = newOperationId(), options?: MutationOptions): Promise<Record<string, unknown>> {
    const doc = document as { marketplace_id: string; expires_at: string };
    return this.mutate("/v0.1/requests", {
      options,
      action: "post_request",
      target: { type: "marketplace", id: doc.marketplace_id },
      payload: document,
      audience: doc.marketplace_id,
      permittedFields: ["document"],
      authorizationRef,
      permissionExpiresAt: doc.expires_at,
    });
  }

  async listRequests(marketplaceId: string, cursor?: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ protocol: PROTOCOL });
    if (cursor) query.set("cursor", cursor);
    return this.call("GET", `/v0.1/marketplaces/${marketplaceId}/requests?${query}`, undefined, "agent");
  }

  async getRequest(requestId: string): Promise<Record<string, unknown>> {
    return this.call("GET", `/v0.1/requests/${requestId}`, undefined, "agent");
  }

  async submitOffer(
    requestId: string,
    payload: unknown,
    authorizationRef: string,
    permissionExpiresAt = (payload as { permission_expires_at: string }).permission_expires_at,
    options?: MutationOptions,
  ): Promise<Record<string, unknown>> {
    const declared = (payload as { declared_fields: string[] }).declared_fields;
    return this.mutate(`/v0.1/requests/${requestId}/offers`, {
      options,
      action: "submit_offer",
      target: { type: "request", id: requestId },
      payload,
      audience: requestId,
      permittedFields: declared,
      authorizationRef,
      permissionExpiresAt,
      requestDigest: (payload as { request_digest: string }).request_digest,
    });
  }

  async listOffers(requestId: string): Promise<Record<string, unknown>> {
    return this.call("GET", `/v0.1/requests/${requestId}/offers`, undefined, "agent");
  }

  async inbox(): Promise<Record<string, unknown>> {
    return this.call("GET", "/v0.1/inbox", undefined, "agent");
  }

  async acceptOffer(offerId: string, payload: unknown, authorizationRef: string, stateVersion: number, offerDigest: string, options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.1/offers/${offerId}/accept`, {
      options,
      action: "accept_offer",
      target: { type: "offer", id: offerId },
      payload,
      audience: offerId,
      permittedFields: ["connection"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
      stateVersion,
      offerDigest,
    });
  }

  async confirmConnection(connectionId: string, stateVersion: number, authorizationRef: string, options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.1/connections/${connectionId}/confirm`, {
      options,
      action: "confirm_connection",
      target: { type: "connection", id: connectionId },
      payload: {},
      audience: connectionId,
      permittedFields: ["connection"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
      stateVersion,
    });
  }

  async sendMessage(connectionId: string, payload: unknown, authorizationRef: string, stateVersion?: number, options?: MutationOptions): Promise<Record<string, unknown>> {
    const messageType = (payload as { message_type: string }).message_type;
    return this.mutate(`/v0.1/connections/${connectionId}/messages`, {
      options,
      action: "send_message",
      target: { type: "connection", id: connectionId },
      payload,
      audience: connectionId,
      permittedFields: [messageType],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
      stateVersion,
    });
  }

  async listMessages(connectionId: string): Promise<Record<string, unknown>> {
    return this.call("GET", `/v0.1/connections/${connectionId}/messages`, undefined, "agent");
  }

  async withdraw(resource: "requests" | "offers" | "connections", id: string, stateVersion: number | undefined, authorizationRef: string, options?: MutationOptions): Promise<Record<string, unknown>> {
    const type = resource === "requests" ? "request" : resource === "offers" ? "offer" : "connection";
    return this.mutate(`/v0.1/${resource}/${id}/withdraw`, {
      options,
      action: "withdraw",
      target: { type, id },
      payload: {},
      audience: id,
      permittedFields: ["withdraw"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
      stateVersion,
    });
  }

  async reputation(subject: string, requestId?: string): Promise<Record<string, unknown>> {
    const query = requestId ? `?request_id=${encodeURIComponent(requestId)}` : "";
    return this.call("GET", `/v0.1/reputation/${subject}${query}`, undefined, "agent");
  }

  async revokeAuthorization(ref: string, options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.1/authorizations/${ref}/revoke`, {
      options,
      action: "revoke_authorization",
      target: { type: "authorization", id: ref },
      payload: {},
      audience: ref,
      permittedFields: ["revoke"],
      authorizationRef: ref,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
    });
  }

  async reportAbuse(report: unknown, authorizationRef: string, options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate("/v0.1/reports", {
      options,
      action: "report_abuse",
      target: { type: "marketplace", id: "reports" },
      payload: report,
      audience: "reports",
      permittedFields: ["report"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
    });
  }

  async encryptOffer(input: {
    replyKey: PublicJwk;
    plaintext: unknown;
    origin: string;
    requestId: string;
    requestDigest: string;
    offerId: string;
    operationId: string;
    expiresAt: string;
  }): Promise<string> {
    const pcn: PcnHeader = {
      origin: input.origin,
      request_id: input.requestId,
      request_digest: input.requestDigest,
      offer_id: input.offerId,
      sender_role: "responder",
      message_type: "offer",
      operation_id: input.operationId,
      exp: input.expiresAt,
    };
    return encryptJson(input.replyKey, input.plaintext, pcn);
  }

  async openOffer(privateKey: CryptoKey, ciphertext: string, expected: PcnHeader, declaredFields: string[]): Promise<Record<string, unknown>> {
    const plaintext = await decryptJson<Record<string, unknown>>(privateKey, ciphertext, expected);
    assertSchema("https://dossy.dev/schemas/offer-plaintext.json", plaintext);
    const keys = Object.keys(plaintext);
    if (keys.some((key) => !declaredFields.includes(key)) || !declaredFields.includes("interest")) {
      throw new Error("Offer plaintext does not match the declared fields.");
    }
    return plaintext;
  }

  async encryptMessage(input: {
    peerKey: PublicJwk;
    plaintext: unknown;
    origin: string;
    requestId: string;
    requestDigest: string;
    connectionId: string;
    senderRole: "requester" | "responder";
    messageType: "clarification" | "handoff";
    operationId: string;
    expiresAt: string;
  }): Promise<string> {
    return encryptJson(input.peerKey, input.plaintext, {
      origin: input.origin,
      request_id: input.requestId,
      request_digest: input.requestDigest,
      connection_id: input.connectionId,
      sender_role: input.senderRole,
      message_type: input.messageType,
      operation_id: input.operationId,
      exp: input.expiresAt,
    });
  }

  /** Decrypts a connection message, checks its binding, and validates its schema. Strings stay data. */
  async openMessage(
    privateKey: CryptoKey,
    ciphertext: string,
    expected: PcnHeader,
  ): Promise<Record<string, unknown>> {
    const plaintext = await decryptJson<Record<string, unknown>>(privateKey, ciphertext, expected);
    assertSchema(`https://dossy.dev/schemas/message-${expected.message_type}.json`, plaintext);
    return plaintext;
  }

  /**
   * Signs and sends one action. The operation id is fixed for the whole call, so a retry after a
   * lost response returns the original result instead of repeating the action. Each attempt gets
   * a fresh short-lived signature over the same operation and payload.
   */
  private async mutate(path: string, input: EnvelopeInput): Promise<Record<string, unknown>> {
    if (!this.signingKey || !this.agentId) throw new Error("Client has no signing key.");
    const operationId = input.options?.operationId ?? newOperationId();
    const retries = input.options?.retries ?? 2;
    for (let attempt = 0; ; attempt += 1) {
      const now = Math.floor(this.clock.now().getTime() / 1000);
      const claims: Record<string, unknown> = {
        protocol: PROTOCOL,
        issuer: this.issuer,
        operation_id: operationId,
        agent_id: this.agentId,
        action: input.action,
        target: input.target,
        payload_digest: digestJson(input.payload),
        audience: input.audience,
        permitted_fields: input.permittedFields,
        permission_expires_at: input.permissionExpiresAt,
        authorization_mode: "human",
        authorization_ref: input.authorizationRef,
        iat: now,
        exp: now + loadBounds().envelope_max_seconds,
      };
      if (input.stateVersion !== undefined) claims.state_version = input.stateVersion;
      if (input.requestDigest !== undefined) claims.request_digest = input.requestDigest;
      if (input.offerDigest !== undefined) claims.offer_digest = input.offerDigest;
      const envelope = await signClaims(this.signingKey, this.agentId, claims);
      try {
        return await this.call("POST", path, { envelope, payload: input.payload }, "agent");
      } catch (error) {
        if (attempt >= retries || !isTransient(error)) throw error;
        const hinted = error instanceof ProtocolClientError && error.retryAfter ? error.retryAfter * 1000 : 0;
        await pause(Math.max(hinted, 250 * 2 ** attempt));
      }
    }
  }

  /**
   * Sends one HTTP call. Agent calls refresh an expired access token from the registered key,
   * and retry once if the network reports the token expired mid-flight.
   */
  protected async call(
    method: string,
    path: string,
    body: unknown,
    auth: "agent" | "account" | "none",
  ): Promise<Record<string, unknown>> {
    const canRefresh = auth === "agent" && this.signingKey !== undefined && this.agentId !== undefined;
    if (canRefresh && (!this.accessToken || (this.accessTokenExpiresAt !== undefined && this.clock.now().getTime() >= this.accessTokenExpiresAt))) {
      await this.issueToken(this.agentId as string, this.signingKey as CryptoKey);
    }
    try {
      return await this.send(method, path, body, auth);
    } catch (error) {
      if (!canRefresh || !(error instanceof ProtocolClientError) || error.code !== "unauthorized" || path === "/v0.1/oauth/token") throw error;
      await this.issueToken(this.agentId as string, this.signingKey as CryptoKey);
      return this.send(method, path, body, auth);
    }
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    auth: "agent" | "account" | "none",
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth === "agent" && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (auth === "account" && this.accountToken) headers.authorization = `Bearer ${this.accountToken}`;
    const response = await this.fetchImpl(`${this.networkUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      if (response.ok) throw new ProtocolClientError("invalid_schema", "Response was not JSON.", response.status);
    }
    if (!response.ok) {
      throw new ProtocolClientError(
        typeof parsed.error === "string" ? parsed.error : response.status >= 500 ? "unavailable" : "forbidden",
        typeof parsed.message === "string" ? parsed.message : "",
        response.status,
        typeof parsed.retry_after === "number" ? parsed.retry_after : undefined,
        parsed.retryable === true || response.status >= 500,
      );
    }
    return parsed;
  }
}
