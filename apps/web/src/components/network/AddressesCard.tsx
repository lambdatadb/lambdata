import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { NetworkStatus, NetworkStatusResponse, UpdatePublicUrlsRequest } from "@lambdata/shared";
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  ListInput,
  toast,
} from "../ui";
import { Code } from "./parts";
import { api } from "../../lib/api";
import { useNetworkMutation } from "./model";
import { Refusal } from "./parts";

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function originProblem(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an http:// or https:// address.";
    if (url.pathname !== "/" || url.search || url.hash) return "Enter the origin only, without a path.";
    return null;
  } catch {
    return "Enter a full address such as https://db.example.com.";
  }
}

export function AddressesCard({ status, isAdmin }: { status: NetworkStatus; isAdmin: boolean }) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [proxies, setProxies] = useState<string[] | null>(null);
  const currentUrls = urls ?? status.publicUrls;
  const currentProxies = proxies ?? status.trustedProxies;
  const dirty = !same(currentUrls, status.publicUrls) || !same(currentProxies, status.trustedProxies);
  const save = useNetworkMutation((body: UpdatePublicUrlsRequest) => api.put<NetworkStatusResponse>("/network/public-urls", body));
  const showProxies = status.cloudflare.tunnel.mode === "external" || status.trustedProxies.length > 0;
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const proxiesField = (
    <Field
      label="Trusted proxies"
      hint={
        <>
          A trusted proxy forwards requests for others, such as a reverse proxy or a cloudflared running elsewhere; LambData believes
          the client address it passes on only from the addresses listed here. With <Code>LAMBDATA_TRUST_LOOPBACK=0</Code>, list{" "}
          <Code>127.0.0.1</Code> for a proxy on this machine.
        </>
      }
    >
      <ListInput
        values={currentProxies}
        onChange={(v) => {
          save.reset();
          setProxies(v);
        }}
        placeholder={currentProxies.length ? "Another address or range" : "172.18.0.5"}
        addLabel="Add address"
        disabled={!isAdmin}
        emptyText="Only this server itself. That covers a tunnel managed here and Tailscale Serve."
      />
    </Field>
  );

  return (
    <Card flush>
      <CardHeader
        divided
        title={showProxies ? "Public URLs and trusted proxies" : "Public URLs"}
        description={
          showProxies
            ? "Where the console is published, and which machines may forward requests on behalf of others."
            : "Where the console is published."
        }
      />
      <CardContent className="space-y-6">
        <Field label="Public URLs" hint="Origins only, without a path. They are allowed to call the API from a browser.">
          <ListInput
            values={currentUrls}
            onChange={(v) => {
              save.reset();
              setUrls(v);
            }}
            placeholder={currentUrls.length ? "https://another.example.com" : "https://db.example.com"}
            addLabel="Add URL"
            disabled={!isAdmin}
            emptyText="None yet."
            validate={originProblem}
            normalize={(v) => v.trim().replace(/\/+$/, "")}
          />
        </Field>
        {showProxies ? (
          proxiesField
        ) : (
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="-ml-2" aria-expanded={advancedOpen}>
                <ChevronDown aria-hidden className={advancedOpen ? "rotate-180 transition-transform" : "transition-transform"} />
                Advanced: trusted proxies
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-3">{proxiesField}</div>
            </CollapsibleContent>
          </Collapsible>
        )}
        <Refusal error={save.error} onDismiss={save.reset} />
      </CardContent>
      {isAdmin && (
        <CardFooter>
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => {
                setUrls(null);
                setProxies(null);
                save.reset();
              }}
            >
              Discard
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { publicUrls: currentUrls, trustedProxies: currentProxies },
                {
                  onSuccess: () => {
                    setUrls(null);
                    setProxies(null);
                    toast.success("Addresses saved");
                  },
                },
              )
            }
          >
            Save addresses
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
