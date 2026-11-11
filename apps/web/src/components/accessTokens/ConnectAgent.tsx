import { useState } from "react";
import { CodeBlock } from "../ui/CodeBlock";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/Tabs";
import { MCP_SERVER_NAME, TOKEN_PLACEHOLDER, connectSnippets } from "../../lib/accessTokens";

export type ConnectTab = "claude" | "json" | "curl" | "instructions";

export function ConnectAgent({ origin, secret, initialTab = "claude" }: { origin: string; secret: string | null; initialTab?: ConnectTab }) {
  const [tab, setTab] = useState<ConnectTab>(initialTab);
  const s = connectSnippets(origin, secret);
  const placeholder = secret === null;

  return (
    <section aria-labelledby="connect-agent-title" className="space-y-3" data-connect-agent={placeholder ? "placeholder" : "secret"}>
      <div className="space-y-0.5">
        <h3 id="connect-agent-title" className="text-heading font-semibold text-text">
          Connect an agent
        </h3>
        <p className="text-label text-text-muted">
          The MCP endpoint is <span className="font-mono text-code text-text">{s.mcpUrl}</span>.
          {placeholder && (
            <>
              {" "}
              Replace <span className="font-mono text-code text-text">{TOKEN_PLACEHOLDER}</span> with the secret you saved when the token was
              created.
            </>
          )}
        </p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as ConnectTab)} className="gap-3">
        <TabsList variant="pills" aria-label="How to connect">
          <TabsTrigger value="claude">Claude Code</TabsTrigger>
          <TabsTrigger value="json">Other MCP clients</TabsTrigger>
          <TabsTrigger value="curl">curl</TabsTrigger>
          <TabsTrigger value="instructions">Agent instructions</TabsTrigger>
        </TabsList>
        <TabsContent value="claude" className="space-y-2">
          <p className="text-label text-text-muted">Run this in a terminal. It adds LambData for you in the current project.</p>
          <CodeBlock code={s.claudeCode} language="shell" title="Claude Code" wrap wrapToggle={false} />
          <p className="text-micro text-text-subtle">
            Add <span className="font-mono">--scope user</span> to use it in every project. Avoid{" "}
            <span className="font-mono">--scope project</span>: it writes the token into <span className="font-mono">.mcp.json</span>, which is
            usually committed. Check it with <span className="font-mono">claude mcp get {MCP_SERVER_NAME}</span>.
          </p>
        </TabsContent>
        <TabsContent value="json" className="space-y-2">
          <p className="text-label text-text-muted">For MCP clients that read a JSON configuration with HTTP servers and headers.</p>
          <CodeBlock code={s.mcpJson} language="json" title="MCP configuration" wrap wrapToggle={false} />
        </TabsContent>
        <TabsContent value="curl" className="space-y-2">
          <p className="text-label text-text-muted">Checks that the token works and shows what it may do. Scripts use the same header.</p>
          <CodeBlock code={s.curl} language="shell" title="curl" wrap wrapToggle={false} />
        </TabsContent>
        <TabsContent value="instructions" className="space-y-2">
          <p className="text-label text-text-muted">
            Paste this into the project's agent instructions file, such as <span className="font-mono">CLAUDE.md</span> or{" "}
            <span className="font-mono">AGENTS.md</span>. It contains no secret.
          </p>
          <CodeBlock code={s.instructions} language="markdown" title="Agent instructions" wrap wrapToggle={false} maxHeight={280} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
