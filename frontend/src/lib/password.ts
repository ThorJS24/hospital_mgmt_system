/**
 * The password policy is shared with the API (shared/passwordPolicy.ts) so the hints can never disagree with the server.
 * Reuse of recent passwords can only be checked by the server and is reported when the form is submitted.
 */
export { MAX_LENGTH, MIN_LENGTH, checkPassword as passwordChecks, passwordAcceptable, strengthOf as passwordStrength } from '../../../shared/passwordPolicy';
export type { PolicyCheck, PolicyContext, Strength } from '../../../shared/passwordPolicy';
