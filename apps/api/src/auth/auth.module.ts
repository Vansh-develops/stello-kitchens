import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordResetService } from "../account/password-reset.service";

/**
 * Resolve the JWT signing secret. In production a missing/empty JWT_SECRET is a
 * fatal misconfiguration — booting with a public default would let anyone forge
 * a token for any tenant. Fail fast instead of falling open.
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production and must not be empty");
  }
  return "dev-secret-change-me";
}

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: resolveJwtSecret(),
      signOptions: { expiresIn: "12h" },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordResetService],
  exports: [AuthService],
})
export class AuthModule {}
