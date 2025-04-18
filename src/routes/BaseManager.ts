import { ZodTypeAny, ZodType, z } from "zod";
import { StateObject } from "../StateObject";
import { JsonValue, Z2 } from "../utils";
import { DataChecks } from "../utils";
import { STREAM_ENDED } from "../streamer";
import { AllowedMethod, BodyFormat, SiteConfig } from "./router";
import { AuthUser } from "../server";
import { PasswordService } from "./services/PasswordService";

/*
You must have admin permission on a bag to add it to a recipe because it is an implicit ACL operation.
https://crates.io/crates/indradb


I'm also wondering if the system could be improved slightly by thinking of it more in terms of bag layers.

- Each layer could be writable or readonly. A tiddler from a readonly layer could not be overwritten unless there is a writable layer above it to put it in.
- Different layers could be given a more complicated set of permissions. Maybe admins can edit the template or system namespace, users can only edit their own pages in the user namespace, etc.
- Our current system is multiple readonly bag layers, with a single writable bag layer at the top.
- The simplest recipe is one writable bag layer.

Nothing should be happening to tiddlers in a bag unless they're in a writable layer of the recipe you're accessing them through.



*/



export interface ZodAction<T extends z.ZodTypeAny, R extends JsonValue> {
  (state: StateObject): Promise<typeof STREAM_ENDED>;
  zodRequest: (z: Z2<"JSON">) => T;
  zodResponse?: (z: Z2<"JSON">) => z.ZodType<R>;
  inner: (route: z.output<T>) => Promise<R>,
}

export interface ZodRoute<
  M extends AllowedMethod,
  B extends BodyFormat,
  P extends Record<string, z.ZodTypeAny>,
  T extends z.ZodTypeAny,
  R extends JsonValue
> extends ZodAction<T, R> {
  zodPathParams: (z: Z2<"STRING">) => P;
  method: M[];
  path: string;
  bodyFormat: B;
}

export class ZodState<
  M extends AllowedMethod,
  B extends BodyFormat,
  P extends Record<string, z.ZodTypeAny>,
  T extends z.ZodTypeAny
> extends StateObject<B, M, string[][], z.output<T>> {
  declare pathParams: z.output<z.ZodObject<P>>;
  // declare data: z.output<T>;
}


export type BaseManagerMap<T> = {
  [K in keyof T as T[K] extends ZodAction<any, any> ? K : never]:
  T[K] extends {
    zodRequest: (z: any) => infer REQ extends ZodTypeAny,
    zodResponse?: (z: any) => infer RES extends ZodType<JsonValue>
  } ? ((data: z.input<REQ>) => Promise<z.output<RES>>) : never;
}

export type BaseKeyMap<T, V> = {
  [K in keyof T as T[K] extends ZodAction<any, any> ? K : never]: V;
}
export interface AuthUserOrAnon extends AuthUser {
  sessionId: PrismaField<"Sessions", "session_id"> | undefined;
}
export class BaseManager {
  checks;
  constructor(
    protected config: SiteConfig,
    protected prisma: PrismaTxnClient,
    protected user: AuthUser,
    protected firstGuestUser: boolean,
    protected PasswordService: PasswordService,
  ) {

    this.checks = new DataChecks({
      allowAnonReads: config.allowAnonReads,
      allowAnonWrites: config.allowAnonWrites,
    });
  }

  /**
   * Creates a type-safe API endpoint handler with Zod validation for both request and response.
   * 
   * This method wraps an async handler function with input/output validation using Zod schemas.
   * 
   * The resulting function will:
   * 1. Validate the incoming data against the request schema
   * 2. Execute the handler with the validated data
   * 3. Validate the handler's response against the response schema
   * 4. Return the validated response or throw appropriate HTTP errors
   * 
   * If the handler throws a string, it will be sent to the client as the body of a 400 error. 
   * Otherwise this will rethrow the error and allow the server to handle it.
   * 
   * @param zodRequest Function that returns a Zod schema to validate the request
   * @param handler Async function that processes the validated input and returns a response
   * @param zodResponse Optional function that returns a Zod schema to validate the response (defaults to z.any())
   * @returns A ZodAction function with attached schema definitions
   */
  protected ZodRequest<T extends ZodTypeAny, R extends JsonValue>(
    zodRequest: (z: Z2<"JSON">) => T,
    handler: (route: z.output<T>) => Promise<R>,
    zodResponse: (z: Z2<"JSON">) => ZodType<R> = z => z.any()
  ): ZodAction<T, R> {
    // return and throw indicate whether the transaction should commit or rollback
    const action = async (state: StateObject): Promise<typeof STREAM_ENDED> => {

      const inputCheck = zodRequest(Z2).safeParse(state.data);
      if (!inputCheck.success) {
        console.log(inputCheck.error);
        throw state.sendEmpty(400, { "x-reason": "zod-request" });
      }

      const [good, error, res] = await handler(inputCheck.data)
        .then(e => [true, undefined, e] as const, e => [false, e, undefined] as const);

      if (!good) {
        if (typeof error === "string") {
          throw state.sendString(400, { "x-reason": "zod-handler" }, error, "utf8");
        } else {
          throw error;
        }
      }

      const outputCheck = zodResponse(Z2).safeParse(res);
      if (!outputCheck.success) {
        console.log(outputCheck.error);
        throw state.sendEmpty(500, { "x-reason": "zod-response" });
      }

      return state.sendJSON(200, outputCheck.data);

    };
    action.inner = handler;
    action.zodRequest = zodRequest;
    action.zodResponse = zodResponse;

    return action
  }
}
