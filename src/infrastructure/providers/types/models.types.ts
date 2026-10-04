import { z } from 'zod';

export const ModelInfoSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  owned_by: z.string(),
  endpoints: z.array(z.string()),
  cost_type: z.enum(['per_token', 'fixed']),
  base_cost: z.number(),
  multiplier: z.number(),
  supports_streaming: z.boolean(),
  supports_tool_calling: z.boolean()
});

export const ModelsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(ModelInfoSchema)
});

export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;