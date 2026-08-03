import type { FastifyReply, FastifyRequest } from "fastify";

export interface AuthOptions {
  token?: string;
}

/** MVP bearer-token gate. Disable by passing `auth: false` to buildServer. */
export function authHook(request: FastifyRequest, reply: FastifyReply, options: AuthOptions): void {
  const expected = options.token ?? process.env.AUTH_TOKEN ?? "dev-token";
  const header = request.headers.authorization;
  if (header !== `Bearer ${expected}`) {
    void reply.code(401).send({ error: "unauthorized" });
  }
}
