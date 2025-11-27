import z from 'zod';

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const RegisterRequest = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  confirmPassword: z.string(),
  acceptedTerms: z.literal(true, { message: "Must accept Terms" }),
  acceptedPrivacy: z.literal(true, { message: "Must accept Privacy Policy" }),
  // Optional name for backward compatibility or derived
  name: z.string().optional(),
});

export const RegisterOnboardRequestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  confirmPassword: z.string().min(8),
  acceptedTerms: z.literal(true, { errorMap: () => ({ message: "Must accept Terms" }) }),
  acceptedPrivacy: z.literal(true, { errorMap: () => ({ message: "Must accept Privacy Policy" }) }),
  // Exactly one onboarding mode required:
  // Xero mode: xeroCode + xeroState (no venueName)
  // Manual mode: venueName (no xeroCode/xeroState)
  xeroCode: z.string().optional(),
  xeroState: z.string().optional(),
  venueName: z.string().min(1).optional(),
  onboardingSessionId: z.string().optional(),
}).refine(
  (data) => data.password === data.confirmPassword,
  { path: ["confirmPassword"], message: "Passwords do not match" }
).refine(
  (data) => {
    const hasXero = Boolean(data.xeroCode && data.xeroState);
    const hasManual = Boolean(data.venueName);
    // Exactly one mode: (Xero && !Manual) || (Manual && !Xero)
    return (hasXero && !hasManual) || (hasManual && !hasXero);
  },
  { message: "Provide either Xero code + state OR venue name, but not both" }
);

export const SelectOrganisationRequest = z.object({
  organisationId: z.string(),
});

export const SelectLocationRequest = z.object({
  locationId: z.string(),
});

export const RefreshTokenRequest = z.object({
  refresh_token: z.string(),
});

export const CreateOrganisationRequest = z.object({
  name: z.string().min(1),
});

export const CreateLocationRequest = z.object({
  name: z.string().min(1),
});
