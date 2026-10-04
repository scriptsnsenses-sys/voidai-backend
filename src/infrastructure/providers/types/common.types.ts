import { z } from 'zod';

export const AuthenticatedUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.string(),
  credits: z.number(),
  enabled: z.boolean(),
  isMasterAdmin: z.boolean().optional(),
  isAnonymous: z.boolean().optional(),
  isRPVerified: z.boolean().optional(),
  rpBonusTokensExpires: z.number().optional()
});

export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;