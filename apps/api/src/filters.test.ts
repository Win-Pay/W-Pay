import { describe, expect, it, vi } from "vitest";
import { ArgumentsHost, BadRequestException, Logger } from "@nestjs/common";
import { WPayError } from "@wpay/shared";
import { AllExceptionsFilter } from "./filters";

function hostWithResponse() {
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe("AllExceptionsFilter", () => {
  const filter = new AllExceptionsFilter();

  it("passes WPayError status, code and details through", () => {
    const { host, response } = hostWithResponse();
    filter.catch(new WPayError("CONFLICT", "already", 409, { id: 1 }), host);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 409,
      code: "CONFLICT",
      message: "already",
      details: { id: 1 },
    });
  });

  it("normalizes HttpException payloads", () => {
    const { host, response } = hostWithResponse();
    filter.catch(new BadRequestException("bad input"), host);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 400,
      code: "BAD_REQUEST",
      message: "bad input",
    });
  });

  it("maps body-parser 413 errors instead of reporting an internal error", () => {
    const { host, response } = hostWithResponse();
    const parserError = Object.assign(new Error("request entity too large"), {
      status: 413,
      type: "entity.too.large",
    });
    filter.catch(parserError, host);
    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "request body too large",
    });
  });

  it("maps body-parser 400 parse errors as invalid requests", () => {
    const { host, response } = hostWithResponse();
    filter.catch(Object.assign(new SyntaxError("bad json"), { status: 400 }), host);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 400,
      code: "BAD_REQUEST",
      message: "invalid request",
    });
  });

  it("hides unexpected errors behind a 500 envelope", () => {
    const { host, response } = hostWithResponse();
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    filter.catch(new Error("boom"), host);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      code: "INTERNAL",
      message: "internal server error",
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
