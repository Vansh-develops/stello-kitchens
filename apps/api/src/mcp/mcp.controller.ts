import { All, Controller, ForbiddenException, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { AuthUser } from "@stello/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CurrentUser } from "../common/decorators";
import { ApiKeyAccess } from "../common/api-key-access";
import { buildMcpServer } from "./mcp.tools";
import { PublicApiService } from "./public-api.service";

/**
 * MCP server over Streamable HTTP (stateless: a fresh server + transport per
 * POST, JSON responses, no session id). Authenticated by a tenant API key
 * (`Authorization: Bearer stk_…`); the tool list is filtered to what the key's
 * permissions allow, and every tool re-checks its permission when called.
 */
@ApiKeyAccess()
@Controller("mcp")
export class McpController {
  constructor(private readonly api: PublicApiService) {}

  @Post()
  async handle(@CurrentUser() principal: AuthUser, @Req() req: Request, @Res() res: Response) {
    if (!principal.apiKeyId) throw new ForbiddenException("The MCP endpoint is for API keys");
    const server: McpServer = buildMcpServer(this.api, principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** Stateless server: no SSE stream (GET) or session teardown (DELETE). */
  @All()
  notAllowed(@Res() res: Response) {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  }
}
