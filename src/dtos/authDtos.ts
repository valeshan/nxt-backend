import z from 'zod';

const PasswordPolicy = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((v) => /[A-Z]/.test(v), {
    message: "Password must include at least 1 uppercase letter",
  })
  .refine((v) => /[^A-Za-z0-9]/.test(v), {
    message: "Password must include at least 1 special character",
  });

export const LoginRequest = z.object({
  email: z.string().trim().email(),
  password: z.string(),
});

export const RegisterRequest = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().trim().email(),
  password: PasswordPolicy,
  confirmPassword: z.string().min(8),
  acceptedTerms: z.literal(true, { message: "Must accept Terms" }),
  acceptedPrivacy: z.literal(true, { message: "Must accept Privacy Policy" }),
  // Optional name for backward compatibility or derived
  name: z.string().optional(),
}).refine((data) => data.password === data.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match",
});

export const RegisterOnboardRequestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().trim().email(),
  password: PasswordPolicy,
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
  // Segmentation fields (optional for now, will be required in future)
  industry: z.enum(['CAFE', 'RESTAURANT', 'BAR', 'BAKERY', 'RETAIL', 'HOTEL', 'CATERING', 'OTHER']).optional(),
  region: z.string().min(1).optional(),
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

export const CreateOrganisationWithLocationRequest = z.object({
  name: z.string().min(1),
  locationName: z.string().min(1),
});

export const CreateLocationRequest = z.object({
  name: z.string().min(1),
});

export const UpdateProfileRequest = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
});

export const ChangePasswordRequest = z.object({
  oldPassword: z.string().min(1, "Old password is required"),
  newPassword: PasswordPolicy,
  confirmPassword: z.string().min(8, "Confirm password must be at least 8 characters"),
}).refine((data) => data.newPassword === data.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match",
});
