import { z } from "zod";
export class RequestContext extends Map<string, unknown> {}
export function createTool<T extends { inputSchema?: z.ZodType; execute: (...args: any[]) => any }>(tool: T): T { return tool; }
