import { Download } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CodeBlock,
  CopyableField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../ui";
import { absoluteUrl } from "../../lib/api";

const FILTERS = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in"];

interface Props {
  databaseName: string | null;
  displayName: string | null;
  tableName: string | null;
  openApiPath: string | null;
}

export function ApiReference({ databaseName, displayName, tableName, openApiPath }: Props) {
  const db = databaseName ?? "your_database";
  const table = tableName ?? "todos";
  const endpoint = absoluteUrl(`/api/data/${db}/${table}`);
  const spec = openApiPath ?? `/api/data-docs/${db}/openapi.json`;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader
          className="[&>div:first-child]:basis-64"
          title="OpenAPI 3.1"
          description={`A spec for ${displayName ?? "the selected database"}, generated from its schema on every request.`}
          action={
            databaseName ? (
              <Button asChild size="sm" variant="outline">
                <a href={spec} download={`${db}.openapi.json`}>
                  <Download aria-hidden /> Download
                </a>
              </Button>
            ) : undefined
          }
        />
        <div className="space-y-4">
          <CopyableField label="Spec URL" value={absoluteUrl(spec)} copyLabel="spec URL" />
          <p className="text-label text-text-muted">
            Fetching the spec needs a console session. Data requests use App Auth access tokens instead.
          </p>
        </div>
      </Card>
      <Card flush>
        <CardHeader title="Requests" description="Send an App Auth access token as a bearer token." />
        <CardContent className="pt-0">
          <Tabs defaultValue="curl">
            <TabsList variant="pills" aria-label="Snippet language">
              <TabsTrigger value="curl">cURL</TabsTrigger>
              <TabsTrigger value="js">JavaScript</TabsTrigger>
            </TabsList>
            <TabsContent value="curl">
              <CodeBlock code={curlExample(endpoint)} language="shell" maxHeight={260} />
            </TabsContent>
            <TabsContent value="js">
              <CodeBlock code={jsExample(endpoint)} language="javascript" maxHeight={260} />
            </TabsContent>
          </Tabs>
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-label text-text-muted">
              Filters <span className="font-mono text-text">?column=op.value</span>
            </span>
            {FILTERS.map((op) => (
              <Badge key={op} variant="muted" mono size="sm">
                {op}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function curlExample(endpoint: string): string {
  return `curl "${endpoint}?select=*&limit=100" \\
  -H "Authorization: Bearer $ACCESS_TOKEN"

curl -X POST "${endpoint}" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  --data '{"title":"Ship docs","done":false}'`;
}

function jsExample(endpoint: string): string {
  return `const headers = { Authorization: \`Bearer \${accessToken}\` };

const rows = await fetch("${endpoint}?select=*&limit=100", { headers })
  .then((res) => res.json());

await fetch("${endpoint}", {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Ship docs", done: false }),
});`;
}
