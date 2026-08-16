import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "./errors";

export interface AuthOptions {
  token?: string;
}

/** MVP bearer-token gate. Disable by passing `auth: false` to buildServer. */
export function authHook(request: FastifyRequest, reply: FastifyReply, options: AuthOptions): void {
  const expected = options.token ?? process.env.AUTH_TOKEN ?? "dev-token";
  const header = request.headers.authorization;
  if (header !== `Bearer ${expected}`) {
    void sendError(reply, "unauthorized", "unauthorized");
  }
}
