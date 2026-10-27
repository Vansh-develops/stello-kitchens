import { SetMetadata } from "@nestjs/common";

/**
 * Opt a controller/route into tenant API-key authentication. API keys are
 * refused everywhere else, so the public API surface stays explicit (and
 * routes that write user-attributed rows never see a non-user principal).
 */
export const API_KEY_ACCESS = "apiKeyAccess";
export const ApiKeyAccess = () => SetMetadata(API_KEY_ACCESS, true);
