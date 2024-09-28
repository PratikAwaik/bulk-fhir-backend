export const CLIENT_ID = process.env.EPIC_CLIENT_ID!;
export const EPIC_TOKEN_ENDPOINT =
  "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token";
export const FHIR_BASE_URL =
  "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4";
export const GROUP_ID = "e3iabhmS8rsueyz7vaimuiaSmfGvi.QwjVXJANlPOgR83";

export const RESOURCE_TYPE_KEY_MAPPING = {
  Patient: "patients",
  Observation: "observations",
} as const;
