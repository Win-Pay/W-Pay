import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiErrorBody } from "@wpay/types";
import { WPayError } from "@wpay/shared";

/** Normalizes every failure into the documented ApiErrorBody shape. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("exception");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof WPayError) {
      response.status(exception.statusCode).json({
        statusCode: exception.statusCode,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      } satisfies ApiErrorBody);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const body: ApiErrorBody =
        typeof payload === "string"
          ? { statusCode: status, code: defaultCode(status), message: payload }
          : {
              statusCode: status,
              code: (payload as { code?: string }).code ?? defaultCode(status),
              message:
                (payload as { message?: string | string[] }).message?.toString() ??
                exception.message,
              details: (payload as { details?: unknown }).details,
            };
      response.status(status).json(body);
      return;
    }

    // body-parser errors (oversized or unparseable bodies) are plain errors
    // carrying a 4xx status; map them instead of reporting an internal error.
    const parserStatus =
      (exception as { statusCode?: unknown }).statusCode ??
      (exception as { status?: unknown }).status;
    if (typeof parserStatus === "number" && parserStatus >= 400 && parserStatus < 500) {
      response.status(parserStatus).json({
        statusCode: parserStatus,
        code: defaultCode(parserStatus),
        message: parserStatus === 413 ? "request body too large" : "invalid request",
      } satisfies ApiErrorBody);
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack ?? exception.message : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      code: "INTERNAL",
      message: "internal server error",
    } satisfies ApiErrorBody);
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 429:
      return "RATE_LIMITED";
    default:
      return "INTERNAL";
  }
}
