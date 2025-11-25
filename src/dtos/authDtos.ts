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
