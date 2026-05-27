import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Guards endpoints called by other microservices (e.g., AI agent).
 * Requires a shared secret in the `x-service-secret` header.
 */
@Injectable()
export class InternalGuard implements CanActivate {
  private readonly logger = new Logger(InternalGuard.name);
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('INTERNAL_SERVICE_SECRET', 'internal-secret');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const provided = req.headers['x-service-secret'];
    if (!provided || provided !== this.secret) {
      this.logger.warn(`Rejected internal call from ${req.ip}`);
      throw new UnauthorizedException('Invalid internal service secret');
    }
    return true;
  }
}
