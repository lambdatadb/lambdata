import mysql from "mysql2/promise";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DataApiColumn, DataApiSchema, DataApiTable, User } from "@kilndb/shared";
import { dataApiPolicies, databases } from "../db/queries";
import { requireAuth, type AuthVariables } from "../auth/middleware";
import { withRootConnection } from "../mariadb/controller";

type OpenApiSchema = Record<string, unknown>;

type ColumnRow = {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  is_nullable: "YES" | "NO";
  data_type: string;
  column_key: string;
  column_default: string | null;
  extra: string;
  generation_expression: string | null;
};

type TableRow = {
  table_name: string;
  row_count: number | string | null;
  size_bytes: number | string | null;
};

export const dataDocsRoute = new Hono<{ Variables: AuthVariables }>();

dataDocsRoute.use("*", requireAuth);

dataDocsRoute.get("/:databaseName/schema", async (c) => {
  const schema = await loadDataApiSchema(c.req.param("databaseName"), c.get("user"), c.req.url);
  return c.json({ schema });
});

dataDocsRoute.get("/:databaseName/openapi.json", async (c) => {
  const schema = await loadDataApiSchema(c.req.param("databaseName"), c.get("user"), c.req.url);
  return c.json(generateOpenApi(schema, new URL(c.req.url).origin));
});

async function loadDataApiSchema(
  databaseName: string,
  user: User,
  requestUrl: string,
): Promise<DataApiSchema> {
  if (!safeIdent(databaseName)) {
    throw new HTTPException(400, { message: "database must be a safe identifier" });
  }
  const database = databases.byName(databaseName);
  if (!database) throw new HTTPException(404, { message: "database not found" });
  if (database.status !== "active") throw new HTTPException(409, { message: "database not active" });
  if (user.role === "db_owner" && database.ownerUserId !== user.id) {
    throw new HTTPException(403, { message: "not database owner" });
  }

  const tables = await withRootConnection(async (conn) => {
    const [tableRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT table_name AS table_name,
              COALESCE(table_rows, 0) AS row_count,
              COALESCE(data_length + index_length, 0) AS size_bytes
         FROM information_schema.tables
        WHERE table_schema = ?
          AND table_type = 'BASE TABLE'
        ORDER BY table_name ASC`,
      [database.name],
    );
    const [columnRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT table_name AS table_name,
              column_name AS column_name,
              ordinal_position AS ordinal_position,
              is_nullable AS is_nullable,
              data_type AS data_type,
              column_key AS column_key,
              column_default AS column_default,
              extra AS extra,
              generation_expression AS generation_expression
         FROM information_schema.columns
        WHERE table_schema = ?
        ORDER BY table_name ASC, ordinal_position ASC`,
      [database.name],
    );
    return buildTables(database.id, tableRows as TableRow[], columnRows as ColumnRow[]);
  });

  return {
    database,
    tables,
    openApiPath: `/api/data-docs/${database.name}/openapi.json`,
    generatedAt: Date.now(),
  };
}

function buildTables(databaseId: string, tableRows: TableRow[], columnRows: ColumnRow[]): DataApiTable[] {
  const columnsByTable = new Map<string, DataApiColumn[]>();
  const policies = new Map(dataApiPolicies.list(databaseId).map((policy) => [policy.tableName, policy]));
  for (const row of columnRows) {
    const table = String(row.table_name);
    const columns = columnsByTable.get(table) ?? [];
    columns.push({
      name: String(row.column_name),
      dataType: String(row.data_type),
      nullable: row.is_nullable === "YES",
      primary: row.column_key === "PRI",
      generated: Boolean(row.extra?.includes("auto_increment") || row.generation_expression),
      defaultValue: row.column_default,
      ordinalPosition: Number(row.ordinal_position),
    });
    columnsByTable.set(table, columns);
  }

  return tableRows.map((row) => ({
    name: String(row.table_name),
    rowCount: Number(row.row_count ?? 0),
    sizeBytes: Number(row.size_bytes ?? 0),
    columns: columnsByTable.get(String(row.table_name)) ?? [],
    policy: policies.get(String(row.table_name)) ?? null,
  }));
}

