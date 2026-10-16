import "reflect-metadata";
import {
  Body,
  Catch,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FinanceService } from "../../application/finance.service";
import { QueriesService } from "../../application/queries.service";
import { ApplicationError, sqlState, uuid } from "../../application/contracts";
import { SqsGateway } from "../messaging/sqs";
import { registry } from "../../application/metrics/wagering.metrics";

interface Request {
  correlationId: string;
  headers: Record<string, string | undefined>;
  url: string;
}
interface Response {
  status(code: number): Response;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  type(type: string): Response;
  send(body: string): void;
}

@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  // Extension point for OIDC/JWKS verification. Auth is intentionally omitted; see ARCHITECTURE.md.
  canActivate(): boolean {
    return true;
  }
}

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    const state = sqlState(error) || "";
    const transient =
      /^(08|40|53|57)/.test(state) ||
      ["55P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(state);
    const status =
      error instanceof ApplicationError
        ? error.status
        : error instanceof HttpException
          ? error.getStatus()
          : state === "23505"
            ? 409
            : transient
              ? 503
              : 500;
    const code =
      error instanceof ApplicationError
        ? error.code
        : error instanceof HttpException
          ? "HTTP_ERROR"
          : status === 409
            ? "CONFLICT"
            : status === 503
              ? "INFRASTRUCTURE_UNAVAILABLE"
              : "INTERNAL_ERROR";
    response
      .status(status)
      .type("application/problem+json")
      .json({
        type: `urn:jungle:error:${code}`,
        title: code,
        status,
        failureCode: code,
        instance: request.url,
        correlationId: request.correlationId,
      });
  }
}

@Controller("wallets")
@UseGuards(ProviderIdentityGuard)
class WalletController {
  constructor(
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(QueriesService) private readonly queries: QueriesService,
  ) {}

  @Post()
  create(@Body() body: unknown, @Req() request: Request) {
    return this.finance.createWallet(body, {
      correlationId: request.correlationId,
      traceparent: request.headers.traceparent,
    });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.queries.wallet(uuid(id));
  }

  @Get(":id/ledger")
  ledger(
    @Param("id") id: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.queries.ledger(uuid(id), limit, cursor);
  }

  @Post(":id/reconciliation")
  reconcile(@Param("id") id: string, @Res({ passthrough: true }) response: Response) {
    response.status(200);
    return this.queries.reconcile(uuid(id));
  }
}

@Controller("wagering/transactions")
@UseGuards(ProviderIdentityGuard)
class WagerController {
  constructor(
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(QueriesService) private readonly queries: QueriesService,
  ) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.finance.submit(body, key, {
      correlationId: request.correlationId,
      traceparent: request.headers.traceparent,
    });
    response.status(
      result.status === "PENDING_REFERENCE" ? 202 : result.status === "REJECTED" ? 422 : 200,
    );
    return result;
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.queries.transaction(uuid(id));
  }
}

@Controller("providers")
@UseGuards(ProviderIdentityGuard)
class ProviderController {
  constructor(@Inject(QueriesService) private readonly queries: QueriesService) {}

  @Get(":providerId/wagering/transactions/:externalId")
  get(@Param("providerId") provider: string, @Param("externalId") external: string) {
    return this.queries.external(provider, external);
  }
}

@Controller()
class SystemController {
  constructor(
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
  ) {}

  @Get("health/live")
  live() {
    return { status: "alive" };
  }

  @Get("health/ready")
  async ready() {
    try {
      await this.finance.db.session().query("SELECT 1");
    } catch {
      throw new ApplicationError(503, "DATABASE_UNAVAILABLE");
    }
    if (!(await this.sqs.ready())) throw new ApplicationError(503, "SQS_UNAVAILABLE");
    return { status: "ready" };
  }

  @Get("metrics")
  async metrics(@Res() response: Response) {
    response.type(registry.contentType).send(await registry.metrics());
  }
}

export async function createHttpApp(
  finance: FinanceService,
  queries: QueriesService,
  sqs: SqsGateway,
) {
  @Module({
    controllers: [WalletController, WagerController, ProviderController, SystemController],
    providers: [
      ProviderIdentityGuard,
      { provide: FinanceService, useValue: finance },
      { provide: QueriesService, useValue: queries },
      { provide: SqsGateway, useValue: sqs },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false });
  app.use((request: Request, response: Response, next: () => void) => {
    const supplied = request.headers["x-correlation-id"];
    request.correlationId =
      supplied && /^[a-zA-Z0-9_.:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
    response.setHeader("X-Correlation-Id", request.correlationId);
    next();
  });
  app.useGlobalFilters(new ErrorFilter());
  return app;
}
