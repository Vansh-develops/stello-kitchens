import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { getTenantId, isUnscoped } from "../common/tenant-context";

// Every model that carries a `tenantId` column — derived from the schema so a
// new tenant-owned model is scoped automatically.
const TENANT_MODELS = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "tenantId"))
    .map((m) => m.name),
);

// Operations whose `where` accepts arbitrary fields — inject tenantId directly.
const WHERE_SCOPED = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

/**
 * A Prisma query extension that scopes every tenant-owned query to the request's
 * tenant. `findUnique(...)` can't take a non-unique `where`, so it is verified by
 * post-filtering the row's tenantId (augmenting `select` when needed). Single
 * `update`/`delete`/`upsert` by unique key are left to the service-level scoped
 * read that precedes them (the `requireX` pattern); reads — the actual leak
 * vector — are fully covered here.
 */
function withTenantScope(base: PrismaClient) {
  return base.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          const tid = getTenantId();
          if (!tid || isUnscoped() || !TENANT_MODELS.has(model)) return query(args);

          if (WHERE_SCOPED.has(operation)) {
            return query({ ...args, where: { AND: [args?.where ?? {}, { tenantId: tid }] } });
          }

          if (operation === "findUnique" || operation === "findUniqueOrThrow") {
            const select = args?.select;
            let injectedSelect = false;
            let a = args;
            if (select && !select.tenantId) {
              a = { ...args, select: { ...select, tenantId: true } };
              injectedSelect = true;
            }
            const res = await query(a);
            if (res && res.tenantId !== tid) {
              if (operation === "findUniqueOrThrow") throw new NotFoundException("Record not found");
              return null;
            }
            if (injectedSelect && res) {
              const { tenantId: _drop, ...rest } = res;
              return rest;
            }
            return res;
          }

          if (operation === "create" && args?.data && !Array.isArray(args.data)) {
            return query({ ...args, data: { ...args.data, tenantId: tid } });
          }
          if (operation === "createMany" && args?.data) {
            const d = args.data;
            const data = Array.isArray(d)
              ? d.map((r: object) => ({ ...r, tenantId: tid }))
              : { ...d, tenantId: tid };
            return query({ ...args, data });
          }

          // update / delete / upsert by unique key: guarded by the scoped read
          // the service performs first. Injecting tenantId into a unique `where`
          // is illegal, so we intentionally pass through here.
          return query(args);
        },
      },
    },
  });
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super();
    // Returning the extended client from the constructor makes every injected
    // `PrismaService` the tenant-scoped client while keeping the lifecycle hooks.
    return withTenantScope(this) as unknown as PrismaService;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
