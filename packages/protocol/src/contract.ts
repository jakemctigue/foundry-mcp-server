import type { z } from "zod";

export interface ToolContract<
  InputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
}

export interface ResourceContract {
  uriPattern: string;
  description: string;
}

export interface PromptContract<ArgsSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  argsSchema: ArgsSchema;
}

export function defineTool<InputSchema extends z.ZodTypeAny, OutputSchema extends z.ZodTypeAny>(
  contract: ToolContract<InputSchema, OutputSchema>,
): ToolContract<InputSchema, OutputSchema> {
  return contract;
}
