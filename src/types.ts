// https://fhir.epic.com/Documentation?docId=oauth2&section=Backend-Oauth2_Creating-JWT
export interface JWTPayload {
  iss: string;
  sub: string;
  aud: string;
  jti: string;
  exp: number;
  nbf?: number;
  iat?: number;
}
