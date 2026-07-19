import type { DatabaseCredentials } from "@kilndb/shared";
import { Button } from "../ui/Button";
import { CopyableField } from "../ui/CopyableField";
import { Icon } from "../ui/Icon";
import { useTerminology } from "../../lib/terminology";

interface Props {
  credentials: DatabaseCredentials;
  onDone: () => void;
}

export function CredentialsReveal({ credentials, onDone }: Props) {
  const t = useTerminology();
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-warn/30 bg-warn/10 text-warn px-3 py-2.5 text-xs flex items-start gap-2">
        <Icon name="warning" size={16} className="mt-0.5 shrink-0" />
        <span>
          <strong className="font-semibold">Save the password now.</strong>{" "}
          It won't be shown again — rotation issues a new one.
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <CopyableField label="Host" value={credentials.host} />
        <CopyableField label="Port" value={String(credentials.port)} />
        <CopyableField label="Schema" value={credentials.schema} />
        <CopyableField label="User" value={credentials.user} />
      </div>
      <CopyableField label="Password" value={credentials.password} />
      <CopyableField label={t("mysqlCli")} value={credentials.mysqlCli} />
      <CopyableField label={t("jdbc")} value={credentials.jdbc} />
      <CopyableField label={t("uri")} value={credentials.uri} />
      <div className="flex justify-end pt-2">
        <Button onClick={onDone}>
          <Icon name="check" size={14} />
          I've saved it
        </Button>
      </div>
    </div>
  );
}
