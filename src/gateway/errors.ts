import type { FastifyReply } from "fastify";

export type GatewayErrorCode =
  | "unauthorized"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "conflict"
  | "internal";

export interface GatewayError {
  code: GatewayErrorCode;
  message: string;
  /** True when the client may retry the same request later. */
  retriable: boolean;
}

const STATUS: Record<GatewayErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  bad_request: 400,
  rate_limited: 429,
  conflict: 409,
  internal: 500
};

const RETRIABLE: Record<GatewayErrorCode, boolean> = {
  unauthorized: false,
  not_found: false,
  bad_request: false,
  rate_limited: true,
  conflict: true,
  internal: true
};

/** Standardized error body on every route (phase 10): { code, message, retriable }. */
export function sendError(reply: FastifyReply, code: GatewayErrorCode, message: string): FastifyReply {
  const body: GatewayError & { error: string } = {
    code,
    message,
    retriable: RETRIABLE[code],
    // legacy field kept for older clients
    error: message
  };
  return reply.code(STATUS[code]).send(body);
}

export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