function generateOpenApi(schema: DataApiSchema, origin: string): OpenApiSchema {
  const components: Record<string, unknown> = {};
  const paths: Record<string, unknown> = {};
  for (const table of schema.tables) {
    components[componentName(table.name)] = tableObjectSchema(table, "read");
    components[`${componentName(table.name)}Insert`] = tableObjectSchema(table, "insert");
    components[`${componentName(table.name)}Patch`] = tableObjectSchema(table, "patch");
    paths[`/api/data/${schema.database.name}/${table.name}`] = tablePath(schema.database.name, table);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${schema.database.displayName} Data API`,
      version: "1.0.0",
      description:
        "Generated KilnDB Data API over managed MariaDB tables. Calls require an App Auth bearer token.",
    },
    servers: [{ url: origin }],
    security: [{ appAuthBearer: [] }],
    paths,
    components: {
      securitySchemes: {
        appAuthBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "KilnDB App Auth access token.",
        },
      },
      schemas: components,
    },
    "x-kilndb": {
      database: schema.database.name,
      generatedAt: new Date(schema.generatedAt).toISOString(),
    },
  };
}

function tablePath(databaseName: string, table: DataApiTable): OpenApiSchema {
  const tableComponent = componentName(table.name);
  const pathParams = [
    queryParam("select", "string", "Comma-separated list of columns, or *.", false),
    queryParam("order", "string", "Column order, for example id.desc.", false),
    queryParam("limit", "integer", "Maximum rows to return or affect.", false),
    queryParam("offset", "integer", "Rows to skip for GET requests.", false),
    ...table.columns.map((column) =>
      queryParam(
        column.name,
        "string",
        `PostgREST-style filter for ${column.name}: eq.value, neq.value, gt.value, gte.value, lt.value, lte.value, like.value, ilike.value, or in.(a,b).`,
        false,
      ),
    ),
  ];

  return {
    get: {
      summary: `List ${table.name} rows`,
      tags: [databaseName],
      parameters: pathParams,
      responses: {
        "200": jsonResponse({
          type: "object",
          properties: {
            data: { type: "array", items: { $ref: `#/components/schemas/${tableComponent}` } },
            count: { type: "integer" },
          },
          required: ["data", "count"],
        }),
      },
    },
    post: {
      summary: `Insert ${table.name} rows`,
      tags: [databaseName],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              oneOf: [
                { $ref: `#/components/schemas/${tableComponent}Insert` },
                {
                  type: "array",
                  maxItems: 100,
                  items: { $ref: `#/components/schemas/${tableComponent}Insert` },
                },
              ],
            },
          },
        },
      },
      responses: { "201": mutationResponse(["affectedRows", "insertId"]) },
    },
    patch: {
      summary: `Update ${table.name} rows`,
      tags: [databaseName],
      parameters: pathParams.filter((param) => param.name !== "select" && param.name !== "offset"),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${tableComponent}Patch` },
          },
        },
      },
      responses: { "200": mutationResponse(["affectedRows", "changedRows"]) },
    },
    delete: {
      summary: `Delete ${table.name} rows`,
      tags: [databaseName],
      parameters: pathParams.filter((param) => param.name !== "select" && param.name !== "offset"),
      responses: { "200": mutationResponse(["affectedRows"]) },
    },
  };
}

function tableObjectSchema(table: DataApiTable, mode: "read" | "insert" | "patch"): OpenApiSchema {
  const properties = Object.fromEntries(
    table.columns
      .filter((column) => mode !== "insert" || !column.generated)
      .map((column) => [column.name, columnSchema(column)]),
  );
  const required = mode === "insert"
    ? table.columns
      .filter((column) => !column.nullable && !column.generated && column.defaultValue == null)
      .map((column) => column.name)
    : mode === "read"
      ? table.columns.filter((column) => !column.nullable).map((column) => column.name)
      : [];

  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

function columnSchema(column: DataApiColumn): OpenApiSchema {
  const base = mariaDbTypeToJsonSchema(column.dataType);
  if (column.nullable) {
    base.type = Array.isArray(base.type) ? [...base.type, "null"] : [base.type as string, "null"];
  }
  return {
    ...base,
    description: [
      column.primary ? "Primary key." : "",
      column.generated ? "Generated by MariaDB." : "",
      `MariaDB type: ${column.dataType}.`,
    ].filter(Boolean).join(" "),
  };
}

function mariaDbTypeToJsonSchema(type: string): OpenApiSchema {
  if (["tinyint", "smallint", "mediumint", "int", "integer", "bigint"].includes(type)) {
    return { type: "integer" };
  }
  if (["decimal", "double", "float", "real"].includes(type)) {
    return { type: "number" };
  }
  if (["date"].includes(type)) {
    return { type: "string", format: "date" };
  }
  if (["datetime", "timestamp", "time"].includes(type)) {
    return { type: "string", format: "date-time" };
  }
  if (["json"].includes(type)) {
    return {};
  }
  if (["binary", "varbinary", "blob", "tinyblob", "mediumblob", "longblob"].includes(type)) {
    return { type: "string", format: "binary" };
  }
  return { type: "string" };
}

function queryParam(
  name: string,
  type: "string" | "integer",
  description: string,
  required: boolean,
): OpenApiSchema & { name: string } {
  return {
    name,
    in: "query",
    required,
    description,
    schema: { type },
  };
}

function jsonResponse(schema: OpenApiSchema): OpenApiSchema {
  return {
    description: "OK",
    content: {
      "application/json": { schema },
    },
  };
}

function mutationResponse(fields: string[]): OpenApiSchema {
  return jsonResponse({
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: Object.fromEntries(fields.map((field) => [field, { type: "integer" }])),
        required: fields,
      },
    },
    required: ["data"],
  });
}

function componentName(tableName: string): string {
  return tableName
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("") || "Table";
}

function safeIdent(value: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(value);
}
