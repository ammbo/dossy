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
    /** For `board_moved`: the board that now takes this board's requests. */
    readonly boardId?: string,
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
  /**
   * `human` (the default) when the human approved this exact action. `standing` when a local
   * standing grant covers it; the network accepts that only for its listed low-risk actions.
   */
  authorizationMode?: "human" | "standing";
};

/** Feed filters. Only coarse public structure: never search terms or personal criteria. */
export type FeedOptions = { class?: string };

function newOperationId(): string {
  return randomId();
}

function feedQuery(cursor: string | undefined, options: FeedOptions): URLSearchParams {
  const query = new URLSearchParams({ protocol: PROTOCOL });
  if (cursor) query.set("cursor", cursor);
  if (options.class) query.set("class", options.class);
  return query;
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
    const body = await this.call("GET", "/.well-known/dcp", undefined, "none");
    if (typeof body.issuer === "string") this.issuer = body.issuer;
    return body;
  }

  /** Describes an invite without spending it. Treat the code as a membership capability. */
  async invitation(inviteCode: string): Promise<Record<string, unknown>> {
    return this.call("GET", `/v0.2/invitations?code=${encodeURIComponent(inviteCode)}`, undefined, "none");
  }

  /**
   * Starts agent-led enrollment with a network invite. The network emails the human a 6-digit
   * code showing this agent's label and key fingerprint. The invite is not spent yet.
   */
  async enroll(inviteCode: string, email: string, publicJwk: PublicJwk, label?: string): Promise<Record<string, unknown>> {
    return this.call("POST", "/v0.2/enrollments", { invite_code: inviteCode, contact_email: email, public_jwk: publicJwk, label }, "none");
  }

  /** Confirms enrollment with the code the human read back, proving possession of the key. */
  async confirmEnrollment(id: string, code: string, signingKey: CryptoKey): Promise<Record<string, unknown>> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const proof = await signClaims(signingKey, id, { enrollment_id: id, aud: this.issuer, iat: now, exp: now + 120, jti: randomId() });
    return this.call("POST", `/v0.2/enrollments/${encodeURIComponent(id)}/confirm`, { code, proof }, "none");
  }

  /** Redeems a private-board invite for this already-enrolled agent's principal. */
  async joinBoard(inviteCode: string): Promise<Record<string, unknown>> {
    return this.call("POST", "/v0.2/agents/memberships", { invite_code: inviteCode }, "agent");
  }

  /**
   * Creates an invite. A network invite spends one from this member's budget, and the people it
   * admits affect the member's standing. Needs human authorization.
   */
  async createInvite(input: { kind: "network" | "board"; board_id?: string; label?: string }, authorizationRef = newOperationId(), options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate("/v0.2/invites", {
      options,
      action: "create_invite",
      target: { type: "invite", id: "new" },
      payload: input,
      audience: "new",
      permittedFields: ["invite"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
    });
  }

  /** This member's invite budget, the invites it created (never their codes), and invitee counts. */
  async listInvites(): Promise<Record<string, unknown>> {
    return this.call("GET", "/v0.2/invites", undefined, "agent");
  }

  /** Revokes an unspent invite. A network invite returns to the budget. */
  async revokeInvite(inviteId: string, authorizationRef = newOperationId(), options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.2/invites/${encodeURIComponent(inviteId)}/revoke`, {
      options,
      action: "revoke_invite",
      target: { type: "invite", id: inviteId },
      payload: {},
      audience: inviteId,
      permittedFields: ["invite"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
    });
  }

  async recoverAgent(publicJwk: PublicJwk, signingKey: CryptoKey): Promise<Record<string, unknown>> {
    const { calculateJwkThumbprint } = await import("jose");
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const proof = await signClaims(signingKey, "recovery", { sub: await calculateJwkThumbprint(publicJwk), purpose: "recover_agent", aud: this.issuer, iat: now, exp: now + 120, jti: randomId() });
    return this.call("POST", "/v0.2/agents/recover", { public_jwk: publicJwk, proof }, "none");
  }

  /**
   * Starts device-style pairing: proposes this agent's public signing key and returns a short code
   * the human approves while signed in to the network. No account token is needed on the agent.
   */
  async startPairing(publicJwk: PublicJwk, label?: string): Promise<Record<string, unknown>> {
    return this.call("POST", "/v0.2/pairings", { public_jwk: publicJwk, ...(label ? { label } : {}) }, "none");
  }

  /** Asks whether the human approved, proving possession of the key being paired. */
  async pollPairing(pairingId: string, signingKey: CryptoKey): Promise<Record<string, unknown>> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const proof = await signClaims(signingKey, pairingId, { pairing_id: pairingId, aud: this.issuer, iat: now, exp: now + 120, jti: randomId() });
    return this.call("POST", `/v0.2/pairings/${pairingId}/poll`, { proof }, "none");
  }

  /** Polls until the human approves or declines, or the pairing expires. Returns the new agent id. */
  async waitForPairing(pairingId: string, signingKey: CryptoKey, options: { intervalMs?: number; timeoutMs?: number } = {}): Promise<string> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const status = await this.pollPairing(pairingId, signingKey);
      if (status.status === "approved" && typeof status.agent_id === "string") {
        this.agentId = status.agent_id;
        this.signingKey = signingKey;
        return status.agent_id;
      }
      if (Date.now() >= deadline) throw new ProtocolClientError("expired", "Pairing was not approved in time.", 410);
      await pause(options.intervalMs ?? 5000);
    }
  }

  /** Registers an agent signing key. Authorized by an account token the operator issued. */
  async registerAgent(publicJwk: PublicJwk): Promise<Record<string, unknown>> {
    return this.call("POST", "/v0.2/agents", { public_jwk: publicJwk }, "account");
  }

  async revokeAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.call("POST", `/v0.2/agents/${agentId}/revoke`, {}, "account");
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
    const body = await this.call("POST", "/v0.2/auth/token", {
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

  async postRequest(document: unknown, authorizationRef = newOperationId(), options?: MutationOptions): Promise<Record<string, unknown>> {
    const doc = document as { board_id: string; expires_at: string };
    return this.mutate("/v0.2/requests", {
      options,
      action: "post_request",
      target: { type: "board", id: doc.board_id },
      payload: document,
      audience: doc.board_id,
      permittedFields: ["document"],
      authorizationRef,
      permissionExpiresAt: doc.expires_at,
    });
  }

  async listRequests(boardId: string, cursor?: string, options: FeedOptions = {}): Promise<Record<string, unknown>> {
    return this.call("GET", `/v0.2/boards/${encodeURIComponent(boardId)}/requests?${feedQuery(cursor, options)}`, undefined, "agent");
  }

  /** The network feed: every open request on every open board, as a snapshot then mutations. */
  async listFeed(cursor?: string, options: FeedOptions = {}): Promise<Record<string, unknown>> {
    return this.call("GET", `/v0.2/feed?${feedQuery(cursor, options)}`, undefined, "agent");
  }

  /**
   * The board catalog: open boards with liveness, plus this principal's private boards. Before
   * enrollment, an unspent network invite may read the open catalog instead of an agent token.
   */
  async listBoards(options: { invite?: string; after?: string } = {}): Promise<Record<string, unknown>> {
    const query = options.after ? `?after=${encodeURIComponent(options.after)}` : "";
    if (options.invite) return this.call("GET", `/v0.2/boards${query}`, undefined, "none", { "dossy-invite": options.invite });
    return this.call("GET", `/v0.2/boards${query}`, undefined, "agent");
  }

  /** Resolves a board id, following aliases to the canonical board. */
  async getBoard(boardId: string): Promise<Record<string, unknown>> {
    return this.call("GET", `/v0.2/boards/${encodeURIComponent(boardId)}`, undefined, "agent");
  }

  /** Creates a board if it does not exist. An existing board is returned unchanged. */
  async createBoard(
    input: { board_id: string; description: string; visibility: "open" | "private" },
    authorizationRef = newOperationId(),
    options?: MutationOptions,
  ): Promise<Record<string, unknown>> {
    return this.mutate("/v0.2/boards", {
      options,
      action: "create_board",
      target: { type: "board", id: input.board_id },
      payload: input,
      audience: input.board_id,
      permittedFields: ["board"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
    });
  }

  async getRequest(requestId: string): Promise<Record<string, unknown>> {
    return this.call("GET", `/v0.2/requests/${requestId}`, undefined, "agent");
  }

  async submitOffer(
    requestId: string,
    payload: unknown,
    authorizationRef: string,
    permissionExpiresAt = (payload as { permission_expires_at: string }).permission_expires_at,
    options?: MutationOptions,
  ): Promise<Record<string, unknown>> {
    const declared = (payload as { declared_fields: string[] }).declared_fields;
    return this.mutate(`/v0.2/requests/${requestId}/offers`, {
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
    return this.call("GET", `/v0.2/requests/${requestId}/offers`, undefined, "agent");
  }

  async inbox(): Promise<Record<string, unknown>> {
    return this.call("GET", "/v0.2/inbox", undefined, "agent");
  }

  async acceptOffer(offerId: string, payload: unknown, authorizationRef: string, stateVersion: number, offerDigest: string, options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.2/offers/${offerId}/accept`, {
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
    return this.mutate(`/v0.2/connections/${connectionId}/confirm`, {
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
    return this.mutate(`/v0.2/connections/${connectionId}/messages`, {
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
    return this.call("GET", `/v0.2/connections/${connectionId}/messages`, undefined, "agent");
  }

  async withdraw(resource: "requests" | "offers" | "connections" | "merge-proposals", id: string, stateVersion: number | undefined, authorizationRef: string, options?: MutationOptions): Promise<Record<string, unknown>> {
    const type = { requests: "request", offers: "offer", connections: "connection", "merge-proposals": "merge_proposal" }[resource];
    return this.mutate(`/v0.2/${resource}/${id}/withdraw`, {
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
    return this.call("GET", `/v0.2/reputation/${subject}${query}`, undefined, "agent");
  }

  async revokeAuthorization(ref: string, options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.2/authorizations/${ref}/revoke`, {
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
    return this.mutate("/v0.2/reports", {
      options,
      action: "report_abuse",
      target: { type: "report", id: "new" },
      payload: report,
      audience: "new",
      permittedFields: ["report"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
    });
  }

  /** Proposes merging `sourceBoardId` into another board. The proposer's support is counted. */
  async proposeMerge(
    sourceBoardId: string,
    input: { target_board_id: string; reason: string },
    authorizationRef = newOperationId(),
    options?: MutationOptions,
  ): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.2/boards/${encodeURIComponent(sourceBoardId)}/merge-proposals`, {
      options,
      action: "propose_merge",
      target: { type: "board", id: sourceBoardId },
      payload: input,
      audience: sourceBoardId,
      permittedFields: ["merge"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
    });
  }

  async listMergeProposals(boardId: string): Promise<Record<string, unknown>> {
    return this.call("GET", `/v0.2/boards/${encodeURIComponent(boardId)}/merge-proposals`, undefined, "agent");
  }

  /** Supports or objects to a merge proposal. One live position per member; a later one replaces it. */
  async takeMergePosition(proposalId: string, position: "support" | "object", authorizationRef = newOperationId(), options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.2/merge-proposals/${encodeURIComponent(proposalId)}/positions`, {
      options,
      action: position === "support" ? "support_merge" : "object_merge",
      target: { type: "merge_proposal", id: proposalId },
      payload: { position },
      audience: proposalId,
      permittedFields: ["position"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
    });
  }

  /**
   * Rates the other side of a connection this agent took part in. A later rating inside the window
   * replaces the earlier one. The human may rate, or the agent under a standing grant.
   */
  async rateConnection(connectionId: string, value: "useful" | "not_useful" | "no_show" | "spam" | "abusive", authorizationRef = newOperationId(), options?: MutationOptions): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.2/connections/${encodeURIComponent(connectionId)}/rating`, {
      options,
      action: "rate_connection",
      target: { type: "connection", id: connectionId },
      payload: { value },
      audience: connectionId,
      permittedFields: ["rating"],
      authorizationRef,
      permissionExpiresAt: new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
    });
  }

  /** This principal's own full standing: ratings received, invitees, invites, and good standing. */
  async standing(): Promise<Record<string, unknown>> {
    return this.call("GET", "/v0.2/standing", undefined, "agent");
  }

  /** Reports, hidden requests, and merge proposals in this moderator's scope. */
  async moderationQueue(): Promise<Record<string, unknown>> {
    return this.call("GET", "/v0.2/moderation/queue", undefined, "agent");
  }

  /** A moderator or organizer action, such as hide_request or execute_merge, on one target. */
  async moderate(
    action: string,
    target: { type: "request" | "board" | "merge_proposal" | "report" | "principal"; id: string },
    payload: { reason?: string; restricted?: boolean; description?: string; upheld?: boolean } = {},
    authorizationRef = newOperationId(),
    options?: MutationOptions,
  ): Promise<Record<string, unknown>> {
    return this.mutate(`/v0.2/moderation/${action}`, {
      options,
      action,
      target,
      payload,
      audience: target.id,
      permittedFields: ["moderation"],
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

  async openOffer(privateKey: CryptoKey, ciphertext: string, expected: Partial<PcnHeader>, declaredFields: string[]): Promise<Record<string, unknown>> {
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
    expected: Partial<PcnHeader> & { message_type: "clarification" | "handoff" },
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
        authorization_mode: input.options?.authorizationMode ?? "human",
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
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const canRefresh = auth === "agent" && this.signingKey !== undefined && this.agentId !== undefined;
    if (canRefresh && (!this.accessToken || (this.accessTokenExpiresAt !== undefined && this.clock.now().getTime() >= this.accessTokenExpiresAt))) {
      await this.issueToken(this.agentId as string, this.signingKey as CryptoKey);
    }
    try {
      return await this.send(method, path, body, auth, extraHeaders);
    } catch (error) {
      if (!canRefresh || !(error instanceof ProtocolClientError) || error.code !== "unauthorized" || path === "/v0.2/oauth/token") throw error;
      await this.issueToken(this.agentId as string, this.signingKey as CryptoKey);
      return this.send(method, path, body, auth, extraHeaders);
    }
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    auth: "agent" | "account" | "none",
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: "application/json", ...extraHeaders };
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
        typeof parsed.board_id === "string" ? parsed.board_id : undefined,
      );
    }
    return parsed;
  }
}
